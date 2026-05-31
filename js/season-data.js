// =============================================
// PITCORNER — Season Data Compiler
// Fetches each race individually, compiles,
// and caches compiled output per-race in localStorage.
// Dynamic standings are built from individual race records.
// =============================================

import { getRaceSessions, getSessionDrivers, getFinishingOrder, getStints, getSessions } from './api.js';
import { isPast, getPointsForPosition } from './utils.js';

const LS_RACE_PREFIX = 'f1c_compiled_race_';
const LS_RACE_VERSION = 21; // Keep race cache at v21 to avoid re-fetching heavy race data
const LS_QUALI_VERSION = 22; // Bump quali cache to v22 to force re-compiling of qualifying results with DNS drivers

// In-memory cache
let seasonCache = new Map(); // year -> compiled season data
let raceCache = new Map();   // session_key -> compiled race data

// ── localStorage helpers ──

function lsRaceKey(sessionKey, isQuali = false) {
  const version = isQuali ? LS_QUALI_VERSION : LS_RACE_VERSION;
  return `${LS_RACE_PREFIX}v${version}_${sessionKey}`;
}

function loadRaceFromStorage(sessionKey, isQuali = false) {
  try {
    const raw = localStorage.getItem(lsRaceKey(sessionKey, isQuali));
    if (!raw) return null;
    const compiled = JSON.parse(raw);

    // Invalidation check for retro seasons to ensure they have the new 'points' field:
    // If the session is a retro season race/sprint, and the results do not have 'points' mapped,
    // invalidate it (return null) to force a fast offline re-compile from bulk Ergast data.
    if (compiled && !isQuali && !compiled.is_incomplete) {
      const [year] = sessionKey.split('_');
      if (parseInt(year) <= 2022) {
        const hasPoints = compiled.results && compiled.results.length > 0 && compiled.results[0].points !== undefined;
        if (!hasPoints) {
          localStorage.removeItem(lsRaceKey(sessionKey, isQuali));
          return null;
        }
      }
    }

    if (compiled && compiled.is_incomplete) {
      // Expire incomplete placeholders after 30 minutes to check for new data
      if (Date.now() - (compiled.compiledAt || 0) > 30 * 60 * 1000) {
        localStorage.removeItem(lsRaceKey(sessionKey, isQuali));
        return null;
      }
    }
    return compiled;
  } catch {
    return null;
  }
}

