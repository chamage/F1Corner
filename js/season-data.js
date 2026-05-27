// =============================================
// PITCORNER — Season Data Compiler
// Fetches each race individually, compiles,
// and caches compiled output per-race in localStorage.
// Dynamic standings are built from individual race records.
// =============================================

import { getRaceSessions, getSessionDrivers, getFinishingOrder, getStints, getSessions } from './api.js';
import { isPast, getPointsForPosition } from './utils.js';

const LS_RACE_PREFIX = 'f1c_compiled_race_';
const LS_VERSION = 21; // v21: respect official DSQ/DNS/DNF statuses in season-data results compiler to avoid status overrides

// In-memory cache
let seasonCache = new Map(); // year -> compiled season data
let raceCache = new Map();   // session_key -> compiled race data

// ── localStorage helpers ──

function lsRaceKey(sessionKey) {
  return `${LS_RACE_PREFIX}v${LS_VERSION}_${sessionKey}`;
}

function loadRaceFromStorage(sessionKey) {
  try {
    const raw = localStorage.getItem(lsRaceKey(sessionKey));
    if (!raw) return null;
    const compiled = JSON.parse(raw);
    if (compiled && compiled.is_incomplete) {
      // Expire incomplete placeholders after 30 minutes to check for new data
      if (Date.now() - (compiled.compiledAt || 0) > 30 * 60 * 1000) {
        localStorage.removeItem(lsRaceKey(sessionKey));
        return null;
      }
    }
    return compiled;
  } catch {
    return null;
  }
}

