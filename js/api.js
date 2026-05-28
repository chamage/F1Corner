// =============================================
// PITCORNER — API Abstraction Layer
// Handles all OpenF1 API requests with:
//  - localStorage persistence (survives page reloads)
//  - Smart TTLs (past data cached forever, current data refreshes)
//  - Rate limiting (3 req/s, 30 req/min)
//  - Retry with exponential backoff on 429
//  - In-flight request deduplication
// =============================================

const API_BASE = 'https://api.openf1.org/v1';

// ── Cache Config ──
// Two-tier cache: fast in-memory Map + persistent localStorage
const memCache = new Map();
const LS_PREFIX = 'f1c_'; // localStorage key prefix
const LS_VERSION = 3;     // v3: invalidate stale data missing sprints

// TTLs
const TTL_IMMUTABLE = 365 * 24 * 60 * 60 * 1000; // 1 year (past race data)
const TTL_STABLE    = 24 * 60 * 60 * 1000;        // 24 hours (driver info, meetings)
const TTL_FRESH     = 10 * 60 * 1000;              // 10 min (current/live data)

// ── Rate Limiting ──
let requestQueue = Promise.resolve();
const REQUEST_DELAY = 400;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

// ── In-flight deduplication ──
const inFlight = new Map();

// ── Per-minute tracking ──
let minuteRequestCount = 0;
let minuteResetTime = Date.now() + 60000;

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── localStorage helpers ──

function lsKey(url) {
  return LS_PREFIX + 'v' + LS_VERSION + '_' + url;
}

function lsGet(url) {
  try {
    const raw = localStorage.getItem(lsKey(url));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.data) return null;
    if (Date.now() - entry.time > entry.ttl) {
      localStorage.removeItem(lsKey(url));
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

function lsSet(url, data, ttl) {
  try {
    const entry = { data, time: Date.now(), ttl };
    localStorage.setItem(lsKey(url), JSON.stringify(entry));
  } catch (e) {
    // Quota exceeded — clear old entries and retry
    if (e.name === 'QuotaExceededError') {
      clearOldCache();
      try {
        localStorage.setItem(lsKey(url), JSON.stringify({ data, time: Date.now(), ttl }));
      } catch { /* give up */ }
    }
  }
}

function clearOldCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    // Only evict API-layer cache entries, NOT compiled race data
    if (key && key.startsWith(LS_PREFIX) && !key.startsWith('f1c_compiled_race_')) {
      keys.push(key);
    }
  }
  // Remove entries with the oldest timestamps first
  const entries = keys.map(k => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return { key: k, time: v?.time || 0 };
    } catch {
      return { key: k, time: 0 };
    }
  }).sort((a, b) => a.time - b.time);

  // Remove oldest half
  const removeCount = Math.max(1, Math.floor(entries.length / 2));
  for (let i = 0; i < removeCount; i++) {
    localStorage.removeItem(entries[i].key);
  }
}

/**
 * Determine TTL for a given API URL.
 * Past race data → immutable (1 year)
 * Session/meeting lists → stable (24h)
 * Everything else → fresh (10 min)
 */
function getTTL(url) {
  // Past race laps/positions/stints/pit/overtakes (session_key is a number)
  // These are immutable once the session is over
  if (/\/(laps|position|stints|pit|overtakes|intervals|race_control|weather|session_result)\?/.test(url) &&
      /session_key=\d+/.test(url)) {
    return TTL_IMMUTABLE;
  }

  // Driver info for a specific session — stable
  if (/\/drivers\?.*session_key=\d+/.test(url)) {
    return TTL_STABLE;
  }

  // Meetings and sessions for past years
  const yearMatch = url.match(/year=(\d+)/);
  if (yearMatch) {
    const urlYear = parseInt(yearMatch[1]);
    const currentYear = new Date().getFullYear();
    if (urlYear < currentYear) {
      return TTL_IMMUTABLE; // Past seasons never change
    }
    // Current year — meetings/sessions can update
    if (/\/(meetings|sessions)\?/.test(url)) {
      return TTL_STABLE;
    }
  }

  return TTL_FRESH;
}

// ── Rate limit helpers ──

async function waitForMinuteSlot() {
  const now = Date.now();
  if (now > minuteResetTime) {
    minuteRequestCount = 0;
    minuteResetTime = now + 60000;
  }
  if (minuteRequestCount >= 28) {
    const waitMs = minuteResetTime - now + 500;
    console.log(`[API] Minute limit approaching (${minuteRequestCount}/30), waiting ${Math.round(waitMs / 1000)}s...`);
    await delay(waitMs);
    minuteRequestCount = 0;
    minuteResetTime = Date.now() + 60000;
  }
  minuteRequestCount++;
}

