// =============================================
// PITCORNER — Season Data Compiler
// Fetches each race individually, compiles,
// and caches compiled output per-race in IndexedDB.
// Dynamic standings are built from individual race records.
// =============================================

import { getMeetings, getRaceSessions, getSessionDrivers, getFinishingOrder, getStints, getSessions, getLaps, safeEnrichDrivers, registerDriverNationalityFromRecord } from './api.js';
import { isPast, getPointsForPosition } from './utils.js';
import { dbGet, dbSet, dbDelete, dbClear, dbGetAllKeys, dbGetMultiple } from './db.js';

const LS_RACE_PREFIX = 'f1c_compiled_race_';
const LS_RACE_VERSION = 29; // Bump race cache to v29 for dynamic API/grid resolution of reserve drivers with null team_name
const LS_QUALI_VERSION = 24; // Bump quali cache to v24 for enriched reserve driver team & nationality metadata

function hasUnresolvedSessionTeam(compiled) {
  // Only re-check recent sessions (OpenF1/Ergast may still backfill); older ones are accepted as-is
  // to avoid endlessly re-fetching sessions that genuinely have unresolvable entries.
  if (!compiled || !Array.isArray(compiled.drivers)) return false;
  const endedAgo = Date.now() - new Date(compiled.date_end || 0).getTime();
  if (!(endedAgo < 7 * 24 * 60 * 60 * 1000)) return false;
  return compiled.drivers.some(d => !d || !d.team_name || d.team_name === 'Unknown');
}

function upsertSeasonDriver(driversMap, d) {
  if (!d || !d.name_acronym) return;
  registerDriverNationalityFromRecord(d);
  const prev = driversMap.get(d.name_acronym);
  if (!prev) {
    driversMap.set(d.name_acronym, { ...d });
    return;
  }
  driversMap.set(d.name_acronym, {
    ...prev,
    ...d,
    team_name: (d.team_name && d.team_name !== 'Unknown') ? d.team_name : (prev.team_name || d.team_name),
    team_colour: (d.team_colour && d.team_colour !== '666666') ? d.team_colour : (prev.team_colour || d.team_colour),
    headshot_url: d.headshot_url || prev.headshot_url || null,
    country_code: d.country_code || prev.country_code || null,
    full_name: d.full_name || prev.full_name,
    first_name: d.first_name || prev.first_name,
    last_name: d.last_name || prev.last_name,
  });
}

// In-memory cache
let seasonCache = new Map(); // year -> compiled season data
let raceCache = new Map();   // session_key -> compiled race data
let seasonPromises = new Map(); // year -> Promise of compiled season data
const runningBackgroundLoads = new Set();

// ── IndexedDB helpers ──

function lsRaceKey(sessionKey, isQuali = false) {
  const version = isQuali ? LS_QUALI_VERSION : LS_RACE_VERSION;
  return `${LS_RACE_PREFIX}v${version}_${sessionKey}`;
}

async function loadRaceFromStorage(sessionKey, isQuali = false) {
  try {
    const key = lsRaceKey(sessionKey, isQuali);
    const compiled = await dbGet('compiled_races', key);
    if (!compiled) return null;

    // Invalidation check for retro seasons to ensure they have the new 'points' field:
    // If the session is a retro season race/sprint, and the results do not have 'points' mapped,
    // invalidate it (return null) to force a fast offline re-compile from bulk Ergast data.
    if (compiled && !isQuali && !compiled.is_incomplete) {
      const [year] = sessionKey.split('_');
      if (parseInt(year) <= 2022) {
        const hasPoints = compiled.results && compiled.results.length > 0 && compiled.results[0].points !== undefined;
        if (!hasPoints) {
          await dbDelete('compiled_races', key);
          return null;
        }
      }
    }

    // Auto-expiration for recent races:
    // If the session ended less than 24 hours ago, expire it after 15 minutes to allow post-race penalty/disqualification updates.
    if (compiled && compiled.date_end) {
      const timeSinceEnd = Date.now() - new Date(compiled.date_end).getTime();
      const oneDay = 24 * 60 * 60 * 1000;
      if (timeSinceEnd > 0 && timeSinceEnd < oneDay) {
        const timeSinceCompiled = Date.now() - (compiled.compiledAt || 0);
        if (timeSinceCompiled > 15 * 60 * 1000) {
          console.log(`[Season] 🔄 Expiring cache for recent session ${sessionKey} (compiled ${Math.round(timeSinceCompiled / 60000)} mins ago) to check for penalty updates`);
          await dbDelete('compiled_races', key);
          return null;
        }
      }
    }

    if (compiled && hasUnresolvedSessionTeam(compiled)) {
      if (Date.now() - (compiled.compiledAt || 0) > 15 * 60 * 1000) {
        await dbDelete('compiled_races', key);
        return null;
      }
    }

    if (compiled && compiled.is_incomplete) {
      // Expire incomplete placeholders after 30 minutes to check for new data
      if (Date.now() - (compiled.compiledAt || 0) > 30 * 60 * 1000) {
        await dbDelete('compiled_races', key);
        return null;
      }
    }
    return compiled;
  } catch {
    return null;
  }
}

async function saveRaceToStorage(sessionKey, raceData, isQuali = false) {
  try {
    const key = lsRaceKey(sessionKey, isQuali);
    // Ensure compiledAt is set to track expiration
    if (raceData) {
      raceData.compiledAt = raceData.compiledAt || Date.now();
    }
    await dbSet('compiled_races', key, raceData);
  } catch (e) {
    console.warn(`[Season] Failed to save compiled race ${sessionKey} to IndexedDB:`, e);
  }
}

/**
 * Compute finishing order from lap data. (kept for fallback)
 */