function saveRaceToStorage(sessionKey, raceData) {
  try {
    localStorage.setItem(lsRaceKey(sessionKey), JSON.stringify(raceData));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      console.warn(`[Season] localStorage quota exceeded, skipping save for race ${sessionKey}`);
    }
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
export async function getSeasonData(year) {
  // Check in-memory season cache
  if (seasonCache.has(year)) {
    const cached = seasonCache.get(year);
    // Quick validation: does the number of compiled races match current completed sessions?
    // Use the stored totalRaceSessions (which includes both Race + Sprint) for a consistent comparison
    const cachedTotal = (cached.totalRaceSessions || []).filter(s => isPast(s.date_end)).length;
    if (cachedTotal === cached.races.length) {
      console.log(`[Season] ✅ ${year} served from in-memory season cache (${cached.races.length} races)`);
      return cached;
    }
  }

  const t0 = performance.now();
  console.log(`[Season] Loading season ${year}...`);
  const gpSessions = await getRaceSessions(year);
  const sprintSessions = await getSessions({ year, session_type: 'Sprint' });
  const activeSprints = sprintSessions.filter(s => !s.is_cancelled);
  const allRaceSessions = [...gpSessions, ...activeSprints];
  const completedSessions = allRaceSessions.filter(s => isPast(s.date_end));
  console.log(`[Season] ${completedSessions.length} completed sessions to process (${(performance.now() - t0).toFixed(0)}ms for session list)`);

  const races = [];
  const drivers = new Map();
  let cacheHits = 0;
  let apiFetches = 0;
  let incompleteSkips = 0;

  // Load or fetch each session individually
  for (const session of completedSessions) {
    const sessionKey = session.session_key;

    // Tier 1: in-memory race cache
    let compiledRace = raceCache.get(sessionKey);
    if (compiledRace) {
      cacheHits++;
    } else {
      // Tier 2: localStorage race cache
      const lsKey = `${LS_RACE_PREFIX}v${LS_VERSION}_${sessionKey}`;
      const rawExists = localStorage.getItem(lsKey) !== null;
      compiledRace = loadRaceFromStorage(sessionKey);
      
      if (compiledRace && !compiledRace.is_incomplete) {
        // Promote to in-memory cache for faster subsequent access
        raceCache.set(sessionKey, compiledRace);
        cacheHits++;
      } else if (compiledRace && compiledRace.is_incomplete) {
        incompleteSkips++;
        // Skip — placeholder is still valid (not expired)
        continue;
      } else {
        // Cache miss — log why
        console.log(`[Season] ⚠️ Cache miss for ${sessionKey} (${session.circuit_short_name}) — localStorage key "${lsKey}" exists: ${rawExists}`);
      }
    }

    if (!compiledRace) {
      console.log(`[Season] 🌐 Fetching race ${sessionKey} (${session.circuit_short_name})`);
      apiFetches++;
      compiledRace = await fetchRaceData(session);
      if (compiledRace) {
        raceCache.set(sessionKey, compiledRace);
        saveRaceToStorage(sessionKey, compiledRace);
      } else {
        // Save incomplete placeholder to prevent hammering the API
        const placeholder = {
          session_key: sessionKey,
          circuit_short_name: session.circuit_short_name,
          is_incomplete: true,
          compiledAt: Date.now()
        };
        // Save to localStorage but NOT in-memory raceCache to enforce the 30-minute expiration check on future reloads
        saveRaceToStorage(sessionKey, placeholder);
        incompleteSkips++;
        continue;
      }
    }

    if (compiledRace && !compiledRace.is_incomplete) {
      races.push(compiledRace);
      // Aggregate driver details from this session
      if (compiledRace.drivers) {
        for (const d of compiledRace.drivers) {
          if (!drivers.has(d.driver_number)) {
            drivers.set(d.driver_number, d);
          }
        }
      }
    }
  }

  // Always keep races sorted chronologically by date_end
  races.sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

  const seasonData = {
    year,
    compiledAt: Date.now(),
    races,
    drivers,
    totalRaceSessions: allRaceSessions,
  };

  seasonCache.set(year, seasonData);
  console.log(`[Season] ✅ ${year} loaded in ${(performance.now() - t0).toFixed(0)}ms — ${cacheHits} cache hits, ${apiFetches} API fetches, ${incompleteSkips} incomplete skips`);
  return seasonData;
}

/**
 * Fetch data for a single race session and return compiled results.
 * Throws an error on empty responses to prevent corrupting the local cache.
 */
async function fetchRaceData(session) {
  try {
    const [sessionDrivers, results, stints] = await Promise.all([
      getSessionDrivers(session.session_key),
      getFinishingOrder(session.session_key),
      getStints({ session_key: session.session_key }),
    ]);

    if (!sessionDrivers.length || !results.length) {
      throw new Error(`Empty drivers (${sessionDrivers.length}) or results (${results.length}) fetched`);
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

      if (status === 'FINISHED') {
        if (lapsCompleted <= 1) { // Laps <= 1 is a DNS
          status = 'DNS';
        } else if (lapsCompleted <= maxLaps - 5) {
          status = 'DNF';
        }
      }

      return {
        driver_number: dn,
        position: r.position,
        status: status
      };
    });

    // Append session entered drivers who are completely missing from results (DNS / DSQ)
    let nextPos = results.length + 1;
    for (const d of sessionDrivers) {
      const dn = d.driver_number;
      if (!resultsDrivers.has(dn)) {
        const lapsCompleted = lapsByDriver.get(dn) || 0;
        let status = 'DNS';
        if (lapsCompleted > 1) {
          status = 'DSQ'; // Has stints/laps but missing from final position results = DSQ
        }

        updatedResults.push({
          driver_number: dn,
          position: nextPos++,
          status: status
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
      fastest_lap_driver: null,
      fastest_lap_time: null,
      drivers: sessionDrivers,
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
  return race ? race.results : [];
}

/**
 * Build computed standings from compiled season data.
 * Zero API calls — everything from already-compiled race results.
 */
export function computeStandingsFromSeason(seasonData) {
  const driverStats = new Map();
  const completedRaces = seasonData.races.filter(r => r.results.length > 0);

  // Find the first race date for each driver to handle mid-season replacements correctly
  const driverFirstRaceDate = new Map();
  const sortedRaces = [...completedRaces].sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
  for (const race of sortedRaces) {
    for (const r of race.results) {
      if (!driverFirstRaceDate.has(r.driver_number)) {
        driverFirstRaceDate.set(r.driver_number, new Date(race.date_end));
      }
    }
  }

  // Snap-align regular drivers (whose first GP is within the first 30 days of the season start)
  const seasonStartDate = sortedRaces.length > 0 ? new Date(sortedRaces[0].date_end) : null;
  if (seasonStartDate) {
    for (const [dn, firstDate] of driverFirstRaceDate.entries()) {
      if (firstDate - seasonStartDate < 30 * 24 * 60 * 60 * 1000) { // 30 days
        driverFirstRaceDate.set(dn, seasonStartDate);
      }
    }
  }

  const activeDrivers = Array.from(seasonData.drivers.keys());

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
  const sortedMeetings = Array.from(meetingsMap.values())
    .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

  for (const meeting of sortedMeetings) {
    for (const race of meeting.sessions) {
      const isSprint = race.session_name === 'Sprint';
      const fastestLapDriver = !isSprint ? race.fastest_lap_driver : null;
      const raceDrivers = new Set(race.results.map(r => r.driver_number));

      for (const { driver_number, position, status } of race.results) {
        if (!driverStats.has(driver_number)) {
          driverStats.set(driver_number, {
            points: 0,
            wins: 0,
            podiums: 0,
            dnfs: 0,
            dnss: 0,
            dsqs: 0,
            raceResults: [],
            allResults: [],
            pointsHistory: []
          });
        }
        const stats = driverStats.get(driver_number);

        // Points only if not disqualified (DSQ), DNS or absent
        let pts = (status === 'DSQ' || status === 'DNS' || status === 'ABSENT') ? 0 : getPointsForPosition(position, isSprint);

        // Award 1 extra point for fastest lap if driver finished in top 10 (only prior to 2025)
        if (seasonData.year < 2025 && fastestLapDriver === driver_number && position <= 10 && status === 'FINISHED') {
          pts += 1;
        }

        stats.points += pts;

        if (!isSprint) {
          if (position === 1 && status === 'FINISHED') stats.wins++;
          if (position <= 3 && status === 'FINISHED') stats.podiums++;
          if (status === 'DNF') stats.dnfs++;
          if (status === 'DNS') stats.dnss++;
          if (status === 'DSQ') stats.dsqs++;

          if (status === 'FINISHED' || status === 'DNF') {
            stats.raceResults.push(position);
          }
        }
        stats.allResults.push({
          position,
          isSprint,
          session_key: race.session_key,
          status: status
        });
      }

      // Process DNS / ABSENT active drivers who did not compete in this session
      const raceDate = new Date(race.date_end);
      for (const driverNum of activeDrivers) {
        if (!raceDrivers.has(driverNum)) {
          const firstDate = driverFirstRaceDate.get(driverNum);

          if (!driverStats.has(driverNum)) {
            driverStats.set(driverNum, {
              points: 0,
              wins: 0,
              podiums: 0,
              dnfs: 0,
              dnss: 0,
              dsqs: 0,
              raceResults: [],
              allResults: [],
              pointsHistory: []
            });
          }
          const stats = driverStats.get(driverNum);

          let status = 'ABSENT';
          if (firstDate && raceDate >= firstDate) {
            status = 'DNS';
            if (!isSprint) {
              stats.dnss++;
            }
          }

          stats.allResults.push({
            position: 20,
            isSprint,
            session_key: race.session_key,
            status: status
          });
        }
      }
    }

    // Record cumulative points for ALL drivers seen so far at the end of this GP weekend
    for (const stats of driverStats.values()) {
      stats.pointsHistory.push(stats.points);
    }
    // Handle newly seen active drivers if they weren't initialized yet, padding their history with 0s
    const meetingIdx = sortedMeetings.indexOf(meeting);
    for (const driverNum of activeDrivers) {
      if (!driverStats.has(driverNum)) {
        driverStats.set(driverNum, {
          points: 0,
          wins: 0,
          podiums: 0,
          dnfs: 0,
          dnss: 0,
          dsqs: 0,
          raceResults: [],
          allResults: [],
          pointsHistory: []
        });
      }
      const stats = driverStats.get(driverNum);
      while (stats.pointsHistory.length < meetingIdx + 1) {
        stats.pointsHistory.push(stats.points);
      }
    }
  }

  // Build driver standings
  const driverStandings = Array.from(driverStats.entries())
    .map(([driverNum, stats]) => {
      const info = seasonData.drivers.get(driverNum) || {
        driver_number: driverNum,
        full_name: `Driver #${driverNum}`,
        name_acronym: `D${driverNum}`,
        team_name: 'Unknown',
        team_colour: '666666',
        headshot_url: '',
      };

      return {
        driver_number: driverNum,
        ...info,
        ...stats,
        headshot_url: info.headshot_url
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;

      // Official FIA F1 tiebreaker rule: compare counts of finishing positions sequentially from P1 to P20
      const countsA = new Array(21).fill(0);
      const countsB = new Array(21).fill(0);

      (a.raceResults || []).forEach(pos => {
        if (pos >= 1 && pos <= 20) countsA[pos]++;
      });
      (b.raceResults || []).forEach(pos => {
        if (pos >= 1 && pos <= 20) countsB[pos]++;
      });

      for (let pos = 1; pos <= 20; pos++) {
        if (countsB[pos] !== countsA[pos]) {
          return countsB[pos] - countsA[pos]; // Driver with more/better finishes ranks higher
        }
      }
      return 0; // Absolute tie
    });

  // Build constructor standings
  const teamMap = new Map();
  for (const ds of driverStandings) {
    const team = ds.team_name || 'Unknown';
    if (!teamMap.has(team)) {
      teamMap.set(team, {
        team_name: team,
        team_colour: ds.team_colour,
        points: 0,
        wins: 0,
        drivers: [],
      });
    }
    const t = teamMap.get(team);
    t.points += ds.points;
    t.wins += ds.wins;
    t.drivers.push({ name: ds.name_acronym, points: ds.points });
  }

  const constructorStandings = Array.from(teamMap.values())
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.wins - a.wins;
    });

  return {
    year: seasonData.year,
    drivers: driverStandings,
    constructors: constructorStandings,
    raceCount: completedRaces.filter(r => r.session_name === 'Race').length,
    raceSessions: completedRaces,
  };
}

/**
 * Clear compiled season cache
 */
export function clearSeasonCache() {
  seasonCache.clear();
  raceCache.clear();
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('f1c_season_') || key.startsWith(LS_RACE_PREFIX))) {
      keys.push(key);
    }
  }
  keys.forEach(k => localStorage.removeItem(k));
}