// ── Core fetch ──

async function fetchAPI(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const cacheKey = url.toString();

  // Tier 1: in-memory cache (instant)
  const memCached = memCache.get(cacheKey);
  if (memCached) return memCached;

  // Tier 2: localStorage cache (fast, survives reload)
  const lsCached = lsGet(cacheKey);
  if (lsCached) {
    memCache.set(cacheKey, lsCached); // promote to memory
    return lsCached;
  }

  // Tier 3: in-flight deduplication
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  // Tier 4: actual API request (queued + rate limited)
  const promise = new Promise((resolve) => {
    requestQueue = requestQueue
      .catch(() => {}) // Prevent previous rejections from breaking the queue
      .then(async () => {
        // Re-check caches (another queued request may have filled them)
        const memNow = memCache.get(cacheKey);
        if (memNow) { resolve(memNow); inFlight.delete(cacheKey); return; }
        const lsNow = lsGet(cacheKey);
        if (lsNow) {
          memCache.set(cacheKey, lsNow);
          resolve(lsNow);
          inFlight.delete(cacheKey);
          return;
        }

        await waitForMinuteSlot();

        let lastError = null;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            const response = await fetch(url.toString(), { signal: controller.signal });
            clearTimeout(timeout);

            if (response.status === 429) {
              const retryAfter = response.headers.get('Retry-After');
              const waitMs = retryAfter
                ? (parseInt(retryAfter) * 1000 || 5000)
                : RETRY_BASE_DELAY * Math.pow(2, attempt);
              console.warn(`[API] 429 on ${endpoint}, retry in ${waitMs}ms (${attempt + 1}/${MAX_RETRIES})`);
              
              // Force the entire queue to cool down
              minuteRequestCount = 28;
              minuteResetTime = Date.now() + waitMs;

              await delay(waitMs);
              continue;
            }

            if (response.status === 404) {
              const emptyData = [];
              memCache.set(cacheKey, emptyData);
              lsSet(cacheKey, emptyData, TTL_FRESH); // short TTL for 404s
              resolve(emptyData);
              inFlight.delete(cacheKey);
              return;
            }

            if (!response.ok) {
              throw new Error(`API ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            let ttl = getTTL(cacheKey);
            // If the data is empty and we expected records (e.g. race results, stints, laps),
            // do NOT cache it immutably! Instead use a short TTL so it will be retried on next load.
            if (Array.isArray(data) && data.length === 0 && ttl === TTL_IMMUTABLE) {
              console.warn(`[API] Empty response for immutable endpoint ${endpoint}, overriding to TTL_FRESH`);
              ttl = TTL_FRESH;
            }
            memCache.set(cacheKey, data);
            lsSet(cacheKey, data, ttl);
            resolve(data);
            inFlight.delete(cacheKey);
            await delay(REQUEST_DELAY);
            return;
          } catch (err) {
            lastError = err;
            console.warn(`[API] ${err.name === 'AbortError' ? 'Timeout' : err.message} on ${endpoint} (${attempt + 1}/${MAX_RETRIES})`);
            if (attempt < MAX_RETRIES - 1) {
              await delay(RETRY_BASE_DELAY * Math.pow(2, attempt));
            }
          }
        }

        console.error(`[API] All ${MAX_RETRIES} attempts failed: ${endpoint}`, lastError?.message);
        resolve([]);
        inFlight.delete(cacheKey);
        await delay(REQUEST_DELAY);
      });
  });

  inFlight.set(cacheKey, promise);
  return promise;
}

// ── Endpoint Functions ──

export async function getMeetings(year) {
  return fetchAPI('/meetings', { year });
}

export async function getSessions(params = {}) {
  return fetchAPI('/sessions', params);
}

export async function getDrivers(params = {}) {
  return fetchAPI('/drivers', params);
}

export async function getLaps(params = {}) {
  return fetchAPI('/laps', params);
}

export async function getStints(params = {}) {
  return fetchAPI('/stints', params);
}

export async function getPits(params = {}) {
  return fetchAPI('/pit', params);
}

export async function getOvertakes(params = {}) {
  return fetchAPI('/overtakes', params);
}

export async function getPositions(params = {}) {
  return fetchAPI('/position', params);
}

export async function getIntervals(params = {}) {
  return fetchAPI('/intervals', params);
}

export async function getRaceControl(params = {}) {
  return fetchAPI('/race_control', params);
}

export async function getWeather(params = {}) {
  return fetchAPI('/weather', params);
}
export async function getSessionResult(params = {}) {
  return fetchAPI('/session_result', params);
}

export async function getRaceSessions(year) {
  const sessions = await getSessions({ year, session_type: 'Race' });
  return sessions.filter(s => !s.is_cancelled);
}

export async function getQualifyingSessions(year) {
  return getSessions({ year, session_type: 'Qualifying' });
}

export async function getMeetingSessions(meetingKey) {
  return getSessions({ meeting_key: meetingKey });
}

export async function getSessionDrivers(sessionKey) {
  return getDrivers({ session_key: sessionKey });
}

export async function getLatestDrivers() {
  return getDrivers({ session_key: 'latest' });
}

// ── Finishing Order from Laps ──

export async function getFinishingOrderFromLaps(sessionKey) {
  const laps = await getLaps({ session_key: sessionKey });
  if (!laps.length) return [];

  const driverData = new Map();
  for (const lap of laps) {
    const dn = lap.driver_number;
    if (!driverData.has(dn)) {
      driverData.set(dn, { lapsCompleted: 0, totalTime: 0 });
    }
    const d = driverData.get(dn);
    if (lap.lap_number > d.lapsCompleted) {
      d.lapsCompleted = lap.lap_number;
    }
    if (lap.lap_duration) {
      d.totalTime += lap.lap_duration;
    }
  }

  const sorted = Array.from(driverData.entries())
    .map(([driver_number, data]) => ({
      driver_number,
      lapsCompleted: data.lapsCompleted,
      totalTime: data.totalTime,
    }))
    .sort((a, b) => {
      if (b.lapsCompleted !== a.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
      return a.totalTime - b.totalTime;
    });

  return sorted.map((d, i) => ({
    driver_number: d.driver_number,
    position: i + 1,
  }));
}

export async function getFinishingOrder(sessionKey) {
  try {
    const results = await getSessionResult({ session_key: sessionKey });
    if (!results || results.length === 0) {
      return getFinishingOrderFromLaps(sessionKey);
    }

    // Sort results: Finishers first (by position), DNFs/DNSs/DSQs at the end
    const sorted = [...results].sort((a, b) => {
      if (a.position === null && b.position !== null) return 1;
      if (a.position !== null && b.position === null) return -1;
      if (a.position === null && b.position === null) return 0;
      return a.position - b.position;
    });

    // Map to our standard schema: { driver_number, position, status }
    return sorted.map((r, index) => {
      let status = 'FINISHED';
      if (r.dsq) status = 'DSQ';
      else if (r.dns) status = 'DNS';
      else if (r.dnf) status = 'DNF';

      // If position is null (like DNF/DSQ/DNS), assign a sequential fallback rank at the end
      const finalPosition = r.position !== null ? r.position : (index + 1);

      return {
        driver_number: r.driver_number,
        position: finalPosition,
        status: status
      };
    });
  } catch (e) {
    console.warn(`[API] Failed to get official finishing order for ${sessionKey}:`, e);
    return getFinishingOrderFromLaps(sessionKey);
  }
}

export async function preloadYear(year) {
  const [meetings, sessions] = await Promise.all([
    getMeetings(year),
    getSessions({ year })
  ]);
  return { meetings, sessions };
}

/**
 * Clear all caches (memory + localStorage)
 */
export function clearCache() {
  memCache.clear();
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LS_PREFIX)) keys.push(key);
  }
  keys.forEach(k => localStorage.removeItem(k));
  console.log(`[API] Cleared ${keys.length} cached entries`);
}

/**
 * Clear cached entries for a single season only
 */
export function clearSingleSeasonAPICache(year) {
  memCache.clear();
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LS_PREFIX) && (key.includes(`year=${year}`) || key.includes(`year%3D${year}`))) {
      keys.push(key);
    }
  }
  keys.forEach(k => localStorage.removeItem(k));
  console.log(`[API] Cleared ${keys.length} cached entries for year ${year}`);
}

/**
 * Get cache stats for debugging
 */
export function getCacheStats() {
  let lsCount = 0, lsBytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LS_PREFIX)) {
      lsCount++;
      lsBytes += (localStorage.getItem(key) || '').length * 2; // UTF-16
    }
  }
  return {
    memory: memCache.size,
    localStorage: lsCount,
    localStorageKB: Math.round(lsBytes / 1024),
  };
}