function computeOrderFromLaps(laps) {
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

  return Array.from(driverData.entries())
    .map(([driver_number, data]) => ({
      driver_number,
      lapsCompleted: data.lapsCompleted,
      totalTime: data.totalTime,
    }))
    .sort((a, b) => {
      if (b.lapsCompleted !== a.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
      return a.totalTime - b.totalTime;
    })
    .map((d, i) => ({
      driver_number: d.driver_number,
      position: i + 1,
    }));
}

/**
 * Get compiled season data for a year.
 * Fetches the race list, then loads/compiles each race individually.
 * Zero-corruption standings: a single failed race fetch doesn't block others or corrupt the cache.
 */
export function getSeasonData(year) {
  // Check in-memory season cache
  if (seasonCache.has(year)) {
    const cached = seasonCache.get(year);
    // Quick validation: does the number of compiled races match current completed sessions?
    const cachedTotal = (cached.totalRaceSessions || []).filter(s => isPast(s.date_end)).length;
    if (cachedTotal === cached.races.length) {
      console.log(`[Season] ✅ ${year} served from in-memory season cache (${cached.races.length} races)`);
      return Promise.resolve(cached);
    }
  }

  // Deduplicate concurrent calls by returning the existing in-flight promise
  if (seasonPromises.has(year)) {
    return seasonPromises.get(year);
  }

  const promise = (async () => {
    const t0 = performance.now();
    console.log(`[Season] Loading season ${year}...`);

    try {
      // Eagerly check if we have a fully compiled season cached in IndexedDB
      const seasonKey = `season_compiled_${year}`;
      const dbSeasonPromise = dbGet('compiled_races', seasonKey);

      // Parallelize session and calendar meeting list fetching
      const sessionsPromise = Promise.all([
        getRaceSessions(year),
        getSessions({ year, session_name: 'Sprint' }),
        getSessions({ year, session_type: 'Qualifying' }),
        getMeetings(year).catch(() => [])
      ]);

      const [cachedSeason, [gpSessions, sprintSessions, qualifyingSessions, meetings]] = await Promise.all([
        dbSeasonPromise,
        sessionsPromise
      ]);

      // Synthesize upcoming GP session entries for future meetings whose session schedule isn't published yet
      const gpMeetings = (meetings || []).filter(m =>
        m.meeting_name && m.meeting_name.includes('Grand Prix') && !m.is_cancelled
      );
      const existingGpMeetingKeys = new Set(gpSessions.map(s => String(s.meeting_key)));
      const fallbackUpcomingGps = [];
      for (const m of gpMeetings) {
        if (!existingGpMeetingKeys.has(String(m.meeting_key)) && !isPast(m.date_end)) {
          fallbackUpcomingGps.push({
            session_key: `upcoming_race_${m.meeting_key}`,
            session_name: 'Race',
            session_type: 'Race',
            meeting_key: m.meeting_key,
            circuit_short_name: m.circuit_short_name || m.location || m.meeting_name.replace(' Grand Prix', ''),
            date_start: m.date_start,
            date_end: m.date_end,
            is_fallback: true
          });
        }
      }

      const activeSprints = sprintSessions.filter(s => !s.is_cancelled);
      const allRaceSessions = [...gpSessions, ...fallbackUpcomingGps, ...activeSprints];
      const completedSessions = allRaceSessions.filter(s => !s.is_fallback && isPast(s.date_end));
      
      // Load qualifying sessions list
      const activeQuali = qualifyingSessions.filter(s => !s.is_cancelled);
      const completedQuali = activeQuali.filter(s => isPast(s.date_end));

      // Validate single-key cache
      if (cachedSeason) {
        const completedRaceCount = completedSessions.length;
        const completedQualiCount = completedQuali.length;
        const totalSessionCountMatches = (cachedSeason.totalRaceSessions || []).length === allRaceSessions.length;

        if (cachedSeason.version === LS_RACE_VERSION && totalSessionCountMatches && cachedSeason.races.length === completedRaceCount && cachedSeason.qualifying.length === completedQualiCount) {
          const hasIncomplete = cachedSeason.races.some(r => r.is_incomplete || hasUnresolvedSessionTeam(r))
            || cachedSeason.qualifying.some(q => q.is_incomplete || hasUnresolvedSessionTeam(q));
          
          let hasRecentSession = false;
          const oneDay = 24 * 60 * 60 * 1000;
          for (const s of [...cachedSeason.races, ...cachedSeason.qualifying]) {
            if (s.date_end) {
              const timeSinceEnd = Date.now() - new Date(s.date_end).getTime();
              if (timeSinceEnd > 0 && timeSinceEnd < oneDay) {
                hasRecentSession = true;
                break;
              }
            }
          }

          if (!hasIncomplete && !hasRecentSession) {
            // Re-construct drivers Map
            const driversMap = new Map();
            if (cachedSeason.drivers) {
              if (cachedSeason.drivers instanceof Map) {
                cachedSeason.drivers.forEach((v, k) => driversMap.set(k, v));
              } else if (Array.isArray(cachedSeason.drivers)) {
                for (const [k, v] of cachedSeason.drivers) {
                  driversMap.set(k, v);
                }
              } else {
                for (const [k, v] of Object.entries(cachedSeason.drivers)) {
                  driversMap.set(k, v);
                }
              }
            }
            for (const d of driversMap.values()) {
              registerDriverNationalityFromRecord(d);
            }
            cachedSeason.drivers = driversMap;

            // Warm up in-memory race cache
            for (const race of cachedSeason.races) {
              raceCache.set(race.session_key, race);
            }
            for (const quali of cachedSeason.qualifying) {
              raceCache.set(quali.session_key, quali);
            }

            seasonCache.set(year, cachedSeason);
            console.log(`[Season] ✅ ${year} served from compiled season IDB cache (1 read, ${(performance.now() - t0).toFixed(0)}ms)`);
            return cachedSeason;
          }
        }
      }

      console.log(`[Season] Single-key cache miss or outdated for ${year}. Querying multi-keys...`);
      console.log(`[Season] ${completedSessions.length} completed sessions and ${completedQuali.length} completed qualifying sessions to process (${(performance.now() - t0).toFixed(0)}ms for session list)`);

      const races = [];
      const qualifying = [];
      const drivers = new Map();
      let cacheHits = 0;

      // Identify sessions that need db loading
      const missingRaceSessions = completedSessions.filter(s => !raceCache.has(s.session_key));
      const missingQualiSessions = completedQuali.filter(s => !raceCache.has(s.session_key));

      const raceKeys = missingRaceSessions.map(s => lsRaceKey(s.session_key, false));
      const qualiKeys = missingQualiSessions.map(s => lsRaceKey(s.session_key, true));
      const allKeys = [...raceKeys, ...qualiKeys];

      const dbResults = allKeys.length > 0 
        ? await dbGetMultiple('compiled_races', allKeys) 
        : new Map();

      // Populate raceCache from the database results
      for (const session of missingRaceSessions) {
        const key = lsRaceKey(session.session_key, false);
        const compiled = dbResults.get(key);
        if (compiled) {
          // Invalidation check for retro seasons to ensure they have the new 'points' field
          let isValid = true;
          if (!compiled.is_incomplete && parseInt(year) <= 2022) {
            const hasPoints = compiled.results && compiled.results.length > 0 && compiled.results[0].points !== undefined;
            if (!hasPoints) {
              await dbDelete('compiled_races', key);
              isValid = false;
            }
          }
          if ((compiled.is_incomplete && Date.now() - (compiled.compiledAt || 0) > 30 * 60 * 1000) ||
              (hasUnresolvedSessionTeam(compiled) && Date.now() - (compiled.compiledAt || 0) > 15 * 60 * 1000)) {
            await dbDelete('compiled_races', key);
            isValid = false;
          }
          if (isValid) {
            raceCache.set(session.session_key, compiled);
          }
        }
      }

      for (const session of missingQualiSessions) {
        const key = lsRaceKey(session.session_key, true);
        const compiled = dbResults.get(key);
        if (compiled) {
          let isValid = true;
          if ((compiled.is_incomplete && Date.now() - (compiled.compiledAt || 0) > 30 * 60 * 1000) ||
              (hasUnresolvedSessionTeam(compiled) && Date.now() - (compiled.compiledAt || 0) > 15 * 60 * 1000)) {
            await dbDelete('compiled_races', key);
            isValid = false;
          }
          if (isValid) {
            raceCache.set(session.session_key, compiled);
          }
        }
      }

      const missingSessions = [];
      const missingQuali = [];

      // Check race sessions cache
      for (const session of completedSessions) {
        const compiledRace = raceCache.get(session.session_key);
        if (compiledRace && !compiledRace.is_incomplete) {
          races.push(compiledRace);
          cacheHits++;
        } else {
          missingSessions.push(session);
        }
      }

      // Check qualifying sessions cache
      for (const session of completedQuali) {
        const compiledQuali = raceCache.get(session.session_key);
        if (compiledQuali && !compiledQuali.is_incomplete) {
          qualifying.push(compiledQuali);
          cacheHits++;
        } else {
          missingQuali.push(session);
        }
      }

      const hasMissing = missingSessions.length > 0 || missingQuali.length > 0;

      if (hasMissing) {
        // Start background fetching of missing sessions asynchronously
        startBackgroundLoad(year, missingSessions, missingQuali, allRaceSessions, completedSessions, completedQuali);
      }

      races.sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
      qualifying.sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

      for (const quali of qualifying) {
        if (quali.drivers) {
          for (const d of quali.drivers) {
            upsertSeasonDriver(drivers, d);
          }
        }
      }
      for (const race of races) {
        if (race.drivers) {
          for (const d of race.drivers) {
            upsertSeasonDriver(drivers, d);
          }
        }
      }

      const finalSeason = {
        year,
        compiledAt: Date.now(),
        races,
        qualifying,
        drivers,
        totalRaceSessions: allRaceSessions,
        is_preliminary: hasMissing,
        is_fetching_background: hasMissing
      };

      seasonCache.set(year, finalSeason);
      console.log(`[Season] ✅ ${year} returned (preliminary=${hasMissing}) in ${(performance.now() - t0).toFixed(0)}ms — ${cacheHits} cache hits, ${missingSessions.length + missingQuali.length} background fetches queued`);

      // Cache the complete compiled season under a single key in IndexedDB for fast lookup next time
      if (!hasMissing) {
        try {
          const serialized = {
            ...finalSeason,
            version: LS_RACE_VERSION,
            drivers: Array.from(finalSeason.drivers.entries())
          };
          await dbSet('compiled_races', `season_compiled_${year}`, serialized);
          console.log(`[Season] Saved compiled season ${year} to IndexedDB`);
        } catch (e) {
          console.warn(`[Season] Failed to save compiled season ${year} to IndexedDB:`, e);
        }
      }

      return finalSeason;
    } finally {
      // Remove promise from tracker when complete
      seasonPromises.delete(year);
    }
  })();

  seasonPromises.set(year, promise);
  return promise;
}

/**
 * Check if the loaded season in-memory data is a preliminary/partial load.
 */
export function isSeasonPreliminary(year) {
  if (seasonCache.has(year)) {
    return !!seasonCache.get(year).is_preliminary;
  }
  return false;
}

/**
 * Fetch data for a single qualifying session and return compiled finishing positions.
 */
async function fetchQualiData(session) {
  try {
    const [results, rawSessionDrivers] = await Promise.all([
      getFinishingOrder(session.session_key),
      getSessionDrivers(session.session_key).catch(() => [])
    ]);

    if (!results || results.length === 0) {
      throw new Error('Empty qualifying results fetched');
    }

    const sessionDrivers = await safeEnrichDrivers(rawSessionDrivers, session.session_key, results, session);
    const updatedResults = [...results];
    const resultsDrivers = new Set(results.map(r => r.driver_number));

    let nextPos = results.length + 1;
    for (const d of sessionDrivers) {
      const dn = d.driver_number;
      if (!resultsDrivers.has(dn)) {
        updatedResults.push({
          driver_number: dn,
          position: nextPos++,
          status: 'DNS'
        });
      }
    }

    return {
      session_key: session.session_key,
      session_name: session.session_name,
      meeting_key: session.meeting_key,
      circuit_short_name: session.circuit_short_name,
      date_end: session.date_end,
      results: updatedResults,
      drivers: sessionDrivers
    };
  } catch (e) {
    console.warn(`[Season] Failed to fetch qualifying ${session.session_key}:`, e.message);
    return null;
  }
}

/**
 * Fetch data for a single race session and return compiled results.
 * Throws an error on empty responses to prevent corrupting the local cache.
 */
async function fetchRaceData(session) {
  try {
    const [rawSessionDrivers, results, stints, laps] = await Promise.all([
      getSessionDrivers(session.session_key).catch(() => []),
      getFinishingOrder(session.session_key),
      getStints({ session_key: session.session_key }),
      getLaps({ session_key: session.session_key }).catch(() => [])
    ]);

    if (!results.length) {
      throw new Error(`Empty results (${results.length}) fetched`);
    }

    const sessionDrivers = await safeEnrichDrivers(rawSessionDrivers, session.session_key, results, session);
    if (!sessionDrivers.length) {
      throw new Error(`Empty drivers (${sessionDrivers.length}) fetched`);
    }

    // Calculate completed laps per driver from tyre stints (extremely lightweight!)
    const lapsByDriver = new Map();
    if (stints && stints.length > 0) {
      for (const s of stints) {
        const dn = s.driver_number;
        const lapEnd = s.lap_end || 0;
        lapsByDriver.set(dn, Math.max(lapsByDriver.get(dn) || 0, lapEnd));
      }
    }

    const maxLaps = stints && stints.length > 0 
      ? Math.max(...stints.map(s => s.lap_end || 0).filter(n => !isNaN(n)), 1) 
      : 1;

    // Map existing sorted results
    const resultsDrivers = new Set(results.map(r => r.driver_number));
    const updatedResults = results.map(r => {
      const dn = r.driver_number;
      const lapsCompleted = lapsByDriver.get(dn) || 0;

      // Respect the official classified status (DSQ / DNS / DNF) from session result if present
      let status = r.status || 'FINISHED';

      if (stints && stints.length > 0 && status === 'FINISHED') {
        if (lapsCompleted <= 1) { // Laps <= 1 is a DNS
          status = 'DNS';
        } else if (lapsCompleted <= maxLaps - 5) {
          status = 'DNF';
        }
      }

      const finalPoints = r.points !== undefined
        ? r.points
        : ((status === 'DNS' || status === 'DSQ' || r.unclassified) ? 0 : undefined);

      return {
        driver_number: dn,
        position: r.position,
        status: status,
        points: finalPoints,
        ...(r.unclassified ? { unclassified: true } : {})
      };
    });

    // Count already-classified cars per constructor so replaced Friday/weekend drivers
    // (when a constructor already fielded 2 race cars in results) are not added as a 3rd-car DNS
    const driverInfoByNum = new Map(sessionDrivers.map(d => [d.driver_number, d]));
    const classifiedTeamCounts = new Map();
    for (const r of results) {
      const dInfo = driverInfoByNum.get(r.driver_number);
      const tName = dInfo?.team_name;
      if (tName) {
        classifiedTeamCounts.set(tName, (classifiedTeamCounts.get(tName) || 0) + 1);
      }
    }

    // Append session entered drivers who are completely missing from results (DNS / DSQ)
    let nextPos = results.length + 1;
    for (const d of sessionDrivers) {
      const dn = d.driver_number;
      if (!resultsDrivers.has(dn)) {
        const lapsCompleted = lapsByDriver.get(dn) || 0;
        if (lapsCompleted === 0 && d.team_name && (classifiedTeamCounts.get(d.team_name) || 0) >= 2) {
          continue; // Driver withdrew/FP1-only and constructor already ran 2 cars in the race
        }
        let status = 'DNS';
        if (stints && stints.length > 0 && lapsCompleted > 1) {
          status = 'DSQ'; // Has stints/laps but missing from final position results = DSQ
        }

        updatedResults.push({
          driver_number: dn,
          position: nextPos++,
          status: status,
          points: 0
        });
      }
    }

    const activeResultNums = new Set(updatedResults.map(r => r.driver_number));
    const filteredSessionDrivers = sessionDrivers.filter(d => activeResultNums.has(d.driver_number));

    let fastestLapDriver = null;
    let fastestLapTime = null;
    let minLapTime = Infinity;
    if (laps && laps.length > 0) {
      for (const lap of laps) {
        if (lap.lap_duration && lap.lap_duration > 0 && lap.lap_duration < minLapTime) {
          minLapTime = lap.lap_duration;
          fastestLapDriver = lap.driver_number;
          fastestLapTime = lap.lap_duration;
        }
      }
    }

    return {
      session_key: session.session_key,
      session_name: session.session_name,
      meeting_key: session.meeting_key,
      circuit_short_name: session.circuit_short_name,
      date_end: session.date_end,
      results: updatedResults,
      fastest_lap_driver: fastestLapDriver,
      fastest_lap_time: fastestLapTime,
      drivers: filteredSessionDrivers.length > 0 ? filteredSessionDrivers : sessionDrivers,
    };
  } catch (e) {
    console.warn(`[Season] Failed to fetch race ${session.session_key}:`, e.message);
    return null;
  }
}

/**
 * Get the finishing order for a specific session from compiled data.
 */
export function getResultsForSession(seasonData, sessionKey) {
  const race = seasonData.races.find(r => r.session_key === sessionKey);
  if (race) return race.results;
  // Also check qualifying sessions
  if (seasonData.qualifying) {
    const quali = seasonData.qualifying.find(q => q.session_key === sessionKey);
    if (quali) return quali.results;
  }
  return [];
}

/**
 * Helper to initialize empty driver statistics object including Q3/Quali metrics.
 */
function initDriverStats() {
  return {
    points: 0,
    wins: 0,
    podiums: 0,
    dnfs: 0,
    dnss: 0,
    dsqs: 0,
    raceResults: [],
    allResults: [],
    pointsHistory: [],
    sprintPoints: 0,
    sprintWins: 0,
    sprintPodiums: 0,
    sprintDnfs: 0,
    sprintResults: [],
    q3Appearances: 0,
    qualiResults: [],
    sprintQ3Appearances: 0,
    sprintQualiResults: [],
    teamStintsMap: new Map(),
    latestTeamName: null,
    latestTeamColour: null,
    hasParticipation: false
  };
}

const PTS_EPS = 1e-9;

function roundPoints(val) {
  return Math.round(((Number(val) || 0) + Number.EPSILON) * 100) / 100;
}

/**
 * Return era-accurate or custom sandbox F1 scoring rules for a season.
 */
export function getSeasonScoringLimits(year, customSandboxSettings = null) {
  const y = parseInt(year) || 2026;
  let gpSlotPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  let sprintSlotPoints = [8, 7, 6, 5, 4, 3, 2, 1];
  let awardFastestLap = false;
  let constructorAwardFastestLap = false;
  let fastestLapTopTenOnly = true;
  let doublePointsFinal = false;

  if (customSandboxSettings) {
    const sys = customSandboxSettings.pointsSystem || 'modern';
    if (sys === 'modern') {
      gpSlotPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
    } else if (sys === 'classic') {
      gpSlotPoints = [10, 8, 6, 5, 4, 3, 2, 1];
    } else if (sys === 'retro') {
      gpSlotPoints = [10, 6, 4, 3, 2, 1];
    } else if (sys === 'custom') {
      const customPts = customSandboxSettings.customPoints || [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      gpSlotPoints = customPts.length > 0 ? [...customPts] : [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
    }

    const flRule = customSandboxSettings.fastestLapPoint || 'auto';
    if (flRule === 'on') {
      awardFastestLap = true;
    } else if (flRule === 'off') {
      awardFastestLap = false;
    } else {
      awardFastestLap = (y < 2025);
    }
    constructorAwardFastestLap = awardFastestLap;

    const sprintSys = customSandboxSettings.sprintPointsSystem || 'modern';
    if (sprintSys === 'modern') {
      sprintSlotPoints = [8, 7, 6, 5, 4, 3, 2, 1];
    } else if (sprintSys === 'original') {
      sprintSlotPoints = [3, 2, 1];
    } else {
      sprintSlotPoints = [];
    }

    doublePointsFinal = !!customSandboxSettings.doublePointsFinal;
  } else {
    if (y >= 2025) {
      gpSlotPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      sprintSlotPoints = [8, 7, 6, 5, 4, 3, 2, 1];
      awardFastestLap = false;
    } else if (y >= 2022) {
      gpSlotPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      sprintSlotPoints = [8, 7, 6, 5, 4, 3, 2, 1];
      awardFastestLap = true;
      constructorAwardFastestLap = true;
    } else if (y === 2021) {
      gpSlotPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      sprintSlotPoints = [3, 2, 1];
      awardFastestLap = true;
      constructorAwardFastestLap = true;
    } else if (y >= 2019) {
      gpSlotPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      sprintSlotPoints = [];
      awardFastestLap = true;
      constructorAwardFastestLap = true;
    } else if (y >= 2010) {
      gpSlotPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      sprintSlotPoints = [];
      awardFastestLap = false;
      doublePointsFinal = (y === 2014);
    } else if (y >= 2003) {
      gpSlotPoints = [10, 8, 6, 5, 4, 3, 2, 1];
      sprintSlotPoints = [];
    } else if (y >= 1991) {
      gpSlotPoints = [10, 6, 4, 3, 2, 1];
      sprintSlotPoints = [];
    } else if (y >= 1961) {
      gpSlotPoints = [9, 6, 4, 3, 2, 1];
      sprintSlotPoints = [];
    } else if (y === 1960) {
      gpSlotPoints = [8, 6, 4, 3, 2, 1];
      sprintSlotPoints = [];
    } else {
      gpSlotPoints = [8, 6, 4, 3, 2];
      sprintSlotPoints = [];
      awardFastestLap = true;
      constructorAwardFastestLap = false;
      fastestLapTopTenOnly = false;
    }
  }

  const maxPointsPerGP = (gpSlotPoints[0] || 0) + (awardFastestLap ? 1 : 0);
  const maxSprintPoints = sprintSlotPoints[0] || 0;
  const maxConstructorPointsPerGP = (gpSlotPoints[0] || 0) + (gpSlotPoints[1] || 0) + (constructorAwardFastestLap ? 1 : 0);
  const maxConstructorSprintPoints = (sprintSlotPoints[0] || 0) + (sprintSlotPoints[1] || 0);

  return {
    gpSlotPoints,
    sprintSlotPoints,
    awardFastestLap,
    constructorAwardFastestLap,
    fastestLapTopTenOnly,
    doublePointsFinal,
    maxPointsPerGP,
    maxSprintPoints,
    maxConstructorPointsPerGP,
    maxConstructorSprintPoints
  };
}

function buildPositionCounts(raceResults) {
  const counts = new Array(31).fill(0);
  for (const pos of (raceResults || [])) {
    if (pos >= 1 && pos <= 30) counts[pos]++;
  }
  return counts;
}

function comparePositionCounts(countsA, countsB) {
  for (let pos = 1; pos <= 30; pos++) {
    if (countsA[pos] !== countsB[pos]) {
      return countsA[pos] > countsB[pos] ? 1 : -1;
    }
  }
  return 0;
}

function canChasersSimultaneouslyPass(deficits, sessionList, carsPerCompetitor = 1) {
  if (deficits.length === 0) return true;
  const rem = deficits.slice();
  const m = rem.length;

  for (const session of sessionList) {
    const carsUsed = new Array(m).fill(0);
    const scoredTopTen = new Array(m).fill(false);

    for (let sIdx = 0; sIdx < session.slots.length; sIdx++) {
      const pts = session.slots[sIdx];
      if (pts <= 0) continue;

      let bestIdx = -1;
      let bestRem = PTS_EPS;
      for (let c = 0; c < m; c++) {
        if (carsUsed[c] < carsPerCompetitor && rem[c] > bestRem) {
          bestRem = rem[c];
          bestIdx = c;
        }
      }
      if (bestIdx === -1) break;

      rem[bestIdx] = Math.max(0, rem[bestIdx] - pts);
      carsUsed[bestIdx]++;
      if (sIdx < 10) scoredTopTen[bestIdx] = true;
    }

    if (session.flBonus > 0) {
      let flIdx = -1;
      let flRem = PTS_EPS;
      for (let c = 0; c < m; c++) {
        const eligible = session.flTopTenOnly ? scoredTopTen[c] : (carsUsed[c] < carsPerCompetitor || scoredTopTen[c]);
        if (eligible && rem[c] > flRem) {
          flRem = rem[c];
          flIdx = c;
        }
      }
      if (flIdx !== -1) {
        rem[flIdx] = Math.max(0, rem[flIdx] - session.flBonus);
      }
    }
  }

  return rem.every(r => r <= PTS_EPS);
}

/**
 * Compute exact mathematical best and worst finishing positions for all drivers & constructors.
 */
function computeMathematicalPositionRanges({
  driverStandings,
  constructorStandings,
  remainingSessions,
  finalGpKey,
  scoring,
  maxRemainingPoints,
  maxConstructorRemainingPoints,
  isFinished,
  isPrelim
}) {
  const remainingGPs = remainingSessions.filter(s => s.session_name === 'Race').length;
  const remainingSprints = remainingSessions.filter(s => s.session_name === 'Sprint').length;
  const noPointsLeft = isFinished || (remainingGPs === 0 && remainingSprints === 0) || maxRemainingPoints <= 0;

  // Build concrete session descriptors sorted by largest top slot first (Double GP -> GP -> Sprint)
  const driverSessions = remainingSessions.map(s => {
    if (s.session_name === 'Sprint') {
      return { slots: [...scoring.sprintSlotPoints], flBonus: 0, flTopTenOnly: true, isGP: false };
    }
    const mult = (scoring.doublePointsFinal && String(s.session_key) === String(finalGpKey)) ? 2 : 1;
    return {
      slots: scoring.gpSlotPoints.map(p => p * mult),
      flBonus: scoring.awardFastestLap ? (1 * mult) : 0,
      flTopTenOnly: scoring.fastestLapTopTenOnly,
      isGP: true
    };
  }).sort((a, b) => ((b.slots[0] || 0) + b.flBonus) - ((a.slots[0] || 0) + a.flBonus));

  const constructorSessions = driverSessions.map(s => ({
    ...s,
    flBonus: (s.isGP && scoring.constructorAwardFastestLap) ? s.flBonus : 0
  }));

  // Precompute countback arrays for all drivers
  const driverCounts = driverStandings.map(d => buildPositionCounts(d.raceResults));

  // 1. Driver Position Ranges
  for (let i = 0; i < driverStandings.length; i++) {
    const d = driverStandings[i];
    const currentPos = i + 1;
    d.currentPos = currentPos;
    d.maxPossiblePoints = roundPoints(d.points + (noPointsLeft ? 0 : maxRemainingPoints));

    if (noPointsLeft || isPrelim) {
      d.bestPos = currentPos;
      d.worstPos = currentPos;
      d.canWinTitle = (currentPos === 1);
      d.positionLocked = !isPrelim;
      continue;
    }

    // Best possible rank: d wins all remaining GPs and scores maxRemainingPoints; rivals ahead score 0
    const countsWithAllWins = driverCounts[i].slice();
    countsWithAllWins[1] += remainingGPs;

    let unbeatableAhead = 0;
    for (let j = 0; j < i; j++) {
      const rival = driverStandings[j];
      let canOvertake = false;
      if (d.maxPossiblePoints > rival.points + PTS_EPS) {
        canOvertake = true;
      } else if (Math.abs(d.maxPossiblePoints - rival.points) <= PTS_EPS) {
        canOvertake = comparePositionCounts(countsWithAllWins, driverCounts[j]) >= 0;
      }
      if (!canOvertake) unbeatableAhead++;
    }
    d.bestPos = 1 + unbeatableAhead;

    // Worst possible rank: d scores 0 in remaining sessions; how many chasers behind can simultaneously pass d?
    const reachableChasers = [];
    const nonScoringBestPos = Math.min(30, scoring.gpSlotPoints.length + 1);

    for (let k = i + 1; k < driverStandings.length; k++) {
      const chaser = driverStandings[k];
      const chaserMaxPts = roundPoints(chaser.points + maxRemainingPoints);
      const chaserCountsMax = driverCounts[k].slice();
      chaserCountsMax[1] += remainingGPs;

      let individuallyReachable = false;
      if (chaserMaxPts > d.points + PTS_EPS) {
        individuallyReachable = true;
      } else if (Math.abs(chaserMaxPts - d.points) <= PTS_EPS) {
        individuallyReachable = comparePositionCounts(chaserCountsMax, driverCounts[i]) >= 0;
      }
      if (!individuallyReachable) continue;

      const rawGap = roundPoints(d.points - chaser.points);
      let neededPts = 1;

      if (Math.abs(rawGap) <= PTS_EPS) {
        // Currently tied on points (chaser behind on countback)
        if (remainingGPs > 0 && nonScoringBestPos <= 30) {
          const testCounts = driverCounts[k].slice();
          testCounts[nonScoringBestPos] += remainingGPs;
          if (comparePositionCounts(testCounts, driverCounts[i]) > 0) {
            neededPts = 0; // Can pass via non-scoring finish (e.g. P11)
          }
        }
      } else if (rawGap > 0) {
        if (Number.isInteger(rawGap)) {
          // Test whether tying d.points with best plausible GP finishes wins countback
          const testCounts = driverCounts[k].slice();
          let remGap = rawGap;
          for (const sess of driverSessions) {
            if (!sess.isGP || remGap <= 0) continue;
            for (let sIdx = 0; sIdx < sess.slots.length; sIdx++) {
              if (sess.slots[sIdx] <= remGap) {
                testCounts[Math.min(30, sIdx + 1)]++;
                remGap -= sess.slots[sIdx];
                break;
              }
            }
          }
          neededPts = comparePositionCounts(testCounts, driverCounts[i]) > 0 ? rawGap : (rawGap + 1);
        } else {
          neededPts = Math.ceil(rawGap - PTS_EPS);
        }
      }

      reachableChasers.push(neededPts);
    }

    reachableChasers.sort((a, b) => a - b);

    // Up to remainingGPs * non-scoring positions better than d's tiebreaker can pass with 0 points; extras need >=1 pt
    let freeNonScoringSlots = 0;
    if (remainingGPs > 0 && reachableChasers.some(n => n === 0)) {
      const bestFinishD = (d.raceResults && d.raceResults.length > 0) ? Math.min(...d.raceResults) : 20;
      const positionsStrictlyBetterNonScoring = Math.max(0, bestFinishD - scoring.gpSlotPoints.length);
      freeNonScoringSlots = remainingGPs * Math.max(1, positionsStrictlyBetterNonScoring);
    }

    let zeroUsed = 0;
    const effectiveDeficits = reachableChasers.map(n => {
      if (n === 0) {
        if (zeroUsed < freeNonScoringSlots) {
          zeroUsed++;
          return 0;
        }
        return 1;
      }
      return n;
    }).sort((a, b) => a - b);

    let maxSimultaneousChasers = 0;
    for (let m = effectiveDeficits.length; m >= 1; m--) {
      const positiveSlice = effectiveDeficits.slice(0, m).filter(v => v > 0);
      if (canChasersSimultaneouslyPass(positiveSlice, driverSessions, 1)) {
        maxSimultaneousChasers = m;
        break;
      }
    }

    d.worstPos = currentPos + maxSimultaneousChasers;
    d.canWinTitle = (d.bestPos === 1);
    d.positionLocked = (d.bestPos === d.worstPos);
  }

  // 2. Constructor Position Ranges
  const noConstPointsLeft = isFinished || (remainingGPs === 0 && remainingSprints === 0) || maxConstructorRemainingPoints <= 0;
  for (let i = 0; i < constructorStandings.length; i++) {
    const c = constructorStandings[i];
    const currentPos = i + 1;
    c.currentPos = currentPos;
    c.maxPossiblePoints = roundPoints(c.points + (noConstPointsLeft ? 0 : maxConstructorRemainingPoints));

    if (noConstPointsLeft || isPrelim) {
      c.bestPos = currentPos;
      c.worstPos = currentPos;
      c.canWinTitle = (currentPos === 1);
      c.positionLocked = !isPrelim;
      continue;
    }

    let unbeatableAhead = 0;
    for (let j = 0; j < i; j++) {
      const rival = constructorStandings[j];
      let canOvertake = false;
      if (c.maxPossiblePoints > rival.points + PTS_EPS) {
        canOvertake = true;
      } else if (Math.abs(c.maxPossiblePoints - rival.points) <= PTS_EPS) {
        canOvertake = (c.wins + remainingGPs) >= rival.wins;
      }
      if (!canOvertake) unbeatableAhead++;
    }
    c.bestPos = 1 + unbeatableAhead;

    const reachableChasers = [];
    for (let k = i + 1; k < constructorStandings.length; k++) {
      const chaser = constructorStandings[k];
      const chaserMaxPts = roundPoints(chaser.points + maxConstructorRemainingPoints);
      let individuallyReachable = false;
      if (chaserMaxPts > c.points + PTS_EPS) {
        individuallyReachable = true;
      } else if (Math.abs(chaserMaxPts - c.points) <= PTS_EPS) {
        individuallyReachable = (chaser.wins + remainingGPs) >= c.wins;
      }
      if (!individuallyReachable) continue;

      const rawGap = roundPoints(c.points - chaser.points);
      let neededPts = 1;
      if (rawGap > 0) {
        if (Number.isInteger(rawGap)) {
          const maxGPWinPts = scoring.gpSlotPoints[0] || 25;
          const extraWinsAtTie = remainingGPs > 0 && rawGap >= maxGPWinPts ? 1 : 0;
          neededPts = (chaser.wins + extraWinsAtTie) > c.wins ? rawGap : (rawGap + 1);
        } else {
          neededPts = Math.ceil(rawGap - PTS_EPS);
        }
      }
      reachableChasers.push(neededPts);
    }

    reachableChasers.sort((a, b) => a - b);

    let maxSimultaneousChasers = 0;
    for (let m = reachableChasers.length; m >= 1; m--) {
      if (canChasersSimultaneouslyPass(reachableChasers.slice(0, m), constructorSessions, 2)) {
        maxSimultaneousChasers = m;
        break;
      }
    }

    c.worstPos = currentPos + maxSimultaneousChasers;
    c.canWinTitle = (c.bestPos === 1);
    c.positionLocked = (c.bestPos === c.worstPos);
  }
}

/**
 * Build computed standings from compiled season data.
 * Zero API calls — everything from already-compiled race results.
 */
export function computeStandingsFromSeason(seasonData, excludeLastMeeting = false, customSandboxSettings = null) {
  const driverStats = new Map(); // key: name_acronym
  const constructorStats = new Map(); // teamName -> { team_name, team_colour, points, wins, driverPoints }
  const completedRaces = seasonData.races.filter(r => r.results.length > 0);

  // Build a master registry of driver_number -> name_acronym across all sessions to prevent duplicate DRV_ fallback rows
  const masterDriverAcronyms = new Map();
  for (const race of completedRaces) {
    if (race.drivers) {
      for (const d of race.drivers) {
        if (d.driver_number && d.name_acronym) {
          masterDriverAcronyms.set(d.driver_number, d.name_acronym);
        }
      }
    }
  }
  const completedQualifying = seasonData.qualifying || [];
  for (const quali of completedQualifying) {
    if (quali.drivers) {
      for (const d of quali.drivers) {
        if (d.driver_number && d.name_acronym) {
          masterDriverAcronyms.set(d.driver_number, d.name_acronym);
        }
      }
    }
  }

  // Map meeting_key -> Map(acronym -> { team_name, team_colour, hasGpQuali, hasSprintQuali })
  // Used to distinguish a genuine unreplaced Sunday/Sprint DNS from ABSENT
  // (so temporary stand-in drivers and dropped drivers do NOT get fake DNSs on races they didn't enter)
  const qualiParticipantsByMeeting = new Map();
  for (const quali of completedQualifying) {
    const isSprintQ = quali.session_name.toLowerCase().includes('sprint') || quali.session_name.toLowerCase().includes('shootout');
    const qDriversMap = new Map();
    if (quali.drivers) {
      for (const d of quali.drivers) {
        qDriversMap.set(d.driver_number, d);
      }
    }
    if (!qualiParticipantsByMeeting.has(quali.meeting_key)) {
      qualiParticipantsByMeeting.set(quali.meeting_key, new Map());
    }
    const mQualiMap = qualiParticipantsByMeeting.get(quali.meeting_key);
    for (const qr of (quali.results || [])) {
      if (qr.status === 'DNS') continue;
      const qDriverInfo = qDriversMap.get(qr.driver_number);
      const acronym = (qDriverInfo && qDriverInfo.name_acronym) || masterDriverAcronyms.get(qr.driver_number);
      if (!acronym) continue;
      const existing = mQualiMap.get(acronym) || {
        team_name: (qDriverInfo && qDriverInfo.team_name) || 'Unknown',
        team_colour: (qDriverInfo && qDriverInfo.team_colour) || '666666',
        hasGpQuali: false,
        hasSprintQuali: false
      };
      if (isSprintQ) existing.hasSprintQuali = true;
      else existing.hasGpQuali = true;
      if (existing.team_name === 'Unknown' && qDriverInfo && qDriverInfo.team_name) {
        existing.team_name = qDriverInfo.team_name;
        existing.team_colour = qDriverInfo.team_colour || '666666';
      }
      mQualiMap.set(acronym, existing);
    }
  }

  // Build registry of active season constructors (team_name -> team_colour) for 2-car vacancy deduction
  const knownSeasonTeams = new Map();
  for (const race of completedRaces) {
    for (const d of (race.drivers || [])) {
      if (d?.team_name && d.team_name !== 'Unknown') {
        if (!knownSeasonTeams.has(d.team_name) || (d.team_colour && d.team_colour !== '666666')) {
          knownSeasonTeams.set(d.team_name, d.team_colour || '666666');
        }
      }
    }
  }
  for (const quali of completedQualifying) {
    for (const d of (quali.drivers || [])) {
      if (d?.team_name && d.team_name !== 'Unknown') {
        if (!knownSeasonTeams.has(d.team_name) || (d.team_colour && d.team_colour !== '666666')) {
          knownSeasonTeams.set(d.team_name, d.team_colour || '666666');
        }
      }
    }
  }

  const activeDrivers = Array.from(seasonData.drivers.keys()); // Unique acronyms

  // Group completed sessions by meeting_key to treat Sprint + GP as one event on the timeline
  const meetingsMap = new Map();
  for (const r of completedRaces) {
    if (!meetingsMap.has(r.meeting_key)) {
      meetingsMap.set(r.meeting_key, {
        meeting_key: r.meeting_key,
        circuit_short_name: r.circuit_short_name,
        date_end: r.date_end,
        sessions: []
      });
    }
    const m = meetingsMap.get(r.meeting_key);
    m.sessions.push(r);
    if (new Date(r.date_end) > new Date(m.date_end)) {
      m.date_end = r.date_end;
    }
  }

  // Sort meetings chronologically by their end date
  let sortedMeetings = Array.from(meetingsMap.values())
    .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

  if (excludeLastMeeting && sortedMeetings.length > 0) {
    sortedMeetings.pop();
  }

  for (let meetingIdx = 0; meetingIdx < sortedMeetings.length; meetingIdx++) {
    const meeting = sortedMeetings[meetingIdx];
    // Sort Sprint before GP within the same meeting weekend
    const orderedSessions = [...meeting.sessions].sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
    for (const race of orderedSessions) {
      const isSprint = race.session_name === 'Sprint';
      const fastestLapDriver = !isSprint ? race.fastest_lap_driver : null;
      
      const raceDriversMap = new Map();
      if (race.drivers) {
        for (const d of race.drivers) {
          raceDriversMap.set(d.driver_number, d.name_acronym);
        }
      }
      const raceDrivers = new Set();
      const teamCarsInRace = new Map();
      const mQualiMapForRace = qualiParticipantsByMeeting.get(race.meeting_key);

      // Pre-resolve team per driver_number for this session so any single-team 2-car vacancy
      // (e.g. a reserve stand-in with null OpenF1 team_name) is attributed to the exact constructor
      const resolvedSessionTeams = new Map();
      const sessionTeamCounts = new Map();
      for (const [tName] of knownSeasonTeams) {
        sessionTeamCounts.set(tName, 0);
      }
      const unresolvedDriverNums = [];

      for (const { driver_number } of race.results) {
        const acronym = raceDriversMap.get(driver_number) || masterDriverAcronyms.get(driver_number) || `DRV_${driver_number}`;
        const raceDriverInfo = race.drivers ? race.drivers.find(rd => rd.driver_number === driver_number) : null;
        const qDriverInfo = mQualiMapForRace ? mQualiMapForRace.get(acronym) : null;

        let tName = (raceDriverInfo && raceDriverInfo.team_name && raceDriverInfo.team_name !== 'Unknown')
          ? raceDriverInfo.team_name
          : ((qDriverInfo && qDriverInfo.team_name && qDriverInfo.team_name !== 'Unknown') ? qDriverInfo.team_name : null);
        let tCol = (raceDriverInfo && raceDriverInfo.team_colour && raceDriverInfo.team_colour !== '666666')
          ? raceDriverInfo.team_colour
          : ((qDriverInfo && qDriverInfo.team_colour && qDriverInfo.team_colour !== '666666') ? qDriverInfo.team_colour : null);

        if (tName) {
          tCol = tCol || knownSeasonTeams.get(tName) || '666666';
          resolvedSessionTeams.set(driver_number, { team_name: tName, team_colour: tCol });
          sessionTeamCounts.set(tName, (sessionTeamCounts.get(tName) || 0) + 1);
        } else {
          unresolvedDriverNums.push({ driver_number, acronym });
        }
      }

      if (unresolvedDriverNums.length > 0 && sessionTeamCounts.size >= 8) {
        const underfilled = Array.from(sessionTeamCounts.entries()).filter(([, count]) => count < 2);
        if (underfilled.length === 1 && unresolvedDriverNums.length <= (2 - underfilled[0][1])) {
          const [vacantTeam] = underfilled[0];
          const vacantCol = knownSeasonTeams.get(vacantTeam) || '666666';
          for (const { driver_number, acronym } of unresolvedDriverNums) {
            resolvedSessionTeams.set(driver_number, { team_name: vacantTeam, team_colour: vacantCol });
            const sdInfo = seasonData.drivers.get(acronym);
            if (sdInfo && (!sdInfo.team_name || sdInfo.team_name === 'Unknown')) {
              sdInfo.team_name = vacantTeam;
              sdInfo.team_colour = vacantCol;
            }
          }
        }
      }

      for (const { driver_number, position, status, points, unclassified } of race.results) {
        const acronym = raceDriversMap.get(driver_number) || masterDriverAcronyms.get(driver_number) || `DRV_${driver_number}`;
        raceDrivers.add(acronym);

        if (!driverStats.has(acronym)) {
          const init = initDriverStats();
          init.pointsHistory = new Array(meetingIdx).fill(0);
          driverStats.set(acronym, init);
        }
        const stats = driverStats.get(acronym);
        stats.hasParticipation = true;

        // Use pre-computed official points if available, otherwise calculate dynamically
        let pts = (points !== undefined)
          ? points
          : ((status === 'DSQ' || status === 'DNS' || status === 'ABSENT' || unclassified) ? 0 : getPointsForPosition(position, isSprint));

        if (points === undefined) {
          // Award 1 extra point for fastest lap if driver finished in top 10 (only prior to 2025)
          const fastLapAcronym = fastestLapDriver ? raceDriversMap.get(fastestLapDriver) : null;
          if (seasonData.year < 2025 && fastLapAcronym === acronym && position <= 10 && status === 'FINISHED') {
            pts += 1;
          }
        }

        stats.points = roundPoints(stats.points + pts);

        if (isSprint) {
          if (position === 1 && status === 'FINISHED') stats.sprintWins++;
          if (position <= 3 && status === 'FINISHED') stats.sprintPodiums++;
          if (status === 'DNF') stats.sprintDnfs++;
          stats.sprintPoints = roundPoints(stats.sprintPoints + pts);

          if ((status === 'FINISHED' || status === 'DNF') && !unclassified) {
            stats.sprintResults.push(position);
          }
        } else {
          if (position === 1 && status === 'FINISHED') stats.wins++;
          if (position <= 3 && status === 'FINISHED') stats.podiums++;
          if (status === 'DNF') stats.dnfs++;
          if (status === 'DNS') stats.dnss++;
          if (status === 'DSQ') stats.dsqs++;

          if ((status === 'FINISHED' || status === 'DNF') && !unclassified) {
            stats.raceResults.push(position);
          }
        }
        // Find driver's team for THIS specific race (supports mid-season team swaps, multi-team stand-ins & API-resolved reserves)
        const preResolvedTeam = resolvedSessionTeams.get(driver_number);
        const raceDriverInfo = race.drivers ? race.drivers.find(rd => rd.driver_number === driver_number) : null;
        const fallbackDriverInfo = seasonData.drivers.get(acronym);
        const raceTeamName = preResolvedTeam?.team_name
          || (raceDriverInfo && raceDriverInfo.team_name && raceDriverInfo.team_name !== 'Unknown' ? raceDriverInfo.team_name : null)
          || (fallbackDriverInfo && fallbackDriverInfo.team_name && fallbackDriverInfo.team_name !== 'Unknown' ? fallbackDriverInfo.team_name : null)
          || 'Unknown';
        const raceTeamColour = preResolvedTeam?.team_colour
          || (raceDriverInfo && raceDriverInfo.team_colour && raceDriverInfo.team_colour !== '666666' ? raceDriverInfo.team_colour : null)
          || (fallbackDriverInfo && fallbackDriverInfo.team_colour && fallbackDriverInfo.team_colour !== '666666' ? fallbackDriverInfo.team_colour : null)
          || knownSeasonTeams.get(raceTeamName)
          || '666666';

        stats.allResults.push({
          position,
          isSprint,
          session_key: race.session_key,
          status: status,
          points: pts,
          team_name: raceTeamName,
          team_colour: raceTeamColour
        });

        if (raceTeamName !== 'Unknown') {
          teamCarsInRace.set(raceTeamName, (teamCarsInRace.get(raceTeamName) || 0) + 1);
          stats.latestTeamName = raceTeamName;
          stats.latestTeamColour = raceTeamColour;

          if (!stats.teamStintsMap.has(raceTeamName)) {
            stats.teamStintsMap.set(raceTeamName, {
              team_name: raceTeamName,
              team_colour: raceTeamColour,
              races: 0,
              sprints: 0,
              points: 0
            });
          }
          const stint = stats.teamStintsMap.get(raceTeamName);
          stint.team_colour = raceTeamColour;
          if (isSprint) stint.sprints++;
          else stint.races++;
          stint.points = roundPoints(stint.points + pts);

          if (!constructorStats.has(raceTeamName)) {
            constructorStats.set(raceTeamName, {
              team_name: raceTeamName,
              team_colour: raceTeamColour,
              points: 0,
              wins: 0,
              driverPoints: new Map(),
              driverRaces: new Map(),
              pointsHistory: new Array(meetingIdx).fill(0)
            });
          }
          const cStats = constructorStats.get(raceTeamName);
          cStats.team_colour = raceTeamColour;
          cStats.points = roundPoints(cStats.points + pts);
          cStats.driverPoints.set(acronym, roundPoints((cStats.driverPoints.get(acronym) || 0) + pts));
          if (!isSprint) {
            cStats.driverRaces.set(acronym, (cStats.driverRaces.get(acronym) || 0) + 1);
          }
          if (!isSprint && position === 1 && status === 'FINISHED') {
            cStats.wins++;
          }
        }
      }

      // Process non-competing drivers in activeDrivers:
      // Mark ABSENT unless the driver actually qualified on THIS exact weekend for a constructor
      // that fielded fewer than 2 cars in the race (genuine unreplaced weekend DNS).
      const mQualiMap = qualiParticipantsByMeeting.get(race.meeting_key);
      for (const acronym of activeDrivers) {
        if (!raceDrivers.has(acronym)) {
          if (!driverStats.has(acronym)) {
            const init = initDriverStats();
            init.pointsHistory = new Array(meetingIdx).fill(0);
            driverStats.set(acronym, init);
          }
          const stats = driverStats.get(acronym);
          const info = seasonData.drivers.get(acronym);

          const qInfo = mQualiMap ? mQualiMap.get(acronym) : null;
          const qualifiedThisSession = qInfo && (isSprint ? qInfo.hasSprintQuali : qInfo.hasGpQuali);
          const unreplacedWeekendDns = Boolean(
            qualifiedThisSession &&
            qInfo.team_name !== 'Unknown' &&
            (teamCarsInRace.get(qInfo.team_name) || 0) < 2
          );

          let status = 'ABSENT';
          let entryTeamName = stats.latestTeamName || (info ? info.team_name : 'Unknown');
          let entryTeamColour = stats.latestTeamColour || (info ? info.team_colour : '666666');

          if (unreplacedWeekendDns) {
            status = 'DNS';
            stats.hasParticipation = true;
            entryTeamName = qInfo.team_name;
            entryTeamColour = qInfo.team_colour;
            if (!isSprint) {
              stats.dnss++;
            }
            stats.latestTeamName = entryTeamName;
            stats.latestTeamColour = entryTeamColour;
            if (!stats.teamStintsMap.has(entryTeamName)) {
              stats.teamStintsMap.set(entryTeamName, {
                team_name: entryTeamName,
                team_colour: entryTeamColour,
                races: 0,
                sprints: 0,
                points: 0
              });
            }
            const stint = stats.teamStintsMap.get(entryTeamName);
            if (isSprint) stint.sprints++;
            else stint.races++;
            if (constructorStats.has(entryTeamName)) {
              const cStats = constructorStats.get(entryTeamName);
              if (!cStats.driverPoints.has(acronym)) cStats.driverPoints.set(acronym, 0);
              if (!isSprint) cStats.driverRaces.set(acronym, (cStats.driverRaces.get(acronym) || 0) + 1);
            }
          }

          stats.allResults.push({
            position: 20,
            isSprint,
            session_key: race.session_key,
            status: status,
            points: 0,
            team_name: entryTeamName,
            team_colour: entryTeamColour
          });
        }
      }
    }

    // Record cumulative points for ALL drivers and constructors seen so far at the end of this GP weekend
    for (const stats of driverStats.values()) {
      stats.pointsHistory.push(stats.points);
    }
    for (const cStats of constructorStats.values()) {
      cStats.pointsHistory.push(cStats.points);
    }
    // Handle newly seen active drivers if they weren't initialized yet, padding their history with 0s
    for (const acronym of activeDrivers) {
      if (!driverStats.has(acronym)) {
        driverStats.set(acronym, initDriverStats());
      }
      const stats = driverStats.get(acronym);
      while (stats.pointsHistory.length < meetingIdx + 1) {
        stats.pointsHistory.push(stats.points);
      }
    }
  }

  // Process qualifying sessions to extract GP and Sprint Quali stats
  const maxEvaluatedDate = (excludeLastMeeting && sortedMeetings.length > 0)
    ? new Date(sortedMeetings[sortedMeetings.length - 1].date_end)
    : null;

  for (const quali of completedQualifying) {
    if (maxEvaluatedDate && quali.date_end && new Date(quali.date_end) > maxEvaluatedDate) {
      continue;
    }
    const isSprintQ = quali.session_name.toLowerCase().includes('sprint') || quali.session_name.toLowerCase().includes('shootout');
    
    // Find the race session on the same weekend to map driver_number -> name_acronym
    const race = completedRaces.find(r => r.meeting_key === quali.meeting_key);
    const raceDriversMap = new Map();
    const driverSrc = (quali.drivers && quali.drivers.length > 0) ? quali.drivers : ((race && race.drivers) ? race.drivers : []);
    for (const d of driverSrc) {
      raceDriversMap.set(d.driver_number, d.name_acronym);
    }

    for (const { driver_number, position, status } of quali.results) {
      if (status === 'DNS') continue;
      const acronym = raceDriversMap.get(driver_number) || masterDriverAcronyms.get(driver_number) || `DRV_${driver_number}`;
      if (!driverStats.has(acronym)) {
        const init = initDriverStats();
        init.pointsHistory = new Array(sortedMeetings.length).fill(0);
        driverStats.set(acronym, init);
      }
      const stats = driverStats.get(acronym);
      stats.hasParticipation = true;
      if (isSprintQ) {
        stats.sprintQualiResults.push(position);
        if (position <= 10) {
          stats.sprintQ3Appearances++;
        }
      } else {
        stats.qualiResults.push(position);
        if (position <= 10) {
          stats.q3Appearances++;
        }
      }
    }
  }

  // Build driver standings (exclude drivers with zero participation up to evaluated meetings)
  const driverStandings = Array.from(driverStats.entries())
    .filter(([, stats]) => stats.hasParticipation || sortedMeetings.length === 0)
    .map(([acronym, stats]) => {
      const info = seasonData.drivers.get(acronym) || {
        driver_number: 0,
        full_name: `Driver ${acronym}`,
        name_acronym: acronym,
        team_name: 'Unknown',
        team_colour: '666666',
        headshot_url: '',
      };

      const teams = Array.from(stats.teamStintsMap.values());
      const resolvedTeamName = stats.latestTeamName || info.team_name || 'Unknown';
      const resolvedTeamColour = stats.latestTeamColour || info.team_colour || '666666';
      const { teamStintsMap, latestTeamName, latestTeamColour, hasParticipation, ...publicStats } = stats;

      return {
        ...info,
        ...publicStats,
        team_name: resolvedTeamName,
        team_colour: resolvedTeamColour,
        teams,
        headshot_url: info.headshot_url
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;

      // Official FIA F1 tiebreaker rule: compare counts of finishing positions sequentially from P1 upwards
      const countsA = new Array(31).fill(0);
      const countsB = new Array(31).fill(0);

      (a.raceResults || []).forEach(pos => {
        if (pos >= 1 && pos <= 30) countsA[pos]++;
      });
      (b.raceResults || []).forEach(pos => {
        if (pos >= 1 && pos <= 30) countsB[pos]++;
      });

      for (let pos = 1; pos <= 30; pos++) {
        if (countsB[pos] !== countsA[pos]) {
          return countsB[pos] - countsA[pos]; // Driver with more/better finishes ranks higher
        }
      }
      return 0; // Absolute tie
    });

  // Build constructor standings
  const teamMap = new Map();
  for (const [teamName, cStats] of constructorStats.entries()) {
    const driversList = [];
    for (const [acronym, ptsScored] of cStats.driverPoints.entries()) {
      const dInfo = seasonData.drivers.get(acronym);
      const gpRaces = cStats.driverRaces ? (cStats.driverRaces.get(acronym) || 0) : 0;
      driversList.push({
        name: dInfo ? dInfo.name_acronym : acronym,
        points: ptsScored,
        races: gpRaces
      });
    }
    driversList.sort((a, b) => (b.points - a.points) || (b.races - a.races));

    teamMap.set(teamName, {
      team_name: teamName,
      team_colour: cStats.team_colour,
      points: cStats.points,
      wins: cStats.wins,
      drivers: driversList,
      pointsHistory: cStats.pointsHistory || new Array(sortedMeetings.length).fill(0)
    });
  }

  // Populate fallback driver lists and teams only when a driver hasn't recorded any race stint yet (e.g. pre-Race 1 Quali)
  for (const ds of driverStandings) {
    if (ds.teams && ds.teams.length > 0) continue;
    const team = ds.team_name || 'Unknown';
    if (team === 'Unknown') continue;
    if (!teamMap.has(team)) {
      teamMap.set(team, {
        team_name: team,
        team_colour: ds.team_colour,
        points: 0,
        wins: 0,
        drivers: [],
        pointsHistory: new Array(sortedMeetings.length).fill(0)
      });
    }
    const t = teamMap.get(team);
    if (!t.drivers.some(d => d.name === ds.name_acronym)) {
      t.drivers.push({ name: ds.name_acronym, points: 0, races: 0 });
    }
  }

  const constructorStandings = Array.from(teamMap.values())
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.wins - a.wins;
    });

  const allRaceSessions = seasonData.totalRaceSessions || [];
  const completedSessionKeys = new Set(completedRaces.map(r => String(r.session_key)));

  const gpSessions = [...allRaceSessions.filter(s => s.session_name === 'Race')]
    .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
  const sprintSessions = allRaceSessions.filter(s => s.session_name === 'Sprint');
  const isFinished = gpSessions.length > 0 && gpSessions.every(s => completedSessionKeys.has(String(s.session_key)));

  // Calculate remaining sessions for mathematical clinching & position ranges
  const remainingSessions = allRaceSessions.filter(s => !completedSessionKeys.has(String(s.session_key)));
  const remainingGPs = remainingSessions.filter(s => s.session_name === 'Race').length;
  const remainingSprints = remainingSessions.filter(s => s.session_name === 'Sprint').length;

  const scoring = getSeasonScoringLimits(seasonData.year, customSandboxSettings);
  const finalGpSession = gpSessions.length > 0 ? gpSessions[gpSessions.length - 1] : null;
  const finalGpKey = finalGpSession ? finalGpSession.session_key : '';
  const finalGpIsRemaining = !!finalGpSession && remainingSessions.some(s => String(s.session_key) === String(finalGpKey) && s.session_name === 'Race');

  let maxRemainingPoints = (remainingGPs * scoring.maxPointsPerGP) + (remainingSprints * scoring.maxSprintPoints);
  let maxConstructorRemainingPoints = (remainingGPs * scoring.maxConstructorPointsPerGP) + (remainingSprints * scoring.maxConstructorSprintPoints);
  if (scoring.doublePointsFinal && finalGpIsRemaining) {
    maxRemainingPoints += scoring.maxPointsPerGP;
    maxConstructorRemainingPoints += scoring.maxConstructorPointsPerGP;
  }

  const isPrelim = !!seasonData.is_preliminary;

  if (!excludeLastMeeting) {
    computeMathematicalPositionRanges({
      driverStandings,
      constructorStandings,
      remainingSessions,
      finalGpKey,
      scoring,
      maxRemainingPoints,
      maxConstructorRemainingPoints,
      isFinished,
      isPrelim
    });
  }

  const driverClinched = !isPrelim && driverStandings.length >= 2 && (
    !excludeLastMeeting
      ? driverStandings[0].worstPos === 1
      : (driverStandings[0].points - driverStandings[1].points) > maxRemainingPoints
  );

  const constructorClinched = !isPrelim && constructorStandings.length >= 2 && (
    !excludeLastMeeting
      ? constructorStandings[0].worstPos === 1
      : (constructorStandings[0].points - constructorStandings[1].points) > maxConstructorRemainingPoints
  );

  // ── Compute Chronological Clinch GP Round for Drivers & Constructors ──
  let driverClinchMeeting = null;
  let constructorClinchMeeting = null;

  const teamPointsHistories = new Map();
  for (const team of constructorStandings) {
    teamPointsHistories.set(team.team_name, team.pointsHistory || new Array(sortedMeetings.length).fill(0));
  }

  // ── Track Championship Leadership History ──
  const driverLeadRounds = {};      // name_acronym -> array of round numbers
  const constructorLeadRounds = {}; // team_name -> array of round numbers

  for (let mIdx = 0; mIdx < sortedMeetings.length; mIdx++) {
    const meeting = sortedMeetings[mIdx];
    const meetingDate = new Date(meeting.date_end);

    // Remaining GPs/Sprints strictly after this meeting date
    const remGPsAfter = gpSessions.filter(s => new Date(s.date_end) > meetingDate);
    const remSprintsAfter = sprintSessions.filter(s => new Date(s.date_end) > meetingDate);
    const finalGpAfter = scoring.doublePointsFinal && finalGpSession && new Date(finalGpSession.date_end) > meetingDate;

    let maxRemPts = (remGPsAfter.length * scoring.maxPointsPerGP) + (remSprintsAfter.length * scoring.maxSprintPoints);
    let maxConstRemPts = (remGPsAfter.length * scoring.maxConstructorPointsPerGP) + (remSprintsAfter.length * scoring.maxConstructorSprintPoints);
    if (finalGpAfter) {
      maxRemPts += scoring.maxPointsPerGP;
      maxConstRemPts += scoring.maxConstructorPointsPerGP;
    }

    // Check Driver Clinch at round mIdx
    if (!isPrelim && !driverClinchMeeting) {
      const roundDriverPoints = driverStandings.map(d => ({
        name_acronym: d.name_acronym,
        driver_number: d.driver_number,
        points: d.pointsHistory[mIdx] || 0
      })).sort((a, b) => b.points - a.points);

      if (roundDriverPoints.length >= 2) {
        const gap = roundDriverPoints[0].points - roundDriverPoints[1].points;
        if (gap > maxRemPts) {
          driverClinchMeeting = {
            round: mIdx + 1,
            circuit_short_name: meeting.circuit_short_name,
            name_acronym: roundDriverPoints[0].name_acronym,
            driver_number: roundDriverPoints[0].driver_number
          };
        }
      }
    }

    // Check Constructor Clinch at round mIdx
    if (!isPrelim && !constructorClinchMeeting) {
      const roundConstructorPoints = Array.from(teamPointsHistories.entries()).map(([teamName, history]) => ({
        team_name: teamName,
        points: history[mIdx] || 0
      })).sort((a, b) => b.points - a.points);

      if (roundConstructorPoints.length >= 2) {
        const gap = roundConstructorPoints[0].points - roundConstructorPoints[1].points;
        if (gap > maxConstRemPts) {
          constructorClinchMeeting = {
            round: mIdx + 1,
            circuit_short_name: meeting.circuit_short_name,
            team_name: roundConstructorPoints[0].team_name
          };
        }
      }
    }

    // ── Track Championship Leaders at this round ──
    const roundDriverPoints = driverStandings.map(d => ({
      name_acronym: d.name_acronym,
      driver_number: d.driver_number,
      points: d.pointsHistory[mIdx] || 0
    })).sort((a, b) => b.points - a.points);
    if (roundDriverPoints.length > 0 && roundDriverPoints[0].points > 0) {
      const leaderAcronym = roundDriverPoints[0].name_acronym;
      if (!driverLeadRounds[leaderAcronym]) driverLeadRounds[leaderAcronym] = [];
      driverLeadRounds[leaderAcronym].push(mIdx + 1);
    }

    const roundConstructorPoints = Array.from(teamPointsHistories.entries()).map(([teamName, history]) => ({
      team_name: teamName,
      points: history[mIdx] || 0
    })).sort((a, b) => b.points - a.points);
    if (roundConstructorPoints.length > 0 && roundConstructorPoints[0].points > 0) {
      const leaderTeam = roundConstructorPoints[0].team_name;
      if (!constructorLeadRounds[leaderTeam]) constructorLeadRounds[leaderTeam] = [];
      constructorLeadRounds[leaderTeam].push(mIdx + 1);
    }
  }

  // If the season is fully finished (or mathematically clinched on countback) and no clinch occurred earlier
  if (!isPrelim && (isFinished || driverClinched)) {
    if (!driverClinchMeeting && driverStandings.length > 0 && sortedMeetings.length > 0) {
      const lastMeeting = sortedMeetings[sortedMeetings.length - 1];
      driverClinchMeeting = {
        round: sortedMeetings.length,
        circuit_short_name: lastMeeting.circuit_short_name,
        name_acronym: driverStandings[0].name_acronym,
        driver_number: driverStandings[0].driver_number
      };
    }
  }
  if (!isPrelim && (isFinished || constructorClinched)) {
    if (!constructorClinchMeeting && constructorStandings.length > 0 && sortedMeetings.length > 0) {
      const lastMeeting = sortedMeetings[sortedMeetings.length - 1];
      constructorClinchMeeting = {
        round: sortedMeetings.length,
        circuit_short_name: lastMeeting.circuit_short_name,
        team_name: constructorStandings[0].team_name
      };
    }
  }

  // ── Calculate position changes compared to the previous GP weekend ──
  let prevStandings = null;
  if (!excludeLastMeeting && sortedMeetings.length > 1) {
    try {
      prevStandings = computeStandingsFromSeason(seasonData, true, customSandboxSettings);
    } catch (e) {
      console.warn('[Season] Failed to compute previous standings for position changes:', e);
    }
  }

  if (prevStandings) {
    const prevDriverPos = new Map();
    prevStandings.drivers.forEach((d, idx) => {
      prevDriverPos.set(d.name_acronym, idx + 1);
    });
    driverStandings.forEach((d, idx) => {
      const currentPos = idx + 1;
      const prevPos = prevDriverPos.get(d.name_acronym);
      d.positionChange = prevPos !== undefined ? prevPos - currentPos : 0;
    });

    const prevConstructorPos = new Map();
    prevStandings.constructors.forEach((c, idx) => {
      prevConstructorPos.set(c.team_name, idx + 1);
    });
    constructorStandings.forEach((c, idx) => {
      const currentPos = idx + 1;
      const prevPos = prevConstructorPos.get(c.team_name);
      c.positionChange = prevPos !== undefined ? prevPos - currentPos : 0;
    });
  } else {
    driverStandings.forEach(d => { d.positionChange = 0; });
    constructorStandings.forEach(c => { c.positionChange = 0; });
  }

  return {
    year: seasonData.year,
    drivers: driverStandings,
    constructors: constructorStandings,
    raceCount: completedRaces.filter(r => r.session_name === 'Race').length,
    raceSessions: completedRaces,
    isPreliminary: isPrelim,
    isFinished: isFinished && !isPrelim,
    totalGPs: gpSessions.length,
    totalSprints: sprintSessions.length,
    remainingGPs,
    remainingSprints,
    maxRemainingDriverPoints: maxRemainingPoints,
    maxRemainingConstructorPoints: maxConstructorRemainingPoints,
    scoringInfo: {
      maxPointsPerGP: scoring.maxPointsPerGP,
      maxSprintPoints: scoring.maxSprintPoints,
      maxConstructorPointsPerGP: scoring.maxConstructorPointsPerGP,
      maxConstructorSprintPoints: scoring.maxConstructorSprintPoints,
      awardFastestLap: scoring.awardFastestLap,
      doublePointsFinal: scoring.doublePointsFinal && finalGpIsRemaining
    },
    driverClinched: driverClinched,
    constructorClinched: constructorClinched,
    driverClinchMeeting: driverClinchMeeting,
    constructorClinchMeeting: constructorClinchMeeting,
    driverLeadRounds: driverLeadRounds,
    constructorLeadRounds: constructorLeadRounds,
  };
}

export async function clearSeasonCache() {
  seasonCache.clear();
  raceCache.clear();
  try {
    await dbClear('compiled_races');
    console.log('[Season] Cleared compiled races cache in IndexedDB');
  } catch (e) {
    console.error('[Season] Failed to clear compiled races cache in IndexedDB:', e);
  }
}

/**
 * Clear cache for a single season
 */
export async function clearSingleSeasonCache(year) {
  const cached = seasonCache.get(year);
  const deletePromises = [dbDelete('compiled_races', `season_compiled_${year}`)];
  if (cached) {
    if (cached.races) {
      for (const r of cached.races) {
        deletePromises.push(dbDelete('compiled_races', lsRaceKey(r.session_key, false)));
        raceCache.delete(r.session_key);
      }
    }
    if (cached.qualifying) {
      for (const q of cached.qualifying) {
        deletePromises.push(dbDelete('compiled_races', lsRaceKey(q.session_key, true)));
        raceCache.delete(q.session_key);
      }
    }
    await Promise.all(deletePromises);
    seasonCache.delete(year);
  } else {
    try {
      const keys = await dbGetAllKeys('compiled_races');
      for (const key of keys) {
        if (typeof key === 'string' && (key.includes(`_${year}_race`) || key.includes(`_${year}_sprint`) || key.includes(`_${year}_qualifying`))) {
          deletePromises.push(dbDelete('compiled_races', key));
        }
      }
      await Promise.all(deletePromises);
    } catch (e) {
      console.error('[Season] Failed to clear single season compiled races cache in IndexedDB:', e);
    }
  }
}

/**
 * Clear compiler cache (IndexedDB + memory) for a specific meeting/sessions
 */
export async function clearMeetingCompilerCache(year, sessions) {
  const deletePromises = [dbDelete('compiled_races', `season_compiled_${year}`)];
  seasonCache.delete(year);

  for (const s of sessions) {
    const sessionKey = s.session_key;
    // Clear both possible compile versions to be thorough
    deletePromises.push(dbDelete('compiled_races', lsRaceKey(sessionKey, false)));
    deletePromises.push(dbDelete('compiled_races', lsRaceKey(sessionKey, true)));
    
    raceCache.delete(sessionKey);
  }
  
  await Promise.all(deletePromises);
  console.log(`[Season] Cleared compiled cache for meeting sessions in season ${year}`);
}


// ── Background loader & compiler helpers ──

async function startBackgroundLoad(year, missingRaces, missingQualis, allRaceSessions, completedSessions, completedQuali) {
  if (runningBackgroundLoads.has(year)) {
    return;
  }
  runningBackgroundLoads.add(year);
  console.log(`[Season] 🚀 Starting background fetcher for season ${year} (${missingRaces.length} races, ${missingQualis.length} qualis missing)`);

  try {
    for (const session of missingRaces) {
      const sessionKey = session.session_key;
      console.log(`[Season] 🌐 Background fetching race ${sessionKey} (${session.circuit_short_name})`);
      const compiledRace = await fetchRaceData(session);
      if (compiledRace) {
        raceCache.set(sessionKey, compiledRace);
        await saveRaceToStorage(sessionKey, compiledRace, false);
      } else {
        const placeholder = {
          session_key: sessionKey,
          session_name: session.session_name,
          meeting_key: session.meeting_key,
          circuit_short_name: session.circuit_short_name,
          date_end: session.date_end,
          results: [],
          drivers: [],
          is_incomplete: true,
          compiledAt: Date.now()
        };
        raceCache.set(sessionKey, placeholder);
        await saveRaceToStorage(sessionKey, placeholder, false);
      }

      // Trigger update
      await triggerSeasonUpdate(year, allRaceSessions, completedSessions, completedQuali);

      // Brief delay to prevent hitting rate limits aggressively
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    for (const session of missingQualis) {
      const sessionKey = session.session_key;
      console.log(`[Season] 🌐 Background fetching qualifying ${sessionKey} (${session.circuit_short_name})`);
      const compiledQuali = await fetchQualiData(session);
      if (compiledQuali) {
        raceCache.set(sessionKey, compiledQuali);
        await saveRaceToStorage(sessionKey, compiledQuali, true);
      } else {
        const placeholder = {
          session_key: sessionKey,
          session_name: session.session_name,
          meeting_key: session.meeting_key,
          circuit_short_name: session.circuit_short_name,
          date_end: session.date_end,
          results: [],
          is_incomplete: true,
          compiledAt: Date.now()
        };
        raceCache.set(sessionKey, placeholder);
        await saveRaceToStorage(sessionKey, placeholder, true);
      }

      // Trigger update
      await triggerSeasonUpdate(year, allRaceSessions, completedSessions, completedQuali);

      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } catch (err) {
    console.error(`[Season] Error during background compilation for ${year}:`, err);
  } finally {
    runningBackgroundLoads.delete(year);
    await triggerSeasonUpdate(year, allRaceSessions, completedSessions, completedQuali);
    console.log(`[Season] 🏁 Finished background fetcher for season ${year}`);
  }
}

async function triggerSeasonUpdate(year, allRaceSessions, completedSessions, completedQuali) {
  const races = [];
  const qualifying = [];
  const drivers = new Map();
  let incompleteSkips = 0;

  const missingRaceSessions = completedSessions.filter(s => !raceCache.has(s.session_key));
  const missingQualiSessions = completedQuali.filter(s => !raceCache.has(s.session_key));

  const raceKeys = missingRaceSessions.map(s => lsRaceKey(s.session_key, false));
  const qualiKeys = missingQualiSessions.map(s => lsRaceKey(s.session_key, true));
  const allKeys = [...raceKeys, ...qualiKeys];

  const dbResults = allKeys.length > 0 
    ? await dbGetMultiple('compiled_races', allKeys) 
    : new Map();

  for (const session of missingRaceSessions) {
    const key = lsRaceKey(session.session_key, false);
    const compiled = dbResults.get(key);
    if (compiled) {
      raceCache.set(session.session_key, compiled);
    }
  }
  for (const session of missingQualiSessions) {
    const key = lsRaceKey(session.session_key, true);
    const compiled = dbResults.get(key);
    if (compiled) {
      raceCache.set(session.session_key, compiled);
    }
  }

  for (const session of completedSessions) {
    const compiledRace = raceCache.get(session.session_key);
    if (compiledRace) {
      races.push(compiledRace);
      if (compiledRace.is_incomplete) incompleteSkips++;
    }
  }

  for (const session of completedQuali) {
    const compiledQuali = raceCache.get(session.session_key);
    if (compiledQuali) {
      qualifying.push(compiledQuali);
    }
  }

  races.sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
  qualifying.sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

  for (const quali of qualifying) {
    if (quali.drivers) {
      for (const d of quali.drivers) {
        upsertSeasonDriver(drivers, d);
      }
    }
  }
  for (const race of races) {
    if (race.drivers) {
      for (const d of race.drivers) {
        upsertSeasonDriver(drivers, d);
      }
    }
  }

  const finalSeason = {
    year,
    compiledAt: Date.now(),
    races,
    qualifying,
    drivers,
    totalRaceSessions: allRaceSessions,
    is_preliminary: (races.length < completedSessions.length || qualifying.length < completedQuali.length || incompleteSkips > 0),
    is_fetching_background: runningBackgroundLoads.has(year)
  };

  seasonCache.set(year, finalSeason);

  // Cache compiled season to IndexedDB if it is fully complete and not preliminary
  if (!finalSeason.is_preliminary) {
    try {
      const serialized = {
        ...finalSeason,
        version: LS_RACE_VERSION,
        drivers: Array.from(finalSeason.drivers.entries())
      };
      await dbSet('compiled_races', `season_compiled_${year}`, serialized);
      console.log(`[Season] Saved compiled season ${year} to IndexedDB after background update`);
    } catch (e) {
      console.warn(`[Season] Failed to save compiled season ${year} to IndexedDB:`, e);
    }
  }

  // Dispatch custom event to trigger silent UI update in app.js
  const event = new CustomEvent('pitcorner:season-updated', {
    detail: { year, seasonData: finalSeason }
  });
  document.dispatchEvent(event);
}
