// =============================================
// F1 CORNER — Season Data Compiler
// Fetches each race individually, compiles,
// and caches compiled output per-race in localStorage.
// Dynamic standings are built from individual race records.
// =============================================

import { getRaceSessions, getSessionDrivers, getLaps, getFinishingOrder } from './api.js';
import { isPast, getPointsForPosition, getDriverHeadshot } from './utils.js';

const LS_RACE_PREFIX = 'f1c_compiled_race_';
const LS_VERSION = 12; // v12: revert to native OpenF1 driver headshot URLs

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
    return JSON.parse(raw);
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
    const allSessions = await getRaceSessions(year);
    const completedCount = allSessions.filter(s => isPast(s.date_end)).length;
    if (completedCount === cached.races.length) {
      return cached;
    }
  }

  console.log(`[Season] Loading season ${year}...`);
  const allRaceSessions = await getRaceSessions(year);
  const completedSessions = allRaceSessions.filter(s => isPast(s.date_end));

  const races = [];
  const drivers = new Map();

  // Load or fetch each session individually
  for (const session of completedSessions) {
    const sessionKey = session.session_key;
    let compiledRace = raceCache.get(sessionKey) || loadRaceFromStorage(sessionKey);

    if (!compiledRace) {
      console.log(`[Season] Fetching and compiling individual race ${sessionKey} (${session.circuit_short_name})`);
      compiledRace = await fetchRaceData(session);
      if (compiledRace) {
        raceCache.set(sessionKey, compiledRace);
        saveRaceToStorage(sessionKey, compiledRace);
      }
    }

    if (compiledRace) {
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
  return seasonData;
}

/**
 * Fetch data for a single race session and return compiled results.
 * Throws an error on empty responses to prevent corrupting the local cache.
 */
async function fetchRaceData(session) {
  try {
    const [laps, sessionDrivers, results] = await Promise.all([
      getLaps({ session_key: session.session_key }),
      getSessionDrivers(session.session_key),
      getFinishingOrder(session.session_key),
    ]);

    if (!laps.length || !sessionDrivers.length || !results.length) {
      throw new Error(`Empty laps (${laps.length}), drivers (${sessionDrivers.length}), or results (${results.length}) fetched`);
    }

    // Find the fastest lap of the session
    let fastestLapDriver = null;
    let fastestLapTime = Infinity;
    for (const lap of laps) {
      if (lap.lap_duration && lap.lap_duration < fastestLapTime) {
        fastestLapTime = lap.lap_duration;
        fastestLapDriver = lap.driver_number;
      }
    }

    // Calculate laps completed by each driver
    const lapsByDriver = new Map();
    for (const lap of laps) {
      const dn = lap.driver_number;
      if (!lapsByDriver.has(dn)) {
        lapsByDriver.set(dn, 0);
      }
      lapsByDriver.set(dn, Math.max(lapsByDriver.get(dn), lap.lap_number || 0));
    }

    const maxLaps = Math.max(...Array.from(lapsByDriver.values()), 1);

    // Map existing sorted results
    const resultsDrivers = new Set(results.map(r => r.driver_number));
    const updatedResults = results.map(r => {
      const dn = r.driver_number;
      const lapsCompleted = lapsByDriver.get(dn) || 0;

      let status = 'FINISHED';
      if (lapsCompleted <= 1) { // User rule: laps <= 1 is a DNS
        status = 'DNS';
      } else if (lapsCompleted < maxLaps - 4) {
        status = 'DNF';
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
        let status = 'FINISHED';
        if (lapsCompleted <= 1) {
          status = 'DNS';
        } else {
          status = 'DSQ'; // Has laps but missing from position results = DSQ
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
      fastest_lap_driver: fastestLapDriver,
      fastest_lap_time: fastestLapTime !== Infinity ? fastestLapTime : null,
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

  for (const race of completedRaces) {
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
        });
      }
      const stats = driverStats.get(driver_number);

      // Points only if not disqualified (DSQ)
      let pts = status === 'DSQ' ? 0 : getPointsForPosition(position, isSprint);

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