function saveRaceToStorage(sessionKey, raceData, isQuali = false) {
  try {
    localStorage.setItem(lsRaceKey(sessionKey, isQuali), JSON.stringify(raceData));
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
    const cachedTotal = (cached.totalRaceSessions || []).filter(s => isPast(s.date_end)).length;
    if (cachedTotal === cached.races.length) {
      console.log(`[Season] ✅ ${year} served from in-memory season cache (${cached.races.length} races)`);
      return cached;
    }
  }

  const t0 = performance.now();
  console.log(`[Season] Loading season ${year}...`);
  const gpSessions = await getRaceSessions(year);
  const sprintSessions = await getSessions({ year, session_name: 'Sprint' });
  const activeSprints = sprintSessions.filter(s => !s.is_cancelled);
  const allRaceSessions = [...gpSessions, ...activeSprints];
  const completedSessions = allRaceSessions.filter(s => isPast(s.date_end));
  
  // Load qualifying sessions list
  const qualifyingSessions = await getSessions({ year, session_type: 'Qualifying' });
  const activeQuali = qualifyingSessions.filter(s => !s.is_cancelled);
  const completedQuali = activeQuali.filter(s => isPast(s.date_end));
  
  console.log(`[Season] ${completedSessions.length} completed sessions and ${completedQuali.length} completed qualifying sessions to process (${(performance.now() - t0).toFixed(0)}ms for session list)`);

  const races = [];
  const qualifying = [];
  const drivers = new Map();
  let cacheHits = 0;
  let apiFetches = 0;
  let incompleteSkips = 0;

  // Let's identify which sessions are already in cache, and which are missing!
  const missingSessions = [];
  const missingQuali = [];

  // Check race sessions cache
  for (const session of completedSessions) {
    const sessionKey = session.session_key;
    let compiledRace = raceCache.get(sessionKey) || loadRaceFromStorage(sessionKey, false);
    if (compiledRace && !compiledRace.is_incomplete) {
      races.push(compiledRace);
      cacheHits++;
    } else {
      missingSessions.push(session);
    }
  }

  // Check qualifying sessions cache
  for (const session of completedQuali) {
    const sessionKey = session.session_key;
    let compiledQuali = raceCache.get(sessionKey) || loadRaceFromStorage(sessionKey, true);
    if (compiledQuali && !compiledQuali.is_incomplete) {
      qualifying.push(compiledQuali);
      cacheHits++;
    } else {
      missingQuali.push(session);
    }
  }

  const hasMissing = missingSessions.length > 0 || missingQuali.length > 0;

  // ── SYNCHRONOUS FALLBACK PATH: For first load or cold cache ──
  // Fetch missing race sessions synchronously
  for (const session of missingSessions) {
    const sessionKey = session.session_key;
    console.log(`[Season] 🌐 Synchronously fetching race ${sessionKey} (${session.circuit_short_name})`);
    apiFetches++;
    const compiledRace = await fetchRaceData(session);
    if (compiledRace) {
      raceCache.set(sessionKey, compiledRace);
      saveRaceToStorage(sessionKey, compiledRace, false);
      races.push(compiledRace);
    } else {
      incompleteSkips++;
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
      saveRaceToStorage(sessionKey, placeholder, false);
      races.push(placeholder);
    }
  }

  // Fetch missing qualifying sessions synchronously
  for (const session of missingQuali) {
    const sessionKey = session.session_key;
    console.log(`[Season] 🌐 Synchronously fetching qualifying ${sessionKey} (${session.circuit_short_name})`);
    apiFetches++;
    const compiledQuali = await fetchQualiData(session);
    if (compiledQuali) {
      raceCache.set(sessionKey, compiledQuali);
      saveRaceToStorage(sessionKey, compiledQuali, true);
      qualifying.push(compiledQuali);
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
      saveRaceToStorage(sessionKey, placeholder, true);
      qualifying.push(placeholder);
    }
  }

  races.sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
  qualifying.sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

  for (const race of races) {
    if (race.drivers) {
      for (const d of race.drivers) {
        drivers.set(d.driver_number, d);
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
    is_preliminary: (incompleteSkips > 0 || races.length < completedSessions.length || qualifying.length < completedQuali.length)
  };

  seasonCache.set(year, finalSeason);
  console.log(`[Season] ✅ ${year} loaded synchronously in ${(performance.now() - t0).toFixed(0)}ms — ${cacheHits} cache hits, ${apiFetches} API fetches, ${incompleteSkips} incomplete skips`);
  return finalSeason;
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
    const [results, sessionDrivers] = await Promise.all([
      getFinishingOrder(session.session_key),
      getSessionDrivers(session.session_key).catch(() => [])
    ]);

    if (!results || results.length === 0) {
      throw new Error('Empty qualifying results fetched');
    }

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
      results: updatedResults
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

      if (stints && stints.length > 0 && status === 'FINISHED') {
        if (lapsCompleted <= 1) { // Laps <= 1 is a DNS
          status = 'DNS';
        } else if (lapsCompleted <= maxLaps - 5) {
          status = 'DNF';
        }
      }

      return {
        driver_number: dn,
        position: r.position,
        status: status,
        points: r.points
      };
    });

    // Append session entered drivers who are completely missing from results (DNS / DSQ)
    let nextPos = results.length + 1;
    for (const d of sessionDrivers) {
      const dn = d.driver_number;
      if (!resultsDrivers.has(dn)) {
        const lapsCompleted = lapsByDriver.get(dn) || 0;
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
    sprintQualiResults: []
  };
}

/**
 * Build computed standings from compiled season data.
 * Zero API calls — everything from already-compiled race results.
 */
export function computeStandingsFromSeason(seasonData) {
  const driverStats = new Map();
  const constructorStats = new Map(); // teamName -> { team_name, team_colour, points, wins, driverPoints }
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

      for (const { driver_number, position, status, points } of race.results) {
        if (!driverStats.has(driver_number)) {
          driverStats.set(driver_number, initDriverStats());
        }
        const stats = driverStats.get(driver_number);

        // Use pre-computed official points if available, otherwise calculate dynamically
        let pts = (points !== undefined)
          ? points
          : ((status === 'DSQ' || status === 'DNS' || status === 'ABSENT') ? 0 : getPointsForPosition(position, isSprint));

        if (points === undefined) {
          // Award 1 extra point for fastest lap if driver finished in top 10 (only prior to 2025)
          if (seasonData.year < 2025 && fastestLapDriver === driver_number && position <= 10 && status === 'FINISHED') {
            pts += 1;
          }
        }

        stats.points += pts;

        if (isSprint) {
          if (position === 1 && status === 'FINISHED') stats.sprintWins++;
          if (position <= 3 && status === 'FINISHED') stats.sprintPodiums++;
          if (status === 'DNF') stats.sprintDnfs++;
          stats.sprintPoints += pts;

          if (status === 'FINISHED' || status === 'DNF') {
            stats.sprintResults.push(position);
          }
        } else {
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

        // Find driver's team for THIS specific race
        const raceDriverInfo = race.drivers ? race.drivers.find(rd => rd.driver_number === driver_number) : null;
        const raceTeamName = raceDriverInfo ? raceDriverInfo.team_name : 'Unknown';
        const raceTeamColour = raceDriverInfo ? raceDriverInfo.team_colour : '666666';

        if (raceTeamName !== 'Unknown') {
          if (!constructorStats.has(raceTeamName)) {
            constructorStats.set(raceTeamName, {
              team_name: raceTeamName,
              team_colour: raceTeamColour,
              points: 0,
              wins: 0,
              driverPoints: new Map()
            });
          }
          const cStats = constructorStats.get(raceTeamName);
          cStats.points += pts;
          cStats.driverPoints.set(driver_number, (cStats.driverPoints.get(driver_number) || 0) + pts);
          if (!isSprint && position === 1 && status === 'FINISHED') {
            cStats.wins++;
          }
        }
      }

      // Process DNS / ABSENT active drivers who did not compete in this session
      const raceDate = new Date(race.date_end);
      for (const driverNum of activeDrivers) {
        if (!raceDrivers.has(driverNum)) {
          const firstDate = driverFirstRaceDate.get(driverNum);

          if (!driverStats.has(driverNum)) {
            driverStats.set(driverNum, initDriverStats());
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
        driverStats.set(driverNum, initDriverStats());
      }
      const stats = driverStats.get(driverNum);
      while (stats.pointsHistory.length < meetingIdx + 1) {
        stats.pointsHistory.push(stats.points);
      }
    }
  }

  // Process qualifying sessions to extract GP and Sprint Quali stats
  const completedQualifying = seasonData.qualifying || [];
  for (const quali of completedQualifying) {
    const isSprintQ = quali.session_name.toLowerCase().includes('sprint') || quali.session_name.toLowerCase().includes('shootout');
    for (const { driver_number, position } of quali.results) {
      if (!driverStats.has(driver_number)) {
        driverStats.set(driver_number, initDriverStats());
      }
      const stats = driverStats.get(driver_number);
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
  for (const [teamName, cStats] of constructorStats.entries()) {
    const driversList = [];
    for (const [driverNum, ptsScored] of cStats.driverPoints.entries()) {
      const dInfo = seasonData.drivers.get(driverNum);
      if (dInfo) {
        driversList.push({ name: dInfo.name_acronym, points: ptsScored });
      }
    }
    driversList.sort((a, b) => b.points - a.points);

    teamMap.set(teamName, {
      team_name: teamName,
      team_colour: cStats.team_colour,
      points: cStats.points,
      wins: cStats.wins,
      drivers: driversList,
    });
  }

  // Populate fallback driver lists and teams if any drivers represent teams not captured in constructorStats
  for (const ds of driverStandings) {
    const team = ds.team_name || 'Unknown';
    if (team === 'Unknown') continue;
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
    if (!t.drivers.some(d => d.name === ds.name_acronym)) {
      t.drivers.push({ name: ds.name_acronym, points: ds.points });
    }
  }

  const constructorStandings = Array.from(teamMap.values())
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.wins - a.wins;
    });

  const allRaceSessions = seasonData.totalRaceSessions || [];
  const gpSessions = allRaceSessions.filter(s => s.session_name === 'Race');
  const sprintSessions = allRaceSessions.filter(s => s.session_name === 'Sprint');
  const isFinished = gpSessions.length > 0 && gpSessions.every(s => new Date(s.date_end) < new Date());

  // Calculate remaining sessions for mathematical clinching
  const remainingSessions = allRaceSessions.filter(s => new Date(s.date_end) >= new Date());
  const remainingGPs = remainingSessions.filter(s => s.session_name === 'Race').length;
  const remainingSprints = remainingSessions.filter(s => s.session_name === 'Sprint').length;

  const maxPointsPerGP = seasonData.year < 2025 ? 26 : 25;
  const maxRemainingPoints = (remainingGPs * maxPointsPerGP) + (remainingSprints * 8);

  const maxConstructorPointsPerGP = seasonData.year < 2025 ? 44 : 43;
  const maxConstructorRemainingPoints = (remainingGPs * maxConstructorPointsPerGP) + (remainingSprints * 15);

  const isPrelim = !!seasonData.is_preliminary;

  const driverClinched = !isPrelim && driverStandings.length >= 2 && 
    (driverStandings[0].points - driverStandings[1].points) > maxRemainingPoints;

  const constructorClinched = !isPrelim && constructorStandings.length >= 2 && 
    (constructorStandings[0].points - constructorStandings[1].points) > maxConstructorRemainingPoints;

  // ── Compute Chronological Clinch GP Round for Drivers & Constructors ──
  let driverClinchMeeting = null;
  let constructorClinchMeeting = null;

  // We can calculate pointsHistory for constructors by summing driver points histories:
  const teamPointsHistories = new Map(); // teamName -> pointsHistory[]
  for (const ds of driverStandings) {
    const teamName = ds.team_name || 'Unknown';
    if (teamName === 'Unknown') continue;
    if (!teamPointsHistories.has(teamName)) {
      teamPointsHistories.set(teamName, new Array(sortedMeetings.length).fill(0));
    }
    const tHistory = teamPointsHistories.get(teamName);
    const dHistory = ds.pointsHistory || [];
    for (let rIdx = 0; rIdx < sortedMeetings.length; rIdx++) {
      if (rIdx < dHistory.length) {
        tHistory[rIdx] += dHistory[rIdx];
      } else if (dHistory.length > 0) {
        tHistory[rIdx] += dHistory[dHistory.length - 1];
      }
    }
  }

  // Assign pointsHistory to constructors
  for (const team of constructorStandings) {
    team.pointsHistory = teamPointsHistories.get(team.team_name) || new Array(sortedMeetings.length).fill(0);
  }

  // ── Track Championship Leadership History ──
  const driverLeadRounds = {};      // driver_number -> array of round numbers
  const constructorLeadRounds = {}; // team_name -> array of round numbers

  for (let mIdx = 0; mIdx < sortedMeetings.length; mIdx++) {
    const meeting = sortedMeetings[mIdx];
    const meetingDate = new Date(meeting.date_end);

    // Remaining GPs/Sprints strictly after this meeting date
    const remGPs = gpSessions.filter(s => new Date(s.date_end) > meetingDate).length;
    const remSprints = sprintSessions.filter(s => new Date(s.date_end) > meetingDate).length;

    const maxRemPts = (remGPs * maxPointsPerGP) + (remSprints * 8);
    const maxConstRemPts = (remGPs * maxConstructorPointsPerGP) + (remSprints * 15);

    // Check Driver Clinch at round mIdx
    if (!isPrelim && !driverClinchMeeting) {
      const roundDriverPoints = driverStandings.map(d => ({
        driver_number: d.driver_number,
        points: d.pointsHistory[mIdx] || 0
      })).sort((a, b) => b.points - a.points);

      if (roundDriverPoints.length >= 2) {
        const gap = roundDriverPoints[0].points - roundDriverPoints[1].points;
        if (gap > maxRemPts) {
          driverClinchMeeting = {
            round: mIdx + 1,
            circuit_short_name: meeting.circuit_short_name,
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
      driver_number: d.driver_number,
      points: d.pointsHistory[mIdx] || 0
    })).sort((a, b) => b.points - a.points);
    if (roundDriverPoints.length > 0 && roundDriverPoints[0].points > 0) {
      const leaderNum = roundDriverPoints[0].driver_number;
      if (!driverLeadRounds[leaderNum]) driverLeadRounds[leaderNum] = [];
      driverLeadRounds[leaderNum].push(mIdx + 1);
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

  // If the season is fully finished and no clinch occurred earlier (absolute tie-breaker in final round)
  if (!isPrelim && isFinished) {
    if (!driverClinchMeeting && driverStandings.length > 0) {
      const lastMeeting = sortedMeetings[sortedMeetings.length - 1];
      driverClinchMeeting = {
        round: sortedMeetings.length,
        circuit_short_name: lastMeeting.circuit_short_name,
        driver_number: driverStandings[0].driver_number
      };
    }
    if (!constructorClinchMeeting && constructorStandings.length > 0) {
      const lastMeeting = sortedMeetings[sortedMeetings.length - 1];
      constructorClinchMeeting = {
        round: sortedMeetings.length,
        circuit_short_name: lastMeeting.circuit_short_name,
        team_name: constructorStandings[0].team_name
      };
    }
  }

  return {
    year: seasonData.year,
    drivers: driverStandings,
    constructors: constructorStandings,
    raceCount: completedRaces.filter(r => r.session_name === 'Race').length,
    raceSessions: completedRaces,
    isFinished: isFinished && !isPrelim,
    driverClinched: driverClinched,
    constructorClinched: constructorClinched,
    driverClinchMeeting: driverClinchMeeting,
    constructorClinchMeeting: constructorClinchMeeting,
    driverLeadRounds: driverLeadRounds,
    constructorLeadRounds: constructorLeadRounds,
  };
}

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

/**
 * Clear cache for a single season
 */
export function clearSingleSeasonCache(year) {
  const cached = seasonCache.get(year);
  if (cached) {
    if (cached.races) {
      for (const r of cached.races) {
        localStorage.removeItem(lsRaceKey(r.session_key, false));
        raceCache.delete(r.session_key);
      }
    }
    if (cached.qualifying) {
      for (const q of cached.qualifying) {
        localStorage.removeItem(lsRaceKey(q.session_key, true));
        raceCache.delete(q.session_key);
      }
    }
    seasonCache.delete(year);
  }
}
