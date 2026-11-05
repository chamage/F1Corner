// =============================================
// PITCORNER — Race Deep-Dive Section
// Lazy-loads heavy charts and feeds to avoid API timeouts
// =============================================

import { getLaps, getStints, getPits, getOvertakes, getSessionDrivers, getRaceControl, getWeather, getIntervals, getPositions, getMeetingSessions, clearSessionsAPICache, getCacheStats } from './api.js';
import { getSeasonData, getResultsForSession, clearMeetingCompilerCache } from './season-data.js';
import { formatLapTime, formatGap, getTeamColor, getCompoundColor, getCompoundClass, getDriverFlagImg, DRIVER_NATIONALITY, getPointsForPosition, isPast, buildDriverMap, formatDateRange, $, $$ } from './utils.js';
import { drawLineChart, drawPositionChart } from './charts.js';
import { setStandingsRound } from './standings.js';
import { isFavoriteDriver, isFavoriteTeam, toggleFavoriteDriver } from './favorites.js';

let currentTab = 'results';
let raceDataCache = null;

window.addEventListener('pitcorner:favorites-changed', () => {
  const sec = document.getElementById('race-detail');
  if (raceDataCache && sec && sec.style.display !== 'none') {
    renderTab();
  }
});

/**
 * Helper to compute starting grid map for Race/Sprint from Qualifying/Sprint Qualifying or Lap 1
 */
function computeStartingGridMap() {
  if (!raceDataCache) return new Map();
  const { sessions, currentSessionType, laps, driverMap } = raceDataCache;
  const gridMap = new Map();

  let qualiSession = null;
  if (currentSessionType === 'Race') {
    qualiSession = sessions?.['Qualifying'] || null;
  } else if (currentSessionType === 'Sprint') {
    qualiSession = sessions?.['Sprint Qualifying'] || sessions?.['Sprint Shootout'] || null;
  }

  if (qualiSession && qualiSession.results && qualiSession.results.length > 0) {
    const qDrivers = qualiSession.drivers || [];
    for (const qRes of qualiSession.results) {
      if (qRes.status === 'DNS' || typeof qRes.position !== 'number') continue;
      if (driverMap && driverMap.has(qRes.driver_number)) {
        gridMap.set(qRes.driver_number, qRes.position);
      } else {
        const qDrv = qDrivers.find(qd => qd.driver_number === qRes.driver_number);
        if (qDrv?.name_acronym && driverMap) {
          for (const [dn, rDrv] of driverMap.entries()) {
            if (rDrv.name_acronym === qDrv.name_acronym) {
              gridMap.set(dn, qRes.position);
              break;
            }
          }
        }
      }
    }
  }

  // Fallback to Lap 1 order if qualifying wasn't compiled
  if (gridMap.size === 0 && laps && laps.length > 0) {
    const lap1 = laps
      .filter(l => l.lap_number === 1 && l.lap_duration > 0)
      .sort((a, b) => a.lap_duration - b.lap_duration);
    lap1.forEach((l, idx) => {
      gridMap.set(l.driver_number, idx + 1);
    });
  }

  return gridMap;
}

function isDriverOrTeamFavorite(d) {
  if (!d) return { isFavD: false, isFavT: false };
  return {
    isFavD: isFavoriteDriver(d.name_acronym),
    isFavT: isFavoriteTeam(d.team_name)
  };
}

/**
 * OpenF1 /overtakes records contain ISO timestamps (`date`) without `lap_number`.
 * Correlates each overtake timestamp against driver & session /laps start times
 * (including backward interpolation for Lap 1 where OpenF1 leaves `date_start: null`).
 */
export function enrichOvertakesWithLaps(overtakes, laps) {
  if (!Array.isArray(overtakes) || overtakes.length === 0) return overtakes;
  if (!Array.isArray(laps) || laps.length === 0) return overtakes;
  if (overtakes.every(o => typeof o.lap_number === 'number' && o.lap_number > 0)) {
    return overtakes;
  }

  // 1. Group laps by driver_number
  const byDriver = new Map();
  for (const l of laps) {
    if (!l || typeof l.lap_number !== 'number') continue;
    if (!byDriver.has(l.driver_number)) byDriver.set(l.driver_number, []);
    byDriver.get(l.driver_number).push({
      lap_number: l.lap_number,
      startMs: l.date_start ? Date.parse(l.date_start) : NaN,
      durMs: (typeof l.lap_duration === 'number' && l.lap_duration > 0) ? l.lap_duration * 1000 : null
    });
  }

  const driverTimelines = new Map();
  const startsByLap = new Map();

  for (const [dn, list] of byDriver.entries()) {
    // Deduplicate by lap_number & sort ascending
    const dedupMap = new Map();
    for (const item of list) {
      const existing = dedupMap.get(item.lap_number);
      if (!existing || (isNaN(existing.startMs) && !isNaN(item.startMs))) {
        dedupMap.set(item.lap_number, item);
      }
    }
    const sorted = Array.from(dedupMap.values()).sort((a, b) => a.lap_number - b.lap_number);

    // Ensure Lap 1 entry exists if Lap 2+ exists (OpenF1 often omits or nulls Lap 1 date_start)
    if (sorted.length > 0 && sorted[0].lap_number > 1 && sorted[0].lap_number <= 3) {
      for (let missingLap = sorted[0].lap_number - 1; missingLap >= 1; missingLap--) {
        sorted.unshift({ lap_number: missingLap, startMs: NaN, durMs: 105000 });
      }
    }

    // Forward pass: interpolate missing startMs from previous lap start + duration
    for (let i = 1; i < sorted.length; i++) {
      if (isNaN(sorted[i].startMs) && !isNaN(sorted[i - 1].startMs)) {
        const prevDur = sorted[i - 1].durMs || 98000;
        const lapGap = Math.max(1, sorted[i].lap_number - sorted[i - 1].lap_number);
        sorted[i].startMs = sorted[i - 1].startMs + prevDur * lapGap;
      }
    }

    // Backward pass: interpolate missing early startMs (especially Lap 1!) from next lap start
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (isNaN(sorted[i].startMs) && !isNaN(sorted[i + 1].startMs)) {
        const curDur = sorted[i].durMs || 105000;
        const lapGap = Math.max(1, sorted[i + 1].lap_number - sorted[i].lap_number);
        sorted[i].startMs = sorted[i + 1].startMs - curDur * lapGap;
      }
    }

    const valid = sorted
      .filter(x => !isNaN(x.startMs))
      .sort((a, b) => a.startMs - b.startMs);

    if (valid.length > 0) {
      driverTimelines.set(dn, valid);
      for (const v of valid) {
        if (!startsByLap.has(v.lap_number)) startsByLap.set(v.lap_number, []);
        startsByLap.get(v.lap_number).push(v.startMs);
      }
    }
  }

  // 2. Build session-wide leader lap timeline (robust against single-car timestamp outliers)
  const sessionTimeline = [];
  const lapNums = Array.from(startsByLap.keys()).sort((a, b) => a - b);
  for (const ln of lapNums) {
    const times = startsByLap.get(ln).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const clean = times.filter(t => Math.abs(t - median) <= 5 * 60 * 1000);
    const refStart = clean.length > 0 ? clean[0] : times[0];
    sessionTimeline.push({ lap_number: ln, startMs: refStart, durMs: 120000 });
  }
  sessionTimeline.sort((a, b) => a.startMs - b.startMs);

  const findLapAt = (timeline, tMs, enforceEndBound = true) => {
    if (!timeline || timeline.length === 0 || isNaN(tMs)) return null;
    if (tMs < timeline[0].startMs) {
      // Overtakes moments after lights out if Lap 1 start estimate was slightly late
      if (timeline[0].lap_number <= 2 && (timeline[0].startMs - tMs) <= 4 * 60 * 1000) {
        return 1;
      }
      return null;
    }
    let lo = 0;
    let hi = timeline.length - 1;
    let bestIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].startMs <= tMs) {
        bestIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const chosen = timeline[bestIdx];
    if (enforceEndBound && bestIdx === timeline.length - 1) {
      const maxWindow = (chosen.durMs || 150000) + 90000;
      if (tMs > chosen.startMs + maxWindow) {
        return null;
      }
    }
    return chosen.lap_number;
  };

  return overtakes.map(ot => {
    if (typeof ot.lap_number === 'number' && ot.lap_number > 0) return ot;
    const tMs = ot.date ? Date.parse(ot.date) : NaN;
    if (isNaN(tMs)) return ot;

    const resolvedLap =
      findLapAt(driverTimelines.get(ot.overtaking_driver_number), tMs, true) ??
      findLapAt(driverTimelines.get(ot.overtaken_driver_number), tMs, true) ??
      findLapAt(sessionTimeline, tMs, false);

    return resolvedLap ? { ...ot, lap_number: resolvedLap } : ot;
  });
}

// Short display labels for session pills
const SESSION_LABELS = {
  'Practice 1': 'FP1',
  'Practice 2': 'FP2',
  'Practice 3': 'FP3',
  'Qualifying': 'Quali',
  'Sprint Qualifying': 'SQ',
  'Sprint Shootout': 'SQ',
  'Sprint': 'Sprint',
  'Race': 'Race',
};

// Session display order (chronological weekend order)
const SESSION_ORDER = ['Practice 1', 'Practice 2', 'Practice 3', 'Sprint Qualifying', 'Sprint Shootout', 'Sprint', 'Qualifying', 'Race'];

/**
 * Check if a session type is a "race" format (has finishing order, points, overtakes, etc.)
 */
function isRaceSession(sessionName) {
  return sessionName === 'Race' || sessionName === 'Sprint';
}

/**
 * Helper to identify qualifying sessions (Qualifying, Sprint Qualifying, Sprint Shootout).
 */
function isQualifyingSession(sessionName) {
  if (!sessionName) return false;
  return sessionName.toLowerCase().includes('qualifying') || sessionName.toLowerCase().includes('shootout');
}

/**
 * Intelligent self-correcting partitioning of qualifying laps into Q1, Q2, and Q3.
 * Identifies breaks using standard F1 duration parameters and driver size constraints.
 */
function partitionQualiLaps(laps) {
  if (!laps || laps.length === 0) return { q1: [], q2: [], q3: [] };

  const lapsWithTime = laps
    .map(lap => ({
      ...lap,
      time: lap.date_start ? new Date(lap.date_start).getTime() : 0
    }))
    .filter(lap => lap.time > 0 && lap.lap_duration > 0)
    .sort((a, b) => a.time - b.time);

  if (lapsWithTime.length === 0) {
    return { q1: laps, q2: [], q3: [] };
  }

  const minT = lapsWithTime[0].time;
  const maxT = lapsWithTime[lapsWithTime.length - 1].time;
  const totalDuration = maxT - minT;

  // Fallback if session is extremely short (e.g. less than 10 mins)
  if (totalDuration < 10 * 60 * 1000) {
    return { q1: lapsWithTime, q2: [], q3: [] };
  }

  // Find gaps larger than 1.5 minutes (break candidates)
  const gaps = [];
  for (let i = 1; i < lapsWithTime.length; i++) {
    const gapMs = lapsWithTime[i].time - lapsWithTime[i-1].time;
    if (gapMs > 1.5 * 60 * 1000) {
      gaps.push({
        gapMs,
        splitTime: lapsWithTime[i-1].time + gapMs / 2
      });
    }
  }

  gaps.sort((a, b) => b.gapMs - a.gapMs);

  const candidates = [];
  const topGaps = gaps.slice(0, 6);

  // Generate combinations of splits
  for (let i = 0; i < topGaps.length; i++) {
    for (let j = i + 1; j < topGaps.length; j++) {
      const s1 = Math.min(topGaps[i].splitTime, topGaps[j].splitTime);
      const s2 = Math.max(topGaps[i].splitTime, topGaps[j].splitTime);
      candidates.push([s1, s2]);
    }
  }

  for (let i = 0; i < topGaps.length; i++) {
    candidates.push([topGaps[i].splitTime, null]);
  }

  const fallbackS1 = minT + totalDuration * 0.40;
  const fallbackS2 = minT + totalDuration * 0.75;
  candidates.push([fallbackS1, fallbackS2]);
  candidates.push([fallbackS1, null]);

  let bestScore = -1;
  let selectedSplits = [fallbackS1, fallbackS2];

  for (const [s1, s2] of candidates) {
    const q1Drivers = new Set();
    const q2Drivers = new Set();
    const q3Drivers = new Set();

    for (const lap of lapsWithTime) {
      if (lap.time < s1) {
        q1Drivers.add(lap.driver_number);
      } else if (!s2 || lap.time < s2) {
        q2Drivers.add(lap.driver_number);
      } else {
        q3Drivers.add(lap.driver_number);
      }
    }

    const n1 = q1Drivers.size;
    const n2 = q2Drivers.size;
    const n3 = s2 ? q3Drivers.size : 0;

    let isValid = false;
    let score = 0;

    if (s2) {
      if (n1 >= n2 && n2 >= n3 && n1 > 0) {
        isValid = true;
        const p1 = Math.abs(n1 - 20);
        const p2 = Math.abs(n2 - 15);
        const p3 = Math.abs(n3 - 10);
        score = 1000 - (p1 + p2 + p3) * 10;
      }
    } else {
      if (n1 >= n2 && n1 > 0) {
        isValid = true;
        score = 500 - Math.abs(n1 - 20) * 10 - Math.abs(n2 - 15) * 10;
      }
    }

    if (isValid && score > bestScore) {
      bestScore = score;
      selectedSplits = [s1, s2];
    }
  }

  const [s1, s2] = selectedSplits;
  const q1 = [];
  const q2 = [];
  const q3 = [];

  for (const lap of lapsWithTime) {
    if (lap.time < s1) {
      q1.push(lap);
    } else if (!s2 || lap.time < s2) {
      q2.push(lap);
    } else {
      q3.push(lap);
    }
  }

  return { q1, q2, q3 };
}

/**
 * Build a qualifying/practice-style classification from lap data.
 * Supports standard practice best-lap ranking, and intelligent multi-segment (Q1, Q2, Q3) elimination grids.
 */
function buildQualifyingOrder(laps, driverMap, sessionType = '') {
  if (!laps) return [];

  // For Practice sessions, standard best lap sorting is perfectly fine
  if (!isQualifyingSession(sessionType)) {
    const driverBestLaps = new Map();
    for (const lap of laps) {
      if (!lap.lap_duration || lap.lap_duration <= 0) continue;
      const dn = lap.driver_number;
      const current = driverBestLaps.get(dn);
      if (!current || lap.lap_duration < current.bestLap) {
        driverBestLaps.set(dn, { bestLap: lap.lap_duration, lapCount: (current ? current.lapCount : 0) + 1 });
      } else {
        driverBestLaps.set(dn, { ...current, lapCount: current.lapCount + 1 });
      }
    }

    const allDrivers = Array.from(new Set([
      ...laps.map(l => l.driver_number),
      ...(driverMap ? Array.from(driverMap.keys()) : [])
    ]));

    const driverRecords = allDrivers.map(dn => {
      const best = driverBestLaps.get(dn);
      return {
        driver_number: dn,
        bestLap: best ? best.bestLap : null,
        lapCount: best ? best.lapCount : 0
      };
    });

    // Sort: drivers with times first (sorted by best lap), followed by drivers with no times
    const withTime = driverRecords.filter(r => r.bestLap !== null).sort((a, b) => a.bestLap - b.bestLap);
    const noTime = driverRecords.filter(r => r.bestLap === null);
    const sorted = [...withTime, ...noTime];

    return sorted.map((r, idx) => ({
      driver_number: r.driver_number,
      position: idx + 1,
      status: r.lapCount === 0 ? 'DNS' : 'FINISHED',
      bestLap: r.bestLap,
      lapCount: r.lapCount,
    }));
  }

  // It is a Qualifying session! Partition laps into Q1, Q2, Q3
  const { q1, q2, q3 } = partitionQualiLaps(laps);

  const getBestForSegment = (segmentLaps, dn) => {
    const lapsForDriver = segmentLaps.filter(l => l.driver_number === dn && l.lap_duration > 0);
    if (lapsForDriver.length === 0) return null;
    return Math.min(...lapsForDriver.map(l => l.lap_duration));
  };

  const getLapCountForDriver = (dn) => {
    return laps.filter(l => l.driver_number === dn && l.lap_duration > 0).length;
  };

  const allDrivers = Array.from(new Set([
    ...laps.map(l => l.driver_number),
    ...(driverMap ? Array.from(driverMap.keys()) : [])
  ]));

  const driverRecords = allDrivers.map(dn => {
    const q1Best = getBestForSegment(q1, dn);
    const q2Best = getBestForSegment(q2, dn);
    const q3Best = getBestForSegment(q3, dn);
    const totalLaps = getLapCountForDriver(dn);

    return {
      driver_number: dn,
      q1: q1Best,
      q2: q2Best,
      q3: q3Best,
      lapCount: totalLaps
    };
  });

  // Sort drivers based on elimination logic:
  // Group 3: Drivers who set a time in Q3 (top 10)
  // Group 2: Drivers who set a time in Q2 but not in Q3 (positions 11-15)
  // Group 1: Drivers who only set a time in Q1 (positions 16-20)
  const q3Group = driverRecords.filter(r => r.q3 !== null).sort((a, b) => a.q3 - b.q3);
  const q2Group = driverRecords.filter(r => r.q3 === null && r.q2 !== null).sort((a, b) => a.q2 - b.q2);
  const q1Group = driverRecords.filter(r => r.q3 === null && r.q2 === null && r.q1 !== null).sort((a, b) => a.q1 - b.q1);
  const noTimeGroup = driverRecords.filter(r => r.q3 === null && r.q2 === null && r.q1 === null);

  const sortedRecords = [...q3Group, ...q2Group, ...q1Group, ...noTimeGroup];

  return sortedRecords.map((r, idx) => ({
    driver_number: r.driver_number,
    position: idx + 1,
    status: r.lapCount === 0 ? 'DNS' : 'FINISHED',
    bestLap: r.q3 || r.q2 || r.q1 || null,
    q1: r.q1,
    q2: r.q2,
    q3: r.q3,
    lapCount: r.lapCount
  }));
}

/**
 * Show/hide tabs based on session type.
 * Non-race sessions hide Positions and Overtakes tabs.
 */
function updateTabVisibility(sessionName) {
  const tabs = document.querySelectorAll('#race-detail-tabs button');
  const isRace = isRaceSession(sessionName);
  
  tabs.forEach(btn => {
    const tab = btn.dataset.tab;
    if (tab === 'positions' || tab === 'overtakes') {
      btn.style.display = isRace ? '' : 'none';
    }
  });

  // If current tab is hidden, fallback to results
  if (!isRace && (currentTab === 'positions' || currentTab === 'overtakes')) {
    currentTab = 'results';
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === 'results'));
  }
}

export async function loadRaceDetail(sessionKey, meetingInfo) {
  const section = $('#race-detail');
  const header = $('#race-detail-header');
  const content = $('#race-detail-content');
  const weatherBar = $('#race-weather-bar');
  const sessionDropdownContainer = $('#race-session-selector-container');
  const pillsContainer = $('#race-session-pills');

  const isCalendarActive = $('#calendar') && $('#calendar').classList.contains('active-tab');
  if (isCalendarActive) {
    section.style.display = 'block';
    section.classList.add('active-tab');
    section.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    section.style.display = 'none';
    section.classList.remove('active-tab');
  }
  header.innerHTML = `
    <div class="race-detail-title">${meetingInfo.meeting_name}</div>
    <div style="color:var(--text-muted);font-size:0.85rem;">${meetingInfo.circuit_short_name}, ${meetingInfo.country_name}</div>
  `;
  
  if (sessionDropdownContainer) {
    sessionDropdownContainer.style.display = 'none';
  }
  if (pillsContainer) {
    pillsContainer.innerHTML = '';
  }

  content.innerHTML = Array(5).fill('<div class="skeleton skeleton-row"></div>').join('');

  try {
    const year = meetingInfo.year || new Date(meetingInfo.date_start).getFullYear();

    // Trigger weather load instantly in background
    loadAndRenderWeather(sessionKey, weatherBar);

    // 1. Fetch season data, drivers list, and ALL meeting sessions in parallel
    let [seasonData, drivers, allMeetingSessions] = await Promise.all([
      getSeasonData(year),
      getSessionDrivers(sessionKey).catch(() => []),
      getMeetingSessions(meetingInfo.meeting_key),
    ]);

    // If main drivers fetch returned empty (common for ongoing weekends/future sessions), try to get drivers from other sessions of this weekend
    if (!drivers || drivers.length === 0) {
      const completedSessions = allMeetingSessions.filter(s => isPast(s.date_end) && !s.is_cancelled);
      const otherSessions = allMeetingSessions.filter(s => !s.is_cancelled);
      const candidates = [...completedSessions, ...otherSessions];
      for (const s of candidates) {
        if (s.session_key === sessionKey) continue;
        try {
          const tempDrivers = await getSessionDrivers(s.session_key);
          if (tempDrivers && tempDrivers.length > 0) {
            drivers = tempDrivers;
            break;
          }
        } catch { /* ignore */ }
      }
    }

    // Filter to completed sessions and sort by weekend chronological order
    const completedSessions = allMeetingSessions.filter(s => isPast(s.date_end) && !s.is_cancelled);
    completedSessions.sort((a, b) => {
      const orderA = SESSION_ORDER.indexOf(a.session_name);
      const orderB = SESSION_ORDER.indexOf(b.session_name);
      return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
    });



    // Build sessions map for quick lookup
    const sessions = {};
    for (const s of completedSessions) {
      // Enrich sessions with compiled results from season data (check both races and qualifying)
      const compiledRace = seasonData.races.find(r => r.session_key === s.session_key);
      const compiledQuali = !compiledRace && seasonData.qualifying
        ? seasonData.qualifying.find(q => q.session_key === s.session_key)
        : null;
      const compiled = compiledRace || compiledQuali;
      sessions[s.session_name] = {
        session_key: s.session_key,
        session_name: s.session_name,
        date_start: s.date_start,
        date_end: s.date_end,
        results: compiled ? compiled.results : [],
        drivers: compiled ? compiled.drivers : null,
      };
    }

    // Default to the Race session (or the initially clicked session)
    const defaultSessionName = sessions['Race'] ? 'Race' : (completedSessions.length > 0 ? completedSessions[completedSessions.length - 1].session_name : 'Race');
    const defaultSession = sessions[defaultSessionName] || { session_key: sessionKey, results: getResultsForSession(seasonData, sessionKey) };

    if (defaultSession.drivers && defaultSession.drivers.length > 0) {
      drivers = defaultSession.drivers;
    } else if (defaultSession.session_key && String(defaultSession.session_key) !== String(sessionKey)) {
      const defaultDrivers = await getSessionDrivers(defaultSession.session_key).catch(() => []);
      if (defaultDrivers && defaultDrivers.length > 0) {
        drivers = defaultDrivers;
      }
    }

    // Render session pills if there are multiple sessions
    if (completedSessions.length > 1 && pillsContainer) {
      pillsContainer.innerHTML = completedSessions.map(s => {
        const label = SESSION_LABELS[s.session_name] || s.session_name;
        const isActive = s.session_name === defaultSessionName;
        return `<button class="session-pill-btn ${isActive ? 'active' : ''}" data-session="${s.session_name}">${label}</button>`;
      }).join('');
      if (sessionDropdownContainer) {
        sessionDropdownContainer.style.display = 'flex';
      }

      // Add click handlers for the pills
      pillsContainer.querySelectorAll('.session-pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          pillsContainer.querySelectorAll('.session-pill-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          switchRaceDetailSession(btn.dataset.session);
        });
      });
    } else {
      if (sessionDropdownContainer) {
        sessionDropdownContainer.style.display = 'none';
      }
      if (pillsContainer) pillsContainer.innerHTML = '';
    }

    header.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; width:100%; flex-wrap:wrap; gap:16px;">
        <div>
          <div class="race-detail-title">${meetingInfo.meeting_name}</div>
          <div style="color:var(--text-muted);font-size:0.85rem; display:flex; align-items:center; gap:8px; margin-top:2px;">
            <span>${meetingInfo.circuit_short_name}, ${meetingInfo.country_name}</span>
            <span id="race-schedule-divider" style="color:rgba(255,255,255,0.06); display:none;">|</span>
            <button id="race-detail-schedule-btn" style="display:none; background:none; border:none; color:var(--f1-red); font-family:inherit; font-size:0.75rem; font-weight:700; cursor:pointer; padding:0; align-items:center; gap:4px; outline:none; transition:color var(--transition-fast);">
              <i class="fa-regular fa-calendar-days"></i> View Weekend Schedule
            </button>
            <span id="race-standings-divider" style="color:rgba(255,255,255,0.06); display:none;">|</span>
            <button id="race-detail-standings-btn" style="display:none; background:none; border:none; color:var(--text-secondary); font-family:inherit; font-size:0.75rem; font-weight:700; cursor:pointer; padding:0; align-items:center; gap:4px; outline:none; transition:color var(--transition-fast);">
              <i class="fa-solid fa-trophy"></i> Standings After Race
            </button>
            <span id="race-clear-cache-divider" style="color:rgba(255,255,255,0.06); display:none;">|</span>
            <button id="race-detail-clear-cache-btn" style="display:none; background:none; border:none; color:var(--text-muted); font-family:inherit; font-size:0.75rem; font-weight:700; cursor:pointer; padding:0; align-items:center; gap:4px; outline:none; transition:color var(--transition-fast);">
              <i class="fa-solid fa-arrows-rotate"></i> Clear Cache
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire up completed weekend schedule modal
    const scheduleBtn = document.getElementById('race-detail-schedule-btn');
    const scheduleDivider = document.getElementById('race-schedule-divider');

    if (scheduleBtn && completedSessions.length > 0) {
      if (scheduleDivider) scheduleDivider.style.display = 'inline';
      scheduleBtn.style.display = 'inline-flex';

      scheduleBtn.addEventListener('click', () => {
        showFutureRaceSchedule(meetingInfo);
      });
    }

    // Wire up standings after race button
    const standingsBtn = document.getElementById('race-detail-standings-btn');
    const standingsDivider = document.getElementById('race-standings-divider');

    if (standingsBtn && completedSessions.length > 0) {
      if (standingsDivider) standingsDivider.style.display = 'inline';
      standingsBtn.style.display = 'inline-flex';

      standingsBtn.addEventListener('click', () => {
        const completedRaces = (seasonData.races || []).filter(r => r.results && r.results.length > 0);
        const meetingsMap = new Map();
        for (const r of completedRaces) {
          if (!meetingsMap.has(r.meeting_key)) {
            meetingsMap.set(r.meeting_key, { meeting_key: r.meeting_key, date_end: r.date_end });
          }
        }
        const sorted = Array.from(meetingsMap.values()).sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
        const roundIdx = sorted.findIndex(m => String(m.meeting_key) === String(meetingInfo.meeting_key));
        const roundNum = roundIdx !== -1 ? roundIdx + 1 : null;

        window.location.hash = '#standings';
        if (roundNum) {
          setStandingsRound(roundNum);
        }
      });
    }

    // Wire up clear cache button
    const clearCacheBtn = document.getElementById('race-detail-clear-cache-btn');
    const clearCacheDivider = document.getElementById('race-clear-cache-divider');

    if (clearCacheBtn) {
      if (clearCacheDivider && completedSessions.length > 0) {
        clearCacheDivider.style.display = 'inline';
      }
      clearCacheBtn.style.display = 'inline-flex';

      clearCacheBtn.addEventListener('click', async () => {
        if (!confirm(`Are you sure you want to clear the cached data for the ${meetingInfo.meeting_name} weekend? This will force PitCorner to re-fetch the raw telemetry, laptimes, pit stops, and results directly from the live API.`)) {
          return;
        }

        clearCacheBtn.disabled = true;
        clearCacheBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Clearing...';

        try {
          const sessionKeys = allMeetingSessions.map(s => s.session_key);
          
          // Clear API responses from IndexedDB and memory
          await clearSessionsAPICache(sessionKeys);
          
          // Clear compiler results from IndexedDB and memory
          await clearMeetingCompilerCache(year, allMeetingSessions);

          // Update footer cache count
          const cacheInfo = document.getElementById('cache-info');
          if (cacheInfo) {
            const stats = await getCacheStats();
            cacheInfo.textContent = `💾 ${stats.localStorage} entries cached (${stats.localStorageKB} KB)`;
          }

          // Reload current race detail view with fresh network fetch
          await loadRaceDetail(sessionKey, meetingInfo);
        } catch (err) {
          console.error('[Race Detail] Clear cache failed:', err);
          alert('Failed to clear cache: ' + err.message);
          clearCacheBtn.disabled = false;
          clearCacheBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Clear Cache';
        }
      });
    }


    const order = defaultSession.results || [];
    const driverMap = buildDriverMap(drivers);

    // Initial minimal cache
    raceDataCache = { 
      sessionKey: defaultSession.session_key || sessionKey, 
      meetingInfo, 
      order, 
      drivers, 
      driverMap,
      sessions,
      currentSessionType: defaultSessionName,
      laps: null,
      stints: null,
      pits: null,
      overtakes: null,
      incidents: null,
      weather: null,
      intervals: null,
      driverTelemetry: {}
    };



    // Reset tab to results
    currentTab = 'results';
    const tabs = document.querySelectorAll('#race-detail-tabs button');
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === 'results'));

    // Update tab visibility for the default session type
    updateTabVisibility(defaultSessionName);

    renderTab();
    setupTabs();

    // 2. Background Enrichment: fetch detailed lap, pit, and overtake counts asynchronously
    const activeSessionKey = raceDataCache.sessionKey;
    Promise.all([
      getLaps({ session_key: activeSessionKey }),
      getPits({ session_key: activeSessionKey }),
      isRaceSession(defaultSessionName) ? getOvertakes({ session_key: activeSessionKey }) : Promise.resolve([]),
      isRaceSession(defaultSessionName) ? getIntervals({ session_key: activeSessionKey }) : Promise.resolve([]),
    ]).then(([laps, pits, overtakes, intervals]) => {
      // Safely update cache if we are still viewing the same race session
      if (raceDataCache && raceDataCache.sessionKey === activeSessionKey) {
        raceDataCache.laps = laps;
        raceDataCache.pits = pits;
        raceDataCache.overtakes = enrichOvertakesWithLaps(overtakes, laps);
        raceDataCache.intervals = intervals;
        
        // For qualifying sessions, always enrich the existing order with Q1/Q2/Q3 times from telemetry
        if (isQualifyingSession(raceDataCache.currentSessionType)) {
          const telemetryOrder = buildQualifyingOrder(laps, driverMap, raceDataCache.currentSessionType);
          if (raceDataCache.order && raceDataCache.order.length > 0) {
            const telemetryMap = new Map(telemetryOrder.map(r => [r.driver_number, r]));
            raceDataCache.order = raceDataCache.order.map(entry => {
              const tel = telemetryMap.get(entry.driver_number);
              return tel ? { ...entry, q1: tel.q1, q2: tel.q2, q3: tel.q3, bestLap: tel.bestLap || entry.bestLap } : entry;
            });
          } else {
            raceDataCache.order = telemetryOrder;
          }
        } else if (!isRaceSession(raceDataCache.currentSessionType) && (!raceDataCache.order || raceDataCache.order.length === 0)) {
          raceDataCache.order = buildQualifyingOrder(laps, driverMap, raceDataCache.currentSessionType);
        }
        
        // Dynamic pop-in: re-render results or overtakes tab if active
        if (currentTab === 'results') {
          renderResults(content);
        } else if (currentTab === 'overtakes') {
          renderOvertakes(content);
        }
      }
    }).catch(err => {
      console.warn('[Race Detail] Background enrichment skipped/failed:', err.message);
    });

  } catch (err) {
    console.error('Race detail load failed:', err);
    content.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load race data</div></div>';
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll('#race-detail-tabs button');
  tabs.forEach(btn => {
    // Clone to remove old listeners
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      document.querySelectorAll('#race-detail-tabs button').forEach(b => b.classList.remove('active'));
      newBtn.classList.add('active');
      currentTab = newBtn.dataset.tab;
      renderTab();
    });
  });
}

function renderTab() {
  const content = $('#race-detail-content');
  if (!raceDataCache) return;

  switch (currentTab) {
    case 'results': renderResults(content); break;
    case 'laptimes': loadAndRenderLapTimes(content); break;
    case 'positions': loadAndRenderPositions(content); break;
    case 'strategy': loadAndRenderStrategy(content); break;
    case 'overtakes': loadAndRenderOvertakes(content); break;
    case 'incidents': loadAndRenderIncidents(content); break;
    default: renderResults(content);
  }
}

function renderResults(container) {
  const { order, driverMap, laps, overtakes, pits } = raceDataCache;
  const sessionType = raceDataCache.currentSessionType;
  const isRace = isRaceSession(sessionType);

  // For non-race sessions, try to build order from laps if not set
  if (!isRace && (!order || order.length === 0) && laps && laps.length > 0) {
    raceDataCache.order = buildQualifyingOrder(laps, driverMap, sessionType);
    return renderResults(container); // Re-enter with populated order
  }

  if (!order || order.length === 0) {
    const sessionLabel = SESSION_LABELS[sessionType] || sessionType;
    container.innerHTML = `<div class="no-data"><div class="no-data-icon"><i class="fa-solid fa-car-side fa-3x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div><div class="no-data-text">No results data available for ${sessionLabel}</div></div>`;
    return;
  }

  if (isRace) {
    renderRaceResults(container);
  } else {
    renderSessionResults(container);
  }
}

/**
 * Render race/sprint results with full columns (Laps, Pts, Status, etc.)
 */
function renderRaceResults(container) {
  const { order, driverMap, laps, overtakes, pits } = raceDataCache;
  const gridMap = computeStartingGridMap();

  // 1. Calculate and correct driver lap counts using max lap number and backwards propagation
  const computedLapCounts = new Map();
  let maxSessionLap = 0;
  if (laps && laps.length > 0) {
    for (const { driver_number, status } of order) {
      if (status === 'DNS') {
        computedLapCounts.set(driver_number, 0);
      } else {
        const driverLaps = laps.filter(l => l.driver_number === driver_number);
        const maxLap = driverLaps.length > 0 ? Math.max(...driverLaps.map(l => l.lap_number || 0).filter(n => !isNaN(n))) : 0;
        computedLapCounts.set(driver_number, maxLap);
        if (maxLap > maxSessionLap) {
          maxSessionLap = maxLap;
        }
      }
    }

    const validOrder = order.filter(o => o.status !== 'DNS' && o.status !== 'DSQ');
    for (let i = validOrder.length - 2; i >= 0; i--) {
      const currentDriver = validOrder[i].driver_number;
      const nextDriver = validOrder[i + 1].driver_number;
      const currentLap = computedLapCounts.get(currentDriver) || 0;
      const nextLap = computedLapCounts.get(nextDriver) || 0;
      computedLapCounts.set(currentDriver, Math.max(currentLap, nextLap));
    }
  }

  // Find fastest lap + lap number
  let fastestLap = Infinity;
  let fastestLapDriver = null;
  let fastestLapNum = null;
  if (laps) {
    for (const lap of laps) {
      if (lap.lap_duration && !lap.is_pit_out_lap && lap.lap_number > 2 && lap.lap_duration < fastestLap) {
        fastestLap = lap.lap_duration;
        fastestLapDriver = lap.driver_number;
        fastestLapNum = lap.lap_number;
      }
    }
  }

  // Compute Biggest Mover & Attrition
  let biggestMoverDn = null;
  let biggestGain = 0;
  let biggestMoverStart = null;
  let biggestMoverEnd = null;
  let starters = 0;
  let classified = 0;
  let retirements = 0;

  for (const { driver_number, position, status } of order) {
    if (status !== 'DNS') {
      starters++;
      if (status === 'FINISHED') classified++;
      else if (status === 'DNF' || status === 'DSQ') retirements++;
    }
    if (status === 'FINISHED' && typeof position === 'number' && gridMap.has(driver_number)) {
      const gPos = gridMap.get(driver_number);
      const gain = gPos - position;
      if (gain > biggestGain) {
        biggestGain = gain;
        biggestMoverDn = driver_number;
        biggestMoverStart = gPos;
        biggestMoverEnd = position;
      }
    }
  }

  const totalLaps = laps ? maxSessionLap : '…';
  const leaderChanges = overtakes ? overtakes.filter(o => o.position === 1).length : '…';
  const overtakesCount = overtakes ? overtakes.length : '…';
  const flDriverObj = fastestLapDriver ? driverMap.get(fastestLapDriver) : null;
  const fastestLapTimeStr = fastestLap < Infinity ? formatLapTime(fastestLap) : '…';
  const flSubStr = flDriverObj ? `${flDriverObj.name_acronym}${fastestLapNum ? ` • L${fastestLapNum}` : ''}` : 'Session Best';
  const moverObj = biggestMoverDn ? driverMap.get(biggestMoverDn) : null;
  const moverVal = moverObj && biggestGain > 0 ? `${moverObj.name_acronym} +${biggestGain}` : '—';
  const moverSub = moverObj && biggestGain > 0 ? `P${biggestMoverStart} → P${biggestMoverEnd}` : 'Grid vs Flag';
  const totalStops = pits ? pits.length : '…';
  const avgStops = (pits && starters > 0) ? `${(pits.length / starters).toFixed(1)} avg/car` : 'Pit Lane';
  const hasGrid = gridMap.size > 0;

  let html = `
    <div class="rd-telemetry-kpi-grid">
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-flag-checkered"></i> Race Distance</div>
        <div class="rd-kpi-val">${totalLaps} <span>Laps</span></div>
        <div class="rd-kpi-sub">${classified}/${starters} Classified${retirements > 0 ? ` • ${retirements} Ret` : ''}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-arrows-left-right" style="color:#60a5fa;"></i> Track Action</div>
        <div class="rd-kpi-val">${overtakesCount}</div>
        <div class="rd-kpi-sub">${leaderChanges} Lead Change${leaderChanges === 1 ? '' : 's'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-stopwatch" style="color:#c084fc;"></i> Fastest Lap</div>
        <div class="rd-kpi-val mono" style="color:#c084fc;">${fastestLapTimeStr}</div>
        <div class="rd-kpi-sub">${flSubStr}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-rocket" style="color:#39b54a;"></i> Biggest Mover</div>
        <div class="rd-kpi-val" style="color:${biggestGain > 0 ? '#39b54a' : 'var(--text-primary)'};">${moverVal}</div>
        <div class="rd-kpi-sub">${moverSub}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-wrench" style="color:#fbbf24;"></i> Pit Stops</div>
        <div class="rd-kpi-val">${totalStops}</div>
        <div class="rd-kpi-sub">${avgStops}</div>
      </div>
    </div>
  `;

  html += `
    <div style="overflow-x:auto;">
    <table class="results-table">
      <thead>
        <tr>
          <th>Pos</th>
          <th>Driver</th>
          <th>Team</th>
          ${hasGrid ? '<th style="text-align:center;" title="Starting Grid &amp; Positions Gained/Lost">Grid / +/-</th>' : ''}
          <th>Laps</th>
          <th>Best Lap</th>
          <th>Pts</th>
          <th style="text-align:center;">Status</th>
        </tr>
      </thead>
      <tbody>
  `;

  const latestIntervals = new Map();
  if (raceDataCache.intervals && raceDataCache.intervals.length > 0) {
    for (const entry of raceDataCache.intervals) {
      const dn = entry.driver_number;
      const current = latestIntervals.get(dn);
      if (!current || new Date(entry.date) > new Date(current.date)) {
        latestIntervals.set(dn, entry);
      }
    }
  }

  for (const { driver_number, position, status, points } of order) {
    const d = driverMap.get(driver_number) || { name_acronym: `#${driver_number}`, team_name: '?', team_colour: '666', full_name: `Driver #${driver_number}`, headshot_url: '' };
    const teamColor = getTeamColor(d.team_colour);
    const { isFavD, isFavT } = isDriverOrTeamFavorite(d);

    const isDNS = status === 'DNS';
    const isDSQ = status === 'DSQ';
    const isDNF = status === 'DNF';

    const displayPos = isDNS ? 'DNS' : isDSQ ? 'DSQ' : position;
    const posClass = (isDNS || isDSQ) ? 'dns-badge' : (position <= 3 ? `p${position}` : '');

    const driverLaps = laps ? laps.filter(l => l.driver_number === driver_number && l.lap_duration && !l.is_pit_out_lap && l.lap_number > 2) : [];
    const bestLap = driverLaps.length > 0 ? Math.min(...driverLaps.map(l => l.lap_duration)) : null;
    const isFastest = laps ? driver_number === fastestLapDriver : false;
    const driverLapCount = laps ? (computedLapCounts.get(driver_number) ?? 0) : '…';
    const driverPits = pits ? pits.filter(p => p.driver_number === driver_number) : null;
    const isSprintSession = raceDataCache.currentSessionType === 'Sprint';
    const awardFastestLap = !isSprintSession && raceDataCache.meetingInfo.year < 2025;
    let pts = points !== undefined
      ? points
      : ((isDSQ || isDNS) ? 0 : getPointsForPosition(position, isSprintSession));
    if (points === undefined) {
      if (awardFastestLap && isFastest && position <= 10 && status === 'FINISHED') {
        pts += 1;
      }
    }

    // Grid / +/- badge
    let gridCellHtml = '';
    if (hasGrid) {
      const gPos = gridMap.get(driver_number);
      if (!gPos || isDNS) {
        gridCellHtml = `<td style="text-align:center;color:var(--text-muted);font-size:0.76rem;">—</td>`;
      } else {
        const diff = (!isDNF && !isDSQ && typeof position === 'number') ? (gPos - position) : 0;
        let deltaHtml = '<span class="rd-pos-delta neutral">0</span>';
        if (!isDNF && !isDSQ) {
          if (diff > 0) deltaHtml = `<span class="rd-pos-delta up">▲${diff}</span>`;
          else if (diff < 0) deltaHtml = `<span class="rd-pos-delta down">▼${Math.abs(diff)}</span>`;
        } else {
          deltaHtml = '';
        }
        gridCellHtml = `<td style="text-align:center;white-space:nowrap;"><span class="mono" style="font-size:0.75rem;color:var(--text-muted);">P${gPos}</span> ${deltaHtml}</td>`;
      }
    }

    let statusText = '—';
    if (isDNS) {
      statusText = '<span style="color:var(--text-muted);background:rgba(255,255,255,0.05);border:1px dashed var(--border-subtle);padding:2px 8px;border-radius:100px;font-size:0.68rem;font-weight:700;">DNS</span>';
    } else if (isDSQ) {
      statusText = '<span style="color:var(--f1-red);background:rgba(239,68,68,0.1);border:1px solid var(--f1-red);padding:2px 8px;border-radius:100px;font-size:0.68rem;font-weight:700;">DSQ</span>';
    } else if (isDNF) {
      statusText = '<span style="color:#f87171;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);padding:2px 8px;border-radius:100px;font-size:0.68rem;font-weight:700;">DNF</span>';
    } else {
      if (position === 1) {
        statusText = '<span style="color:#ffd700;font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Winner</span>';
      } else {
        const entry = latestIntervals.get(driver_number);
        const maxLaps = laps ? maxSessionLap : 0;
        const lapsDiff = maxLaps - driverLapCount;

        if (laps && lapsDiff > 0 && lapsDiff < 10) {
          statusText = `<span style="color:var(--text-secondary);font-size:0.72rem;font-weight:600;">+${lapsDiff} Lap${lapsDiff > 1 ? 's' : ''}</span>`;
        } else if (entry && entry.gap_to_leader != null) {
          const gapVal = parseFloat(entry.gap_to_leader);
          if (!isNaN(gapVal)) {
            statusText = `<span style="color:var(--text-secondary);font-size:0.75rem;font-family:'JetBrains Mono',monospace;">+${gapVal.toFixed(3)}s</span>`;
          } else {
            const stops = driverPits ? driverPits.length : 0;
            statusText = `<span style="color:var(--text-secondary);font-size:0.75rem;">${stops} Stop${stops !== 1 ? 's' : ''}</span>`;
          }
        } else {
          const stops = driverPits ? driverPits.length : 0;
          statusText = `<span style="color:var(--text-secondary);font-size:0.75rem;">${stops} Stop${stops !== 1 ? 's' : ''}</span>`;
        }
      }
    }

    const isMover = driver_number === biggestMoverDn && biggestGain >= 3;
    const rowFavClass = isFavD ? 'fav-pinned-row' : (isFavT ? 'fav-team-member-row' : '');

    html += `
      <tr class="clickable-driver-row ${rowFavClass}" data-driver-number="${driver_number}" style="cursor:pointer;" title="Click for driver race deep-dive stats">
        <td><span class="position-badge ${posClass}">${displayPos}</span></td>
        <td>
          <div class="driver-cell">
            <div class="team-color-bar" style="background:${teamColor}"></div>
            <img class="driver-headshot" src="${d.headshot_url || ''}" alt="${d.name_acronym}" loading="lazy" onerror="this.style.display='none'" style="width:32px;height:32px;">
            <div class="driver-info">
              <div class="driver-name" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span>${d.full_name || d.name_acronym}</span>
                ${isFavD ? '<i class="fa-solid fa-star fav-inline-star" title="Pinned Favorite Driver"></i>' : ''}
                ${isMover ? `<span class="rd-mover-pill" title="Biggest Mover (+${biggestGain} positions)">🚀 +${biggestGain}</span>` : ''}
              </div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-muted);font-size:0.8rem;">${d.team_name}${isFavT && !isFavD ? ' <i class="fa-solid fa-star fav-inline-star" style="opacity:0.7;font-size:0.62rem;" title="Pinned Favorite Team"></i>' : ''}</td>
        ${gridCellHtml}
        <td class="mono" style="font-size:0.8rem;">${driverLapCount}</td>
        <td class="mono ${isFastest ? 'fastest-lap' : ''}" style="font-size:0.8rem;">${isDNS ? '—' : (bestLap ? formatLapTime(bestLap) : '…')} ${isFastest ? '<span style="color:#a855f7;font-size:0.65rem;margin-left:4px;" title="Fastest Lap">🟣</span>' : ''}</td>
        <td class="points-cell" style="color:${pts > 0 ? 'var(--text-primary)' : 'var(--text-muted)'}">${pts || '—'}${awardFastestLap && isFastest && position <= 10 ? '<span style="color:#a855f7;font-size:0.65rem;margin-left:4px;" title="Includes +1 fastest lap bonus">+1</span>' : ''}</td>
        <td style="text-align:center;">${statusText}</td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  container.innerHTML = html;

  bindDriverRowClicks(container);
}

/**
 * Render qualifying/practice session results — ranked by best lap time with segment highlights & knockout zones
 */
function renderSessionResults(container) {
  const { order, driverMap, laps } = raceDataCache;
  const sessionType = raceDataCache.currentSessionType;
  const sessionLabel = SESSION_LABELS[sessionType] || sessionType;
  const isQuali = isQualifyingSession(sessionType);

  const driverBestLaps = new Map();
  const driverLapCounts = new Map();
  if (laps && laps.length > 0) {
    for (const lap of laps) {
      const dn = lap.driver_number;
      driverLapCounts.set(dn, (driverLapCounts.get(dn) || 0) + 1);
      if (!lap.lap_duration || lap.lap_duration <= 0) continue;
      const current = driverBestLaps.get(dn);
      if (!current || lap.lap_duration < current) {
        driverBestLaps.set(dn, lap.lap_duration);
      }
    }
  }

  const p1Best = order.length > 0 && order[0].bestLap ? order[0].bestLap : (driverBestLaps.size > 0 ? Math.min(...driverBestLaps.values()) : null);
  const p1Driver = order.length > 0 ? driverMap.get(order[0].driver_number) : null;

  // Segment fastest times for Q1, Q2, Q3 purple highlights
  let bestQ1 = Infinity, bestQ2 = Infinity, bestQ3 = Infinity;
  if (isQuali) {
    for (const entry of order) {
      if (entry.q1 && entry.q1 < bestQ1) bestQ1 = entry.q1;
      if (entry.q2 && entry.q2 < bestQ2) bestQ2 = entry.q2;
      if (entry.q3 && entry.q3 < bestQ3) bestQ3 = entry.q3;
    }
  }

  // Mileage leader & Top-10 spread
  let mostLapsDn = null;
  let mostLapsVal = 0;
  for (const entry of order) {
    const lc = entry.lapCount || driverLapCounts.get(entry.driver_number) || 0;
    if (lc > mostLapsVal) {
      mostLapsVal = lc;
      mostLapsDn = entry.driver_number;
    }
  }
  const mileageDriver = mostLapsDn ? driverMap.get(mostLapsDn) : null;
  const p10Entry = order[Math.min(9, order.length - 1)];
  const p10Time = p10Entry ? (p10Entry.q3 || p10Entry.bestLap || driverBestLaps.get(p10Entry.driver_number)) : null;
  const top10Spread = (p1Best && p10Time && p10Time >= p1Best) ? `+${(p10Time - p1Best).toFixed(3)}s` : '—';
  const cutoff107 = (isQuali && bestQ1 < Infinity) ? formatLapTime(bestQ1 * 1.07) : null;

  const driverCount = order.length;
  const totalLaps = laps ? laps.length : '…';
  const bestTimeStr = p1Best ? formatLapTime(p1Best) : '…';

  let html = `
    <div class="rd-telemetry-kpi-grid">
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-stopwatch" style="color:#c084fc;"></i> ${isQuali ? 'Pole / P1 Time' : 'Session Best'}</div>
        <div class="rd-kpi-val mono" style="color:#c084fc;">${bestTimeStr}</div>
        <div class="rd-kpi-sub">${p1Driver ? p1Driver.name_acronym : sessionLabel}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-arrows-left-right" style="color:#60a5fa;"></i> Top-10 Spread</div>
        <div class="rd-kpi-val mono">${top10Spread}</div>
        <div class="rd-kpi-sub">P1 to P${Math.min(10, order.length)} Margin</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-road" style="color:#39b54a;"></i> Total Mileage</div>
        <div class="rd-kpi-val">${totalLaps} <span>Laps</span></div>
        <div class="rd-kpi-sub">${mileageDriver ? `Most: ${mileageDriver.name_acronym} (${mostLapsVal}L)` : `${driverCount} Cars`}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-gauge-high" style="color:#fbbf24;"></i> ${cutoff107 ? '107% Q1 Rule' : 'Classification'}</div>
        <div class="rd-kpi-val mono">${cutoff107 || `${driverCount} Cars`}</div>
        <div class="rd-kpi-sub">${sessionLabel} Session</div>
      </div>
    </div>
  `;

  let headersHtml = '';
  if (isQuali) {
    headersHtml = `
      <tr>
        <th>Pos</th>
        <th>Driver</th>
        <th>Team</th>
        <th>Q1</th>
        <th>Q2</th>
        <th>Q3</th>
        <th style="text-align:center;">Gap</th>
        <th>Laps</th>
      </tr>
    `;
  } else {
    headersHtml = `
      <tr>
        <th>Pos</th>
        <th>Driver</th>
        <th>Team</th>
        <th>Best Lap</th>
        <th style="text-align:center;">Gap</th>
        <th>Laps</th>
      </tr>
    `;
  }

  html += `
    <div style="overflow-x:auto;">
    <table class="results-table">
      <thead>
        ${headersHtml}
      </thead>
      <tbody>
  `;

  for (let idx = 0; idx < order.length; idx++) {
    const entry = order[idx];
    const { driver_number, position, status } = entry;
    const d = driverMap.get(driver_number) || { name_acronym: `#${driver_number}`, team_name: '?', team_colour: '666', full_name: `Driver #${driver_number}`, headshot_url: '' };
    const teamColor = getTeamColor(d.team_colour);
    const { isFavD, isFavT } = isDriverOrTeamFavorite(d);
    const rowFavClass = isFavD ? 'fav-pinned-row' : (isFavT ? 'fav-team-member-row' : '');

    const isDNS = status === 'DNS';
    const displayPos = isDNS ? 'DNS' : position;
    const posClass = isDNS ? 'dns-badge' : (position <= 3 ? `p${position}` : '');
    const lapCount = entry.lapCount || driverLapCounts.get(driver_number) || 0;

    let rowContent = '';
    if (isQuali) {
      const q1Purp = entry.q1 && entry.q1 === bestQ1;
      const q2Purp = entry.q2 && entry.q2 === bestQ2;
      const q3Purp = entry.q3 && entry.q3 === bestQ3;
      const q1Str = entry.q1 ? `<span style="${q1Purp ? 'color:#c084fc;font-weight:800;' : ''}">${formatLapTime(entry.q1)}${q1Purp ? ' 🟣' : ''}</span>` : '<span style="color:var(--text-muted);">—</span>';
      const q2Str = entry.q2 ? `<span style="${q2Purp ? 'color:#c084fc;font-weight:800;' : ''}">${formatLapTime(entry.q2)}${q2Purp ? ' 🟣' : ''}</span>` : '<span style="color:var(--text-muted);">—</span>';
      const q3Str = entry.q3 ? `<span style="${q3Purp ? 'color:#c084fc;font-weight:800;' : ''}">${formatLapTime(entry.q3)}${q3Purp ? ' 🟣' : ''}</span>` : '<span style="color:var(--text-muted);">—</span>';

      const refBest = entry.q3 || entry.q2 || entry.q1;
      const poleRef = bestQ3 < Infinity ? bestQ3 : p1Best;
      let qGapHtml = '<span style="color:var(--text-muted);">—</span>';
      if (position === 1 && refBest) {
        qGapHtml = '<span style="color:#ffd700;font-size:0.72rem;font-weight:800;">POLE</span>';
      } else if (entry.q3 && poleRef && entry.q3 >= poleRef) {
        qGapHtml = `<span class="mono" style="font-size:0.75rem;color:var(--text-secondary);">+${(entry.q3 - poleRef).toFixed(3)}s</span>`;
      } else if (refBest && bestQ1 < Infinity && !entry.q3) {
        qGapHtml = `<span class="mono" style="font-size:0.72rem;color:var(--text-muted);" title="Eliminated in ${entry.q2 ? 'Q2' : 'Q1'}">${entry.q2 ? 'OUT Q2' : 'OUT Q1'}</span>`;
      }

      rowContent = `
        <td class="mono" style="font-size:0.8rem;">${q1Str}</td>
        <td class="mono" style="font-size:0.8rem;">${q2Str}</td>
        <td class="mono" style="font-size:0.8rem;">${q3Str}</td>
        <td style="text-align:center;">${qGapHtml}</td>
      `;
    } else {
      const bestLap = entry.bestLap || driverBestLaps.get(driver_number) || null;
      const isFastest = position === 1;
      let gapText = '<span style="color:var(--text-muted);">—</span>';
      if (position === 1 && bestLap) {
        gapText = '<span style="color:#ffd700;font-size:0.72rem;font-weight:700;text-transform:uppercase;">P1</span>';
      } else if (bestLap && p1Best) {
        gapText = `<span style="color:var(--text-secondary);font-size:0.8rem;font-family:'JetBrains Mono',monospace;">+${(bestLap - p1Best).toFixed(3)}s</span>`;
      }

      rowContent = `
        <td class="mono ${isFastest ? 'fastest-lap' : ''}" style="font-size:0.8rem;">${bestLap ? formatLapTime(bestLap) : '—'} ${isFastest ? '<span style="color:#a855f7;font-size:0.65rem;margin-left:4px;" title="Fastest">🟣</span>' : ''}</td>
        <td style="text-align:center;">${gapText}</td>
      `;
    }

    html += `
      <tr class="clickable-driver-row ${rowFavClass}" data-driver-number="${driver_number}" style="cursor:pointer;" title="Click for driver session deep-dive stats">
        <td><span class="position-badge ${posClass}">${displayPos}</span></td>
        <td>
          <div class="driver-cell">
            <div class="team-color-bar" style="background:${teamColor}"></div>
            <img class="driver-headshot" src="${d.headshot_url || ''}" alt="${d.name_acronym}" loading="lazy" onerror="this.style.display='none'" style="width:32px;height:32px;">
            <div class="driver-info">
              <div class="driver-name" style="display:flex;align-items:center;gap:6px;">
                <span>${d.full_name || d.name_acronym}</span>
                ${isFavD ? '<i class="fa-solid fa-star fav-inline-star" title="Pinned Favorite Driver"></i>' : ''}
              </div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-muted);font-size:0.8rem;">${d.team_name}</td>
        ${rowContent}
        <td class="mono" style="font-size:0.8rem;color:var(--text-muted);">${lapCount}</td>
      </tr>
    `;

    if (isQuali && order.length >= 16 && (position === 10 || position === 15)) {
      const label = position === 10 ? 'Q3 Shootout Cutoff — Top 10 Advance' : 'Q2 Elimination Cutoff — Top 15 Advance';
      html += `<tr class="quali-cutoff-row"><td colspan="8"><span>${label}</span></td></tr>`;
    }
  }

  html += '</tbody></table></div>';
  container.innerHTML = html;

  bindDriverRowClicks(container);
}

/**
 * Bind driver row click events for deep-dive modal
 */
function bindDriverRowClicks(container) {
  const rows = container.querySelectorAll('.clickable-driver-row');
  rows.forEach(row => {
    row.addEventListener('click', () => {
      const dn = parseInt(row.dataset.driverNumber, 10);
      showRaceDriverDetail(dn);
    });
  });
}


// ── Lazy-Load Tab Wrappers ──

async function loadAndRenderLapTimes(container) {
  if (raceDataCache.laps) {
    renderLapTimes(container);
    return;
  }
  container.innerHTML = Array(4).fill('<div class="skeleton skeleton-row"></div>').join('');
  try {
    const laps = await getLaps({ session_key: raceDataCache.sessionKey });
    raceDataCache.laps = laps;
    renderLapTimes(container);
  } catch (e) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load lap times. Please try again.</div></div>';
  }
}

async function loadAndRenderPositions(container) {
  if (raceDataCache.laps) {
    renderPositions(container);
    return;
  }
  container.innerHTML = Array(4).fill('<div class="skeleton skeleton-row"></div>').join('');
  try {
    const laps = await getLaps({ session_key: raceDataCache.sessionKey });
    raceDataCache.laps = laps;
    renderPositions(container);
  } catch (e) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load position charts. Please try again.</div></div>';
  }
}

async function loadAndRenderStrategy(container) {
  if (raceDataCache.stints && raceDataCache.pits) {
    renderStrategy(container);
    return;
  }
  container.innerHTML = Array(4).fill('<div class="skeleton skeleton-row"></div>').join('');
  try {
    const [stints, pits, laps] = await Promise.all([
      getStints({ session_key: raceDataCache.sessionKey }),
      getPits({ session_key: raceDataCache.sessionKey }),
      raceDataCache.laps ? Promise.resolve(raceDataCache.laps) : getLaps({ session_key: raceDataCache.sessionKey })
    ]);
    raceDataCache.stints = stints;
    raceDataCache.pits = pits;
    raceDataCache.laps = laps;
    renderStrategy(container);
  } catch (e) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load strategy details. Please try again.</div></div>';
  }
}

async function loadAndRenderOvertakes(container) {
  if (raceDataCache.overtakes && raceDataCache.laps) {
    raceDataCache.overtakes = enrichOvertakesWithLaps(raceDataCache.overtakes, raceDataCache.laps);
    renderOvertakes(container);
    return;
  }
  container.innerHTML = Array(4).fill('<div class="skeleton skeleton-row"></div>').join('');
  try {
    const [overtakes, laps] = await Promise.all([
      raceDataCache.overtakes ? Promise.resolve(raceDataCache.overtakes) : getOvertakes({ session_key: raceDataCache.sessionKey }),
      raceDataCache.laps ? Promise.resolve(raceDataCache.laps) : getLaps({ session_key: raceDataCache.sessionKey })
    ]);
    raceDataCache.laps = laps;
    raceDataCache.overtakes = enrichOvertakesWithLaps(overtakes, laps);
    renderOvertakes(container);
  } catch (e) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load overtakes feed. Please try again.</div></div>';
  }
}

// ── Tab Renderers ──

function getOrCreateGlobalTooltip() {
  let tooltip = document.getElementById('global-chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'global-chart-tooltip';
    tooltip.style = `
      display: none;
      position: fixed;
      z-index: 99999;
      pointer-events: none;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(15, 15, 26, 0.96);
      box-shadow: 0 10px 32px rgba(0,0,0,0.75);
      font-family: inherit;
      font-size: 0.75rem;
      min-width: 140px;
    `;
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function initInteractiveChart(canvas, tooltip, chartType, isEnlarged = false) {
  const { laps, order, driverMap } = raceDataCache;
  const isLap = chartType === 'laptimes';

  const selected = isLap 
    ? raceDataCache.selectedLapDrivers 
    : raceDataCache.selectedPositionDrivers;

  const zoom = isLap 
    ? (raceDataCache.lapTimesZoom || { start: 1, end: null })
    : (raceDataCache.positionsZoom || { start: 1, end: null });

  const maxLap = Math.max(...laps.map(l => l.lap_number).filter(n => !isNaN(n)), 1);
  const start = zoom.start || 1;
  const end = zoom.end || maxLap;

  // Build X-axis labels for the zoomed range
  const xLabels = [];
  for (let l = start; l <= end; l++) {
    xLabels.push(l);
  }
  const maxLen = xLabels.length;

  // Build cumulative position rankings if positions chart
  let positionsByLap = null;
  if (!isLap) {
    const allDriversInSession = [...new Set(laps.map(l => l.driver_number))];
    const driverCumTime = new Map();
    for (const dn of allDriversInSession) {
      const dLaps = laps.filter(l => l.driver_number === dn).sort((a, b) => a.lap_number - b.lap_number);
      let cumTime = 0;
      const cumArr = [];
      for (const l of dLaps) {
        cumTime += (l.lap_duration || 200);
        cumArr.push({ lap: l.lap_number, cumTime });
      }
      driverCumTime.set(dn, cumArr);
    }

    positionsByLap = new Map();
    for (const dn of allDriversInSession) {
      positionsByLap.set(dn, new Array(maxLap).fill(null));
    }

    for (let lap = 1; lap <= maxLap; lap++) {
      const rankings = [];
      for (const dn of allDriversInSession) {
        const cumArr = driverCumTime.get(dn);
        const entry = cumArr.find(c => c.lap === lap);
        if (entry) {
          rankings.push({ dn, cumTime: entry.cumTime });
        }
      }
      rankings.sort((a, b) => a.cumTime - b.cumTime);
      rankings.forEach((r, idx) => {
        const arr = positionsByLap.get(r.dn);
        if (arr) arr[lap - 1] = idx + 1;
      });
    }
  }

  function getFilteredDatasets() {
    return Array.from(selected).map(driver_number => {
      const d = driverMap.get(driver_number) || {};
      let rawData = [];
      if (isLap) {
        const cleanMode = raceDataCache.cleanPaceMode !== false;
        let sessionBest = Infinity;
        if (cleanMode) {
          for (const sl of laps) {
            if (sl.lap_duration > 0 && !sl.is_pit_out_lap && sl.lap_number > 1 && sl.lap_duration < sessionBest) {
              sessionBest = sl.lap_duration;
            }
          }
        }
        const outlierCap = sessionBest < Infinity ? sessionBest * 1.14 : Infinity;
        const driverLaps = laps.filter(l => l.driver_number === driver_number);
        rawData = new Array(maxLap).fill(null);
        for (const l of driverLaps) {
          if (l.lap_duration && !l.is_pit_out_lap && l.lap_number > 1) {
            if (!cleanMode || l.lap_duration <= outlierCap) {
              rawData[l.lap_number - 1] = l.lap_duration;
            }
          }
        }
      } else {
        rawData = positionsByLap.get(driver_number) || [];
      }

      // Slice the data to the zoomed range [start - 1, end - 1]
      const slicedData = rawData.slice(start - 1, end);

      return {
        label: d.name_acronym || `#${driver_number}`,
        driver_number,
        data: slicedData,
        color: getTeamColor(d.team_colour),
        alpha: isLap ? 0.7 : 0.85,
      };
    });
  }

  function draw(hoveredIndex = undefined) {
    const datasets = getFilteredDatasets();
    const drawFunc = isLap ? drawLineChart : drawPositionChart;
    drawFunc(canvas, datasets, { xLabel: 'Lap', hoveredIndex, xLabels });
  }

  // Bind mouse hover tooltip
  if (canvas && tooltip) {
    const onMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const padLeft = 60;
      const padRight = 20;
      const plotW = rect.width - padLeft - padRight;

      if (mouseX >= padLeft && mouseX <= rect.width - padRight) {
        const plotX = mouseX - padLeft;
        const ratio = plotX / plotW;
        const hoveredIndex = Math.round(ratio * (maxLen - 1));

        if (hoveredIndex >= 0 && hoveredIndex < maxLen) {
          draw(hoveredIndex);

          // Get actual lap number from xLabels
          const lapNumber = xLabels[hoveredIndex];
          const datasets = getFilteredDatasets();

          const lapValues = datasets
            .map(ds => {
              const val = ds.data[hoveredIndex];
              return {
                label: ds.label,
                color: ds.color,
                val
              };
            })
            .filter(item => item.val != null)
            .sort((a, b) => a.val - b.val);

          if (lapValues.length > 0) {
            let tooltipHtml = `<div style="font-weight:700; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:4px; margin-bottom:6px; color:#fff;">Lap ${lapNumber}</div>`;
            tooltipHtml += `<div style="display:flex; flex-direction:column; gap:4px;">`;
            lapValues.forEach(item => {
              const valStr = isLap ? formatLapTime(item.val) : `P${item.val}`;
              tooltipHtml += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                <span style="display:inline-flex; align-items:center; gap:6px;">
                  <span style="width:6px; height:6px; background:${item.color}; border-radius:50%; display:inline-block;"></span>
                  <span style="color:var(--text-secondary);font-weight:600;">${item.label}</span>
                </span>
                <span style="font-family:\'JetBrains Mono\',monospace; color:#fff; font-weight:700;">${valStr}</span>
              </div>`;
            });
            tooltipHtml += `</div>`;

            tooltip.innerHTML = tooltipHtml;
            tooltip.style.display = 'block';

            // Position tooltip globally relative to viewport to avoid z-index & overflow clipping!
            const tooltipRect = tooltip.getBoundingClientRect();
            let tooltipX = e.clientX + 15;
            let tooltipY = e.clientY + 15;

            // Prevent tooltip from overflowing the viewport boundaries
            if (tooltipX + tooltipRect.width > window.innerWidth) {
              tooltipX = e.clientX - tooltipRect.width - 15;
            }
            if (tooltipY + tooltipRect.height > window.innerHeight) {
              tooltipY = e.clientY - tooltipRect.height - 15;
            }

            tooltip.style.left = `${tooltipX}px`;
            tooltip.style.top = `${tooltipY}px`;
          } else {
            tooltip.style.display = 'none';
          }
        } else {
          tooltip.style.display = 'none';
          draw(undefined);
        }
      } else {
        tooltip.style.display = 'none';
        draw(undefined);
      }
    };

    const onMouseLeave = () => {
      tooltip.style.display = 'none';
      draw(undefined);
    };

    // Remove old listeners by replacing canvas
    const newCanvas = canvas.cloneNode(true);
    canvas.parentNode.replaceChild(newCanvas, canvas);
    canvas = newCanvas;

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);

    // Initial draw
    draw(undefined);
  }
}

function openEnlargedChartModal(chartType) {
  const isLap = chartType === 'laptimes';
  const { laps, order, driverMap } = raceDataCache;

  const selected = isLap 
    ? raceDataCache.selectedLapDrivers 
    : raceDataCache.selectedPositionDrivers;

  const zoom = isLap 
    ? raceDataCache.lapTimesZoom 
    : raceDataCache.positionsZoom;

  const maxLap = Math.max(...laps.map(l => l.lap_number).filter(n => !isNaN(n)), 1);

  // Create full screen overlay modal
  const modal = document.createElement('div');
  modal.id = 'enlarged-chart-modal';
  modal.style = `
    position: fixed;
    top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(10, 10, 18, 0.98);
    z-index: 10000;
    display: flex;
    flex-direction: column;
    padding: 24px;
    box-sizing: border-box;
    font-family: inherit;
  `;

  // Get unique drivers
  const allDriversInSession = [...new Set(laps.map(l => l.driver_number))];
  const sessionDriversSorted = order
    .filter(o => allDriversInSession.includes(o.driver_number))
    .map(o => o.driver_number);
  for (const dn of allDriversInSession) {
    if (!sessionDriversSorted.includes(dn)) {
      sessionDriversSorted.push(dn);
    }
  }

  // Generate selector pills HTML
  const pillsHtml = sessionDriversSorted.map(dn => {
    const d = driverMap.get(dn) || {};
    const acronym = d.name_acronym || `#${dn}`;
    const color = getTeamColor(d.team_colour);
    const isChecked = selected.has(dn);
    const activeStyle = isChecked 
      ? `background:${color}22; border-color:${color}; color:#fff; font-weight:700;` 
      : `background:rgba(255,255,255,0.01); border-color:rgba(255,255,255,0.06); color:var(--text-muted);`;

    return `<button class="modal-driver-filter-pill" data-driver="${dn}" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border:1px solid; border-radius:100px; font-family:inherit; font-size:0.75rem; transition:all var(--transition-fast); ${activeStyle}">
      <span style="width:8px; height:8px; background:${color}; border-radius:50%; display:inline-block;"></span>
      ${acronym}
    </button>`;
  }).join('');

  // Dropdown options
  let startOptionsHtml = '';
  let endOptionsHtml = '';
  for (let l = 1; l <= maxLap; l++) {
    startOptionsHtml += `<option value="${l}" ${zoom.start === l ? 'selected' : ''}>Lap ${l}</option>`;
    endOptionsHtml += `<option value="${l}" ${zoom.end === l ? 'selected' : ''}>Lap ${l}</option>`;
  }

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:12px;">
      <div style="font-family:'Outfit',sans-serif; font-size:1.5rem; font-weight:800; color:#fff;">
        ${isLap ? 'Lap Times' : 'Position Changes'} — Enlarged Focus View
      </div>
      <button id="modal-close-btn" style="background:none; border:none; color:#fff; font-size:1.8rem; cursor:pointer; outline:none; transition:color 150ms ease;">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>

    <div style="display:flex; align-items:center; gap:20px; margin-bottom:16px; flex-wrap:wrap; font-size:0.8rem; border-bottom:1px dashed rgba(255,255,255,0.06); padding-bottom:12px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="color:var(--text-muted); font-weight:600;"><i class="fa-solid fa-magnifying-glass-plus"></i> Zoom Focus Section:</span>
        <select id="modal-zoom-start" style="background:var(--bg-secondary); border:1px solid var(--border-subtle); color:#fff; border-radius:4px; padding:4px 10px; font-family:inherit; outline:none; cursor:pointer;">
          ${startOptionsHtml}
        </select>
        <span style="color:var(--text-muted);">to</span>
        <select id="modal-zoom-end" style="background:var(--bg-secondary); border:1px solid var(--border-subtle); color:#fff; border-radius:4px; padding:4px 10px; font-family:inherit; outline:none; cursor:pointer;">
          ${endOptionsHtml}
        </select>
      </div>
      <button id="modal-zoom-reset" style="background:none; border:none; color:var(--f1-red); font-family:inherit; cursor:pointer; font-weight:700; padding:0; display:inline-flex; align-items:center; gap:4px; outline:none;">
        <i class="fa-solid fa-rotate-left"></i> Reset Zoom Focus
      </button>
    </div>

    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:12px; font-weight:600;">Filter drivers on chart:</div>
    <div class="modal-pills-container" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px; overflow-y:auto; max-height:80px; padding:4px 0;">
      ${pillsHtml}
    </div>

    <div style="flex:1; width:100%; min-height:0; position:relative; display:flex; justify-content:center;">
      <canvas id="modal-chart-canvas" style="width:100%; height:100%; cursor:crosshair;"></canvas>
    </div>
  `;

  document.body.appendChild(modal);

  const canvas = document.getElementById('modal-chart-canvas');
  const tooltip = getOrCreateGlobalTooltip();

  const drawModal = () => {
    initInteractiveChart(document.getElementById('modal-chart-canvas'), tooltip, chartType, true);
  };

  const close = () => {
    document.removeEventListener('keydown', onEsc);
    modal.remove();
    tooltip.style.display = 'none';
    
    // Re-draw standard page view to refresh it
    const pageContent = document.getElementById('race-detail-content');
    if (isLap) renderLapTimes(pageContent);
    else renderPositions(pageContent);
  };

  const onEsc = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onEsc);

  document.getElementById('modal-close-btn').addEventListener('click', close);

  // Wire modal pills clicking
  modal.querySelectorAll('.modal-driver-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const dn = parseInt(pill.dataset.driver, 10);
      if (selected.has(dn)) {
        if (selected.size > 1) selected.delete(dn);
      } else {
        selected.add(dn);
      }
      
      // Update pill classes styling
      modal.querySelectorAll('.modal-driver-filter-pill').forEach(p => {
        const pDn = parseInt(p.dataset.driver, 10);
        const pColor = getTeamColor(driverMap.get(pDn).team_colour);
        const isChecked = selected.has(pDn);
        p.style.cssText = isChecked 
          ? `cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border:1px solid; border-radius:100px; font-family:inherit; font-size:0.75rem; transition:all var(--transition-fast); background:${pColor}22; border-color:${pColor}; color:#fff; font-weight:700;` 
          : `cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border:1px solid; border-radius:100px; font-family:inherit; font-size:0.75rem; transition:all var(--transition-fast); background:rgba(255,255,255,0.01); border-color:rgba(255,255,255,0.06); color:var(--text-muted);`;
      });
      drawModal();
    });
  });

  // Wire modal zoom changes
  const mStart = document.getElementById('modal-zoom-start');
  const mEnd = document.getElementById('modal-zoom-end');
  const mReset = document.getElementById('modal-zoom-reset');

  const onModalZoomChange = () => {
    let sVal = parseInt(mStart.value, 10);
    let eVal = parseInt(mEnd.value, 10);
    if (sVal > eVal) {
      eVal = sVal;
      mEnd.value = sVal;
    }
    zoom.start = sVal;
    zoom.end = eVal;
    drawModal();
  };

  mStart.addEventListener('change', onModalZoomChange);
  mEnd.addEventListener('change', onModalZoomChange);

  mReset.addEventListener('click', () => {
    zoom.start = 1;
    zoom.end = maxLap;
    mStart.value = 1;
    mEnd.value = maxLap;
    drawModal();
  });

  // Trigger initial draw
  drawModal();
}

function renderLapTimes(container) {
  const { laps, order, driverMap } = raceDataCache;

  if (!laps || laps.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">No lap time data available</div></div>';
    return;
  }

  const allDriversInSession = [...new Set(laps.map(l => l.driver_number))];
  const sessionDriversSorted = order
    .filter(o => allDriversInSession.includes(o.driver_number))
    .map(o => o.driver_number);
  for (const dn of allDriversInSession) {
    if (!sessionDriversSorted.includes(dn)) {
      sessionDriversSorted.push(dn);
    }
  }

  if (raceDataCache.cleanPaceMode === undefined) {
    raceDataCache.cleanPaceMode = true;
  }

  // Default: top 8 + any pinned favorite driver/team
  if (!raceDataCache.selectedLapDrivers) {
    const initial = new Set(sessionDriversSorted.slice(0, 8));
    for (const dn of sessionDriversSorted) {
      const d = driverMap.get(dn);
      if (d && (isFavoriteDriver(d.name_acronym) || isFavoriteTeam(d.team_name))) {
        initial.add(dn);
      }
    }
    raceDataCache.selectedLapDrivers = initial;
  }
  const selected = raceDataCache.selectedLapDrivers;
  const maxLap = Math.max(...laps.map(l => l.lap_number).filter(n => !isNaN(n)), 1);

  if (!raceDataCache.lapTimesZoom) {
    raceDataCache.lapTimesZoom = { start: 1, end: maxLap };
  }
  const zoom = raceDataCache.lapTimesZoom;

  // Compute Session Pace & Consistency Stats
  let sessionBestLap = Infinity;
  let sessionBestDriver = null;
  let sessionBestLapNum = null;
  for (const l of laps) {
    if (l.lap_duration > 0 && !l.is_pit_out_lap && l.lap_number > 1 && l.lap_duration < sessionBestLap) {
      sessionBestLap = l.lap_duration;
      sessionBestDriver = l.driver_number;
      sessionBestLapNum = l.lap_number;
    }
  }
  const cleanCutoff = sessionBestLap < Infinity ? sessionBestLap * 1.12 : Infinity;
  let totalCleanCount = 0;

  const paceStats = [];
  for (const dn of sessionDriversSorted) {
    const d = driverMap.get(dn) || {};
    const dClean = laps
      .filter(l => l.driver_number === dn && l.lap_duration > 0 && !l.is_pit_out_lap && l.lap_number > 1 && l.lap_duration <= cleanCutoff)
      .map(l => l.lap_duration)
      .sort((a, b) => a - b);
    totalCleanCount += dClean.length;
    if (dClean.length === 0) continue;

    const best = dClean[0];
    const mid = Math.floor(dClean.length / 2);
    const median = dClean.length % 2 !== 0 ? dClean[mid] : (dClean[mid - 1] + dClean[mid]) / 2;
    const avg = dClean.reduce((a, b) => a + b, 0) / dClean.length;
    let stdDev = null;
    if (dClean.length >= 4) {
      const variance = dClean.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / dClean.length;
      stdDev = Math.sqrt(variance);
    }
    const finishPos = order.find(o => o.driver_number === dn)?.position || 99;
    paceStats.push({ dn, d, count: dClean.length, best, median, avg, stdDev, finishPos });
  }

  const minSample = Math.max(3, Math.floor(maxLap * 0.25));
  const qualifiedPace = paceStats.filter(p => p.count >= minSample);
  const bestMedianEntry = (qualifiedPace.length > 0 ? qualifiedPace : paceStats).slice().sort((a, b) => a.median - b.median)[0] || null;
  const mostConsistentEntry = qualifiedPace.filter(p => p.stdDev !== null).sort((a, b) => a.stdDev - b.stdDev)[0] || null;
  const flDrv = sessionBestDriver ? driverMap.get(sessionBestDriver) : null;

  const pillsHtml = sessionDriversSorted.map(dn => {
    const d = driverMap.get(dn) || {};
    const acronym = d.name_acronym || `#${dn}`;
    const color = getTeamColor(d.team_colour);
    const isChecked = selected.has(dn);
    const { isFavD } = isDriverOrTeamFavorite(d);
    const activeStyle = isChecked
      ? `background:${color}22; border-color:${color}; color:#fff; font-weight:700;`
      : `background:rgba(255,255,255,0.01); border-color:rgba(255,255,255,0.06); color:var(--text-muted);`;

    return `<button class="driver-filter-pill" data-driver="${dn}" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid; border-radius:100px; font-family:inherit; font-size:0.72rem; transition:all var(--transition-fast); ${activeStyle}">
      <span style="width:8px; height:8px; background:${color}; border-radius:50%; display:inline-block;"></span>
      ${acronym}${isFavD ? ' ★' : ''}
    </button>`;
  }).join('');

  let startOptionsHtml = '';
  let endOptionsHtml = '';
  for (let l = 1; l <= maxLap; l++) {
    startOptionsHtml += `<option value="${l}" ${zoom.start === l ? 'selected' : ''}>Lap ${l}</option>`;
    endOptionsHtml += `<option value="${l}" ${zoom.end === l ? 'selected' : ''}>Lap ${l}</option>`;
  }

  const fastestMedianRef = bestMedianEntry ? bestMedianEntry.median : null;
  const paceTableRows = paceStats.slice().sort((a, b) => a.median - b.median).map((p, idx) => {
    const color = getTeamColor(p.d.team_colour);
    const { isFavD, isFavT } = isDriverOrTeamFavorite(p.d);
    const delta = fastestMedianRef !== null ? (p.median - fastestMedianRef) : 0;
    const deltaStr = idx === 0 ? '<span style="color:#39b54a;font-weight:800;">BENCHMARK</span>' : `+${delta.toFixed(3)}s/lap`;
    const stdStr = p.stdDev !== null ? `±${p.stdDev.toFixed(3)}s` : '—';
    const stdColor = p.stdDev !== null ? (p.stdDev < 0.45 ? '#39b54a' : p.stdDev < 0.85 ? '#fbbf24' : 'var(--text-secondary)') : 'var(--text-muted)';
    return `
      <tr class="clickable-driver-row ${isFavD ? 'fav-pinned-row' : (isFavT ? 'fav-team-member-row' : '')}" data-driver-number="${p.dn}" style="cursor:pointer;">
        <td class="mono" style="font-size:0.76rem;color:var(--text-muted);">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="width:3px;height:16px;border-radius:2px;background:${color};display:inline-block;"></span>
            <strong style="font-size:0.82rem;">${p.d.name_acronym || `#${p.dn}`}</strong>
            ${isFavD ? '<i class="fa-solid fa-star fav-inline-star"></i>' : ''}
            <span style="font-size:0.72rem;color:var(--text-muted);">${p.finishPos < 99 ? `(P${p.finishPos})` : ''}</span>
          </div>
        </td>
        <td class="mono" style="font-size:0.78rem;">${formatLapTime(p.best)}</td>
        <td class="mono" style="font-size:0.8rem;font-weight:700;color:var(--text-primary);">${formatLapTime(p.median)}</td>
        <td class="mono" style="font-size:0.76rem;color:var(--text-secondary);">${deltaStr}</td>
        <td class="mono" style="font-size:0.76rem;color:${stdColor};font-weight:700;">${stdStr}</td>
        <td class="mono" style="font-size:0.75rem;color:var(--text-muted);">${p.count}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <div class="rd-telemetry-kpi-grid" style="margin-bottom:16px;">
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-bolt" style="color:#c084fc;"></i> Fastest Lap</div>
        <div class="rd-kpi-val mono" style="color:#c084fc;">${sessionBestLap < Infinity ? formatLapTime(sessionBestLap) : '—'}</div>
        <div class="rd-kpi-sub">${flDrv ? `${flDrv.name_acronym} • Lap ${sessionBestLapNum}` : '—'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-gauge-high" style="color:#39b54a;"></i> Best Median Pace</div>
        <div class="rd-kpi-val mono" style="color:#39b54a;">${bestMedianEntry ? formatLapTime(bestMedianEntry.median) : '—'}</div>
        <div class="rd-kpi-sub">${bestMedianEntry ? `${bestMedianEntry.d.name_acronym} (${bestMedianEntry.count} clean laps)` : '—'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-bullseye" style="color:#38bdf8;"></i> Most Consistent</div>
        <div class="rd-kpi-val mono" style="color:#38bdf8;">${mostConsistentEntry ? `±${mostConsistentEntry.stdDev.toFixed(2)}s` : '—'}</div>
        <div class="rd-kpi-sub">${mostConsistentEntry ? `${mostConsistentEntry.d.name_acronym} • Metronome Pace` : 'Lap-to-Lap σ'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-filter" style="color:#fbbf24;"></i> Clean Laps Sample</div>
        <div class="rd-kpi-val">${totalCleanCount}</div>
        <div class="rd-kpi-sub">Excludes pit-out &amp; SC spikes</div>
      </div>
    </div>

    <div class="chart-container" style="position: relative;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--space-xs); flex-wrap:wrap; gap:10px;">
        <div class="chart-title" style="margin-bottom:0;">Lap-by-Lap Pace Telemetry</div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <button type="button" id="laptimes-clean-toggle" class="rd-mini-chip ${raceDataCache.cleanPaceMode ? 'active' : ''}" title="Hide Safety Car / VSC slow laps (>114% of best) for clearer Y-axis scaling">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Clean Pace Scale
          </button>
          <button id="laptimes-enlarge-btn" class="rd-mini-chip">
            <i class="fa-solid fa-expand"></i> Enlarge Chart
          </button>
        </div>
      </div>

      <div class="rd-chart-toolbar">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span style="color:var(--text-muted); font-weight:600;"><i class="fa-solid fa-magnifying-glass-plus"></i> Lap Range:</span>
          <select id="laptimes-zoom-start" class="rd-mini-select">${startOptionsHtml}</select>
          <span style="color:var(--text-muted);">to</span>
          <select id="laptimes-zoom-end" class="rd-mini-select">${endOptionsHtml}</select>
          <button id="laptimes-zoom-reset" class="rd-text-reset-btn"><i class="fa-solid fa-rotate-left"></i> Reset</button>
        </div>
        <div class="rd-preset-pills">
          <span style="color:var(--text-muted);font-weight:600;">Quick Pick:</span>
          <button type="button" class="rd-preset-btn" data-lap-preset="podium">Podium</button>
          <button type="button" class="rd-preset-btn" data-lap-preset="top5">Top 5</button>
          <button type="button" class="rd-preset-btn" data-lap-preset="top10">Top 10</button>
          <button type="button" class="rd-preset-btn" data-lap-preset="favs">★ Favorites</button>
          <button type="button" class="rd-preset-btn" data-lap-preset="all">All</button>
        </div>
      </div>

      <div class="driver-filter-pills-container" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:20px; max-height:86px; overflow-y:auto; padding:4px 0;">
        ${pillsHtml}
      </div>
      <canvas class="chart-canvas" id="laptimes-chart" style="cursor: crosshair;"></canvas>
    </div>

    ${paceStats.length > 0 ? `
      <div class="chart-container" style="margin-top:18px;">
        <div class="chart-title" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <span><i class="fa-solid fa-ranking-star" style="color:var(--f1-red);margin-right:6px;"></i> Clean Race Pace &amp; Consistency Ranking</span>
          <span style="font-size:0.72rem;font-weight:500;color:var(--text-muted);">Sorted by Median Clean Lap • Click driver for full telemetry</span>
        </div>
        <div style="overflow-x:auto;">
          <table class="results-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Driver</th>
                <th>Best Lap</th>
                <th>Median Pace</th>
                <th>Pace Delta</th>
                <th>Consistency (σ)</th>
                <th>Clean Laps</th>
              </tr>
            </thead>
            <tbody>${paceTableRows}</tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `;

  const canvas = document.getElementById('laptimes-chart');
  const tooltip = getOrCreateGlobalTooltip();

  container.querySelectorAll('.driver-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const dn = parseInt(pill.dataset.driver, 10);
      if (selected.has(dn)) {
        if (selected.size > 1) selected.delete(dn);
      } else {
        selected.add(dn);
      }
      renderLapTimes(container);
    });
  });

  container.querySelectorAll('[data-lap-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.lapPreset;
      selected.clear();
      if (mode === 'podium') sessionDriversSorted.slice(0, 3).forEach(dn => selected.add(dn));
      else if (mode === 'top5') sessionDriversSorted.slice(0, 5).forEach(dn => selected.add(dn));
      else if (mode === 'top10') sessionDriversSorted.slice(0, 10).forEach(dn => selected.add(dn));
      else if (mode === 'favs') {
        sessionDriversSorted.forEach(dn => {
          const d = driverMap.get(dn);
          if (d && (isFavoriteDriver(d.name_acronym) || isFavoriteTeam(d.team_name))) selected.add(dn);
        });
        if (selected.size === 0) sessionDriversSorted.slice(0, 3).forEach(dn => selected.add(dn));
      } else {
        sessionDriversSorted.forEach(dn => selected.add(dn));
      }
      renderLapTimes(container);
    });
  });

  document.getElementById('laptimes-clean-toggle')?.addEventListener('click', () => {
    raceDataCache.cleanPaceMode = !raceDataCache.cleanPaceMode;
    renderLapTimes(container);
  });

  const zStart = document.getElementById('laptimes-zoom-start');
  const zEnd = document.getElementById('laptimes-zoom-end');
  const zReset = document.getElementById('laptimes-zoom-reset');

  const onZoomChange = () => {
    let sVal = parseInt(zStart.value, 10);
    let eVal = parseInt(zEnd.value, 10);
    if (sVal > eVal) {
      eVal = sVal;
      zEnd.value = sVal;
    }
    zoom.start = sVal;
    zoom.end = eVal;
    initInteractiveChart(document.getElementById('laptimes-chart'), tooltip, 'laptimes');
  };

  zStart.addEventListener('change', onZoomChange);
  zEnd.addEventListener('change', onZoomChange);

  zReset.addEventListener('click', () => {
    zoom.start = 1;
    zoom.end = maxLap;
    zStart.value = 1;
    zEnd.value = maxLap;
    initInteractiveChart(document.getElementById('laptimes-chart'), tooltip, 'laptimes');
  });

  document.getElementById('laptimes-enlarge-btn')?.addEventListener('click', () => {
    openEnlargedChartModal('laptimes');
  });

  bindDriverRowClicks(container);
  initInteractiveChart(canvas, tooltip, 'laptimes');
}

function renderPositions(container) {
  const { laps, order, driverMap } = raceDataCache;

  if (!laps || laps.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">No position data available</div></div>';
    return;
  }

  const allDriversInSession = [...new Set(laps.map(l => l.driver_number))];
  const sessionDriversSorted = order
    .filter(o => allDriversInSession.includes(o.driver_number))
    .map(o => o.driver_number);
  for (const dn of allDriversInSession) {
    if (!sessionDriversSorted.includes(dn)) {
      sessionDriversSorted.push(dn);
    }
  }

  if (!raceDataCache.selectedPositionDrivers) {
    const initial = new Set(sessionDriversSorted.slice(0, 10));
    for (const dn of sessionDriversSorted) {
      const d = driverMap.get(dn);
      if (d && (isFavoriteDriver(d.name_acronym) || isFavoriteTeam(d.team_name))) initial.add(dn);
    }
    raceDataCache.selectedPositionDrivers = initial;
  }
  const selected = raceDataCache.selectedPositionDrivers;
  const maxLap = Math.max(...laps.map(l => l.lap_number).filter(n => !isNaN(n)), 1);

  if (!raceDataCache.positionsZoom) {
    raceDataCache.positionsZoom = { start: 1, end: maxLap };
  }
  const zoom = raceDataCache.positionsZoom;

  // Compute lap-by-lap positions for Laps Led & Movers analytics
  const driverCumTime = new Map();
  for (const dn of allDriversInSession) {
    const dLaps = laps.filter(l => l.driver_number === dn).sort((a, b) => a.lap_number - b.lap_number);
    let cumTime = 0;
    const cumArr = [];
    for (const l of dLaps) {
      cumTime += (l.lap_duration || 200);
      cumArr.push({ lap: l.lap_number, cumTime });
    }
    driverCumTime.set(dn, cumArr);
  }

  const lapsLedMap = new Map();
  const driverPeakPos = new Map();
  let leadSwaps = 0;
  let prevLeader = null;

  for (let lap = 1; lap <= maxLap; lap++) {
    const rankings = [];
    for (const dn of allDriversInSession) {
      const entry = driverCumTime.get(dn)?.find(c => c.lap === lap);
      if (entry) rankings.push({ dn, cumTime: entry.cumTime });
    }
    rankings.sort((a, b) => a.cumTime - b.cumTime);
    if (rankings.length > 0) {
      const leaderDn = rankings[0].dn;
      lapsLedMap.set(leaderDn, (lapsLedMap.get(leaderDn) || 0) + 1);
      if (prevLeader !== null && prevLeader !== leaderDn) leadSwaps++;
      prevLeader = leaderDn;
    }
    rankings.forEach((r, idx) => {
      const pos = idx + 1;
      const curBest = driverPeakPos.get(r.dn);
      if (!curBest || pos < curBest) driverPeakPos.set(r.dn, pos);
    });
  }

  const gridMap = computeStartingGridMap();
  const moversList = [];
  for (const o of order) {
    if (o.status === 'DNS') continue;
    const startP = gridMap.get(o.driver_number) || null;
    const finishP = o.position;
    const peakP = driverPeakPos.get(o.driver_number) || finishP;
    const net = (startP && o.status === 'FINISHED' && typeof finishP === 'number') ? (startP - finishP) : 0;
    moversList.push({ dn: o.driver_number, startP, finishP, peakP, status: o.status, net });
  }
  const topGainer = moversList.filter(m => m.status === 'FINISHED').slice().sort((a, b) => b.net - a.net)[0] || null;
  const topDropper = moversList.filter(m => m.status === 'FINISHED').slice().sort((a, b) => a.net - b.net)[0] || null;

  const leadersSorted = Array.from(lapsLedMap.entries()).sort((a, b) => b[1] - a[1]);
  const topLeader = leadersSorted[0] ? { d: driverMap.get(leadersSorted[0][0]), laps: leadersSorted[0][1] } : null;

  // Build Laps Led Proportional Strip
  let lapsLedBarHtml = '';
  if (leadersSorted.length > 0) {
    const totalLed = leadersSorted.reduce((s, [, c]) => s + c, 0) || 1;
    const segs = leadersSorted.map(([dn, count]) => {
      const d = driverMap.get(dn) || {};
      const col = getTeamColor(d.team_colour);
      const pct = ((count / totalLed) * 100).toFixed(1);
      return `<div class="rd-laps-led-seg" style="width:${pct}%;background:${col};" title="${d.full_name || d.name_acronym}: Led ${count} of ${totalLed} laps (${pct}%)">
        <span>${d.name_acronym || `#${dn}`} (${count}L)</span>
      </div>`;
    }).join('');
    lapsLedBarHtml = `
      <div class="rd-laps-led-card">
        <div class="rd-laps-led-header">
          <span><i class="fa-solid fa-crown" style="color:#ffd700;margin-right:6px;"></i> Laps Led Distribution</span>
          <span style="color:var(--text-muted);font-size:0.72rem;">${leadersSorted.length} Leader${leadersSorted.length !== 1 ? 's' : ''} • ${leadSwaps} Lead Swap${leadSwaps !== 1 ? 's' : ''}</span>
        </div>
        <div class="rd-laps-led-track">${segs}</div>
      </div>
    `;
  }

  const pillsHtml = sessionDriversSorted.map(dn => {
    const d = driverMap.get(dn) || {};
    const acronym = d.name_acronym || `#${dn}`;
    const color = getTeamColor(d.team_colour);
    const isChecked = selected.has(dn);
    const { isFavD } = isDriverOrTeamFavorite(d);
    const activeStyle = isChecked
      ? `background:${color}22; border-color:${color}; color:#fff; font-weight:700;`
      : `background:rgba(255,255,255,0.01); border-color:rgba(255,255,255,0.06); color:var(--text-muted);`;

    return `<button class="driver-pos-filter-pill" data-driver="${dn}" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid; border-radius:100px; font-family:inherit; font-size:0.72rem; transition:all var(--transition-fast); ${activeStyle}">
      <span style="width:8px; height:8px; background:${color}; border-radius:50%; display:inline-block;"></span>
      ${acronym}${isFavD ? ' ★' : ''}
    </button>`;
  }).join('');

  let startOptionsHtml = '';
  let endOptionsHtml = '';
  for (let l = 1; l <= maxLap; l++) {
    startOptionsHtml += `<option value="${l}" ${zoom.start === l ? 'selected' : ''}>Lap ${l}</option>`;
    endOptionsHtml += `<option value="${l}" ${zoom.end === l ? 'selected' : ''}>Lap ${l}</option>`;
  }

  const gainD = topGainer ? driverMap.get(topGainer.dn) : null;
  const dropD = topDropper ? driverMap.get(topDropper.dn) : null;

  container.innerHTML = `
    <div class="rd-telemetry-kpi-grid" style="margin-bottom:16px;">
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-crown" style="color:#ffd700;"></i> Most Laps Led</div>
        <div class="rd-kpi-val">${topLeader ? `${topLeader.d?.name_acronym || '—'} (${topLeader.laps}L)` : '—'}</div>
        <div class="rd-kpi-sub">${leadersSorted.length} Distinct Race Leader${leadersSorted.length === 1 ? '' : 's'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-shuffle" style="color:#60a5fa;"></i> Lead Changes</div>
        <div class="rd-kpi-val">${leadSwaps}</div>
        <div class="rd-kpi-sub">End-of-lap P1 transitions</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-circle-arrow-up" style="color:#39b54a;"></i> Biggest Climber</div>
        <div class="rd-kpi-val" style="color:#39b54a;">${topGainer && topGainer.net > 0 ? `${gainD?.name_acronym} +${topGainer.net}` : '—'}</div>
        <div class="rd-kpi-sub">${topGainer && topGainer.net > 0 ? `P${topGainer.startP} → P${topGainer.finishP}` : 'Grid vs Finish'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-circle-arrow-down" style="color:var(--f1-red);"></i> Biggest Drop</div>
        <div class="rd-kpi-val" style="color:${topDropper && topDropper.net < 0 ? '#f87171' : 'var(--text-primary)'};">${topDropper && topDropper.net < 0 ? `${dropD?.name_acronym} ${topDropper.net}` : '—'}</div>
        <div class="rd-kpi-sub">${topDropper && topDropper.net < 0 ? `P${topDropper.startP} → P${topDropper.finishP}` : 'Classified Finishers'}</div>
      </div>
    </div>

    ${lapsLedBarHtml}

    <div class="chart-container" style="position: relative;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--space-xs); flex-wrap:wrap; gap:12px;">
        <div class="chart-title" style="margin-bottom:0;">Lap-by-Lap Position Battle</div>
        <button id="positions-enlarge-btn" class="rd-mini-chip">
          <i class="fa-solid fa-expand"></i> Enlarge Chart
        </button>
      </div>

      <div class="rd-chart-toolbar">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span style="color:var(--text-muted); font-weight:600;"><i class="fa-solid fa-magnifying-glass-plus"></i> Lap Range:</span>
          <select id="positions-zoom-start" class="rd-mini-select">${startOptionsHtml}</select>
          <span style="color:var(--text-muted);">to</span>
          <select id="positions-zoom-end" class="rd-mini-select">${endOptionsHtml}</select>
          <button id="positions-zoom-reset" class="rd-text-reset-btn"><i class="fa-solid fa-rotate-left"></i> Reset</button>
        </div>
        <div class="rd-preset-pills">
          <span style="color:var(--text-muted);font-weight:600;">Quick Pick:</span>
          <button type="button" class="rd-preset-btn" data-pos-preset="podium">Podium</button>
          <button type="button" class="rd-preset-btn" data-pos-preset="top10">Top 10</button>
          <button type="button" class="rd-preset-btn" data-pos-preset="movers">Biggest Movers</button>
          <button type="button" class="rd-preset-btn" data-pos-preset="favs">★ Favorites</button>
          <button type="button" class="rd-preset-btn" data-pos-preset="all">All</button>
        </div>
      </div>

      <div class="driver-filter-pills-container" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:20px; max-height:86px; overflow-y:auto; padding:4px 0;">
        ${pillsHtml}
      </div>
      <canvas class="chart-canvas" id="positions-chart" style="cursor: crosshair;"></canvas>
    </div>
  `;

  const canvas = document.getElementById('positions-chart');
  const tooltip = getOrCreateGlobalTooltip();

  container.querySelectorAll('.driver-pos-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const dn = parseInt(pill.dataset.driver, 10);
      if (selected.has(dn)) {
        if (selected.size > 1) selected.delete(dn);
      } else {
        selected.add(dn);
      }
      renderPositions(container);
    });
  });

  container.querySelectorAll('[data-pos-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.posPreset;
      selected.clear();
      if (mode === 'podium') sessionDriversSorted.slice(0, 3).forEach(dn => selected.add(dn));
      else if (mode === 'top10') sessionDriversSorted.slice(0, 10).forEach(dn => selected.add(dn));
      else if (mode === 'movers') {
        moversList.slice().sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 6).forEach(m => selected.add(m.dn));
        if (selected.size === 0) sessionDriversSorted.slice(0, 5).forEach(dn => selected.add(dn));
      } else if (mode === 'favs') {
        sessionDriversSorted.forEach(dn => {
          const d = driverMap.get(dn);
          if (d && (isFavoriteDriver(d.name_acronym) || isFavoriteTeam(d.team_name))) selected.add(dn);
        });
        if (selected.size === 0) sessionDriversSorted.slice(0, 3).forEach(dn => selected.add(dn));
      } else {
        sessionDriversSorted.forEach(dn => selected.add(dn));
      }
      renderPositions(container);
    });
  });

  const zStart = document.getElementById('positions-zoom-start');
  const zEnd = document.getElementById('positions-zoom-end');
  const zReset = document.getElementById('positions-zoom-reset');

  const onZoomChange = () => {
    let sVal = parseInt(zStart.value, 10);
    let eVal = parseInt(zEnd.value, 10);
    if (sVal > eVal) {
      eVal = sVal;
      zEnd.value = sVal;
    }
    zoom.start = sVal;
    zoom.end = eVal;
    initInteractiveChart(document.getElementById('positions-chart'), tooltip, 'positions');
  };

  zStart.addEventListener('change', onZoomChange);
  zEnd.addEventListener('change', onZoomChange);

  zReset.addEventListener('click', () => {
    zoom.start = 1;
    zoom.end = maxLap;
    zStart.value = 1;
    zEnd.value = maxLap;
    initInteractiveChart(document.getElementById('positions-chart'), tooltip, 'positions');
  });

  document.getElementById('positions-enlarge-btn')?.addEventListener('click', () => {
    openEnlargedChartModal('positions');
  });

  initInteractiveChart(canvas, tooltip, 'positions');
}

function renderStrategy(container) {
  const { stints, pits, order, driverMap, laps } = raceDataCache;

  if (!stints || stints.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-icon"><i class="fa-solid fa-circle-notch fa-3x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div><div class="no-data-text">No tyre stint &amp; pit strategy telemetry available for this session</div></div>';
    return;
  }

  const maxLapFromLaps = (laps && laps.length > 0) ? Math.max(...laps.map(l => l.lap_number || 0).filter(n => !isNaN(n)), 1) : 1;
  const maxLapFromStints = Math.max(...stints.map(s => s.lap_end || s.lap_start || 1), 1);
  const maxLap = Math.max(maxLapFromLaps, maxLapFromStints, 1);

  const driverOrder = order && order.length > 0
    ? order.map(o => o.driver_number)
    : [...new Set(stints.map(s => s.driver_number))];

  // Session best lap for clean stint pace cutoff
  let sessionBest = Infinity;
  if (laps) {
    for (const l of laps) {
      if (l.lap_duration > 0 && !l.is_pit_out_lap && l.lap_number > 1 && l.lap_duration < sessionBest) {
        sessionBest = l.lap_duration;
      }
    }
  }
  const cleanPaceCap = sessionBest < Infinity ? sessionBest * 1.12 : Infinity;

  // Index laps & pits by driver
  const lapsByDriver = new Map();
  if (laps) {
    for (const l of laps) {
      if (!lapsByDriver.has(l.driver_number)) lapsByDriver.set(l.driver_number, []);
      lapsByDriver.get(l.driver_number).push(l);
    }
  }

  const pitsByDriver = new Map();
  const validPitRecords = [];
  if (pits) {
    for (const p of pits) {
      if (!pitsByDriver.has(p.driver_number)) pitsByDriver.set(p.driver_number, []);
      pitsByDriver.get(p.driver_number).push(p);

      const stopSec = p.stop_duration ? parseFloat(p.stop_duration) : NaN;
      const laneSec = p.pit_duration ? parseFloat(p.pit_duration) : (p.lane_duration ? parseFloat(p.lane_duration) : NaN);
      const primaryDur = (!isNaN(stopSec) && stopSec > 1.2 && stopSec < 60)
        ? stopSec
        : ((!isNaN(laneSec) && laneSec > 8 && laneSec < 120) ? laneSec : null);

      if (primaryDur !== null) {
        validPitRecords.push({
          ...p,
          primaryDur,
          isStationary: !isNaN(stopSec) && stopSec > 1.2 && stopSec < 60,
          stopSec: !isNaN(stopSec) ? stopSec : null,
          laneSec: !isNaN(laneSec) ? laneSec : null
        });
      }
    }
  }
  validPitRecords.sort((a, b) => a.primaryDur - b.primaryDur);
  const fastestPit = validPitRecords[0] || null;

  // Aggregate compound stats & longest stint
  const compoundStats = new Map();
  let longestStint = null;
  let totalStintLapsAll = 0;

  const normalizeCompound = (raw) => {
    const u = (raw || 'UNKNOWN').toUpperCase();
    if (u.includes('SOFT')) return 'SOFT';
    if (u.includes('MED')) return 'MEDIUM';
    if (u.includes('HARD')) return 'HARD';
    if (u.includes('INTER')) return 'INTERMEDIATE';
    if (u.includes('WET') || u.includes('RAIN')) return 'WET';
    return u;
  };

  // Precompute rich stint objects per driver
  const richStintsByDriver = new Map();

  for (const dn of driverOrder) {
    const rawDriverStints = stints
      .filter(s => s.driver_number === dn)
      .sort((a, b) => (a.stint_number || 0) - (b.stint_number || 0));
    if (rawDriverStints.length === 0) continue;

    const dLaps = lapsByDriver.get(dn) || [];
    const dPits = (pitsByDriver.get(dn) || []).slice().sort((a, b) => a.lap_number - b.lap_number);

    const enriched = rawDriverStints.map((s, idx) => {
      const lapStart = Math.max(1, s.lap_start || 1);
      const lapEnd = Math.max(lapStart, s.lap_end || maxLap);
      const stintLen = lapEnd - lapStart + 1;
      const comp = normalizeCompound(s.compound);
      const compoundClass = getCompoundClass(comp);
      const ageAtStart = typeof s.tyre_age_at_start === 'number' ? s.tyre_age_at_start : 0;
      const isUsed = ageAtStart > 0 || s.tyre_new === false || s.tyre_new === 'false' || s.tyre_new === 0;

      // Compute clean pace within stint
      const sLaps = dLaps.filter(l =>
        l.lap_number >= lapStart &&
        l.lap_number <= lapEnd &&
        l.lap_duration > 0 &&
        !l.is_pit_out_lap &&
        l.lap_number > 1 &&
        l.lap_duration <= cleanPaceCap
      );
      const avgPace = sLaps.length > 0 ? (sLaps.reduce((a, b) => a + b.lap_duration, 0) / sLaps.length) : null;
      let bestStintLap = null;
      let bestStintLapNum = null;
      for (const sl of sLaps) {
        if (!bestStintLap || sl.lap_duration < bestStintLap) {
          bestStintLap = sl.lap_duration;
          bestStintLapNum = sl.lap_number;
        }
      }

      // Compute pace degradation slope (early half vs late half of clean laps if >= 6 clean laps)
      let degPerLap = null;
      if (sLaps.length >= 6) {
        const sortedSLaps = sLaps.slice().sort((a, b) => a.lap_number - b.lap_number);
        const third = Math.max(2, Math.floor(sortedSLaps.length / 3));
        const earlyAvg = sortedSLaps.slice(0, third).reduce((a, b) => a + b.lap_duration, 0) / third;
        const lateAvg = sortedSLaps.slice(-third).reduce((a, b) => a + b.lap_duration, 0) / third;
        const lapSpan = Math.max(1, sortedSLaps[sortedSLaps.length - 1].lap_number - sortedSLaps[0].lap_number);
        degPerLap = (lateAvg - earlyAvg) / lapSpan;
      }

      // Match pit stop at end of this stint (if another stint follows)
      let pitAtEnd = null;
      if (idx < rawDriverStints.length - 1) {
        pitAtEnd = dPits.find(p => Math.abs((p.lap_number || 0) - lapEnd) <= 2) || null;
      }

      // Update global compound stats
      totalStintLapsAll += stintLen;
      if (!compoundStats.has(comp)) {
        compoundStats.set(comp, {
          comp,
          compoundClass,
          stintCount: 0,
          totalLaps: 0,
          maxLen: 0,
          maxDriver: null,
          bestLap: Infinity,
          bestDriver: null,
          cleanSum: 0,
          cleanCount: 0
        });
      }
      const cs = compoundStats.get(comp);
      cs.stintCount++;
      cs.totalLaps += stintLen;
      if (stintLen > cs.maxLen) {
        cs.maxLen = stintLen;
        cs.maxDriver = dn;
      }
      for (const sl of sLaps) {
        cs.cleanSum += sl.lap_duration;
        cs.cleanCount++;
        if (sl.lap_duration < cs.bestLap) {
          cs.bestLap = sl.lap_duration;
          cs.bestDriver = dn;
        }
      }

      if (!longestStint || stintLen > longestStint.stintLen) {
        longestStint = { dn, comp, stintLen, lapStart, lapEnd };
      }

      return {
        stintNumber: s.stint_number || (idx + 1),
        comp,
        compoundClass,
        lapStart,
        lapEnd,
        stintLen,
        isUsed,
        ageAtStart,
        avgPace,
        bestStintLap,
        bestStintLapNum,
        degPerLap,
        pitAtEnd
      };
    });

    richStintsByDriver.set(dn, enriched);
  }

  // Sort compounds by total laps descending
  const compoundList = Array.from(compoundStats.values()).sort((a, b) => b.totalLaps - a.totalLaps);
  const dominantComp = compoundList[0] || null;
  const totalStopsCount = pits ? pits.length : 0;
  const activeDriversCount = Math.max(1, richStintsByDriver.size);
  const avgStopsPerCar = (totalStopsCount / activeDriversCount).toFixed(1);

  const fpDrv = fastestPit ? driverMap.get(fastestPit.driver_number) : null;
  const fpStr = fastestPit
    ? `${fastestPit.primaryDur.toFixed(2)}s`
    : '—';
  const fpSub = fastestPit
    ? `${fpDrv?.name_acronym || `#${fastestPit.driver_number}`} • Lap ${fastestPit.lap_number}${fastestPit.isStationary ? ' (Stop)' : ' (Pit Lane)'}`
    : 'No pit stops recorded';

  const longDrv = longestStint ? driverMap.get(longestStint.dn) : null;

  // Lap ruler ticks
  const tickLaps = [1];
  if (maxLap >= 8) {
    tickLaps.push(Math.round(maxLap * 0.25));
    tickLaps.push(Math.round(maxLap * 0.5));
    tickLaps.push(Math.round(maxLap * 0.75));
  }
  if (maxLap > 1) tickLaps.push(maxLap);

  let html = `
    <div class="rd-telemetry-kpi-grid" style="margin-bottom:16px;">
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-bolt" style="color:#fbbf24;"></i> Fastest Pit Stop</div>
        <div class="rd-kpi-val mono" style="color:#fbbf24;">${fpStr}</div>
        <div class="rd-kpi-sub">${fpSub}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-wrench" style="color:#60a5fa;"></i> Total Pit Stops</div>
        <div class="rd-kpi-val">${totalStopsCount}</div>
        <div class="rd-kpi-sub">${avgStopsPerCar} avg stops / driver</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-circle-dot" style="color:#e5e7eb;"></i> Workhorse Tyre</div>
        <div class="rd-kpi-val">${dominantComp ? dominantComp.comp : '—'}</div>
        <div class="rd-kpi-sub">${dominantComp ? `${Math.round((dominantComp.totalLaps / Math.max(1, totalStintLapsAll)) * 100)}% of laps (${dominantComp.totalLaps}L)` : '—'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-road" style="color:#39b54a;"></i> Longest Stint</div>
        <div class="rd-kpi-val">${longestStint ? `${longestStint.stintLen} Laps` : '—'}</div>
        <div class="rd-kpi-sub">${longestStint ? `${longDrv?.name_acronym || `#${longestStint.dn}`} on ${longestStint.comp}` : '—'}</div>
      </div>
    </div>

    <div class="chart-container">
      <div class="strategy-header-bar">
        <div>
          <div class="chart-title" style="margin-bottom:2px;">Visual Tyre Stint &amp; Pit Strategy Timeline</div>
          <div style="font-size:0.72rem;color:var(--text-muted);">Hover any stint for pace, tyre age &amp; degradation telemetry • Click any row for full driver breakdown</div>
        </div>
        <div class="strategy-legend-pills">
          <span class="strat-legend-item"><span class="strat-dot soft">S</span> Soft</span>
          <span class="strat-legend-item"><span class="strat-dot medium">M</span> Medium</span>
          <span class="strat-legend-item"><span class="strat-dot hard">H</span> Hard</span>
          <span class="strat-legend-item"><span class="strat-dot intermediate">I</span> Inter</span>
          <span class="strat-legend-item"><span class="strat-dot wet">W</span> Wet</span>
          <span class="strat-legend-item" title="Diagonal stripes indicate scrubbed/used tyre set at stint start"><span class="strat-dot used-demo"></span> Used Set</span>
        </div>
      </div>

      <!-- Lap Ruler Scale -->
      <div class="strategy-ruler-row">
        <div class="strategy-driver-col ruler-spacer">DRIVER / STOPS</div>
        <div class="strategy-ruler-track">
          ${tickLaps.map((tl, idx) => {
            const pct = maxLap > 1 ? ((tl - 1) / (maxLap - 1)) * 100 : 0;
            const align = idx === 0 ? 'transform:translateX(0);' : (idx === tickLaps.length - 1 ? 'transform:translateX(-100%);' : 'transform:translateX(-50%);');
            return `<span class="strategy-ruler-tick" style="left:${pct}%;${align}">L${tl}</span>`;
          }).join('')}
        </div>
      </div>

      <div class="strategy-timeline enhanced">
  `;

  for (const dn of driverOrder) {
    const driverStints = richStintsByDriver.get(dn);
    if (!driverStints || driverStints.length === 0) continue;

    const d = driverMap.get(dn) || {};
    const teamColor = getTeamColor(d.team_colour);
    const { isFavD, isFavT } = isDriverOrTeamFavorite(d);
    const orderEntry = order ? order.find(o => o.driver_number === dn) : null;
    const posStr = orderEntry
      ? (orderEntry.status === 'DNS' ? 'DNS' : orderEntry.status === 'DSQ' ? 'DSQ' : orderEntry.status === 'DNF' ? 'DNF' : `P${orderEntry.position}`)
      : '';
    const dPits = pitsByDriver.get(dn) || [];
    const stopsCount = dPits.length > 0 ? dPits.length : Math.max(0, driverStints.length - 1);

    html += `
      <div class="strategy-row enhanced ${isFavD ? 'fav-pinned-strat' : (isFavT ? 'fav-team-strat' : '')}" data-driver-number="${dn}" title="Click to open ${d.full_name || d.name_acronym} telemetry">
        <div class="strategy-driver-col">
          <span class="strat-pos-pill ${orderEntry?.position <= 3 && orderEntry?.status === 'FINISHED' ? `p${orderEntry.position}` : ''}">${posStr || '—'}</span>
          <span class="strat-team-bar" style="background:${teamColor}"></span>
          <span class="strategy-driver">${d.name_acronym || `#${dn}`}${isFavD ? ' <i class="fa-solid fa-star fav-inline-star"></i>' : ''}</span>
          <span class="strat-stops-badge">${stopsCount}S</span>
        </div>
        <div class="strategy-bar-container enhanced">
    `;

    driverStints.forEach((stint, sIdx) => {
      const widthPct = Math.max(2.5, (stint.stintLen / maxLap) * 100);
      const compChar = stint.comp[0] || '?';
      const usedClass = stint.isUsed ? 'used-tyre' : '';
      const pitDurStr = stint.pitAtEnd
        ? (stint.pitAtEnd.stop_duration ? `${parseFloat(stint.pitAtEnd.stop_duration).toFixed(2)}s stop` : (stint.pitAtEnd.pit_duration ? `${parseFloat(stint.pitAtEnd.pit_duration).toFixed(2)}s pit lane` : `Lap ${stint.pitAtEnd.lap_number}`))
        : '';

      const tooltipPayload = encodeURIComponent(JSON.stringify({
        driver: d.full_name || d.name_acronym || `#${dn}`,
        team: d.team_name || '',
        color: teamColor,
        pos: posStr,
        stintNum: stint.stintNumber,
        comp: stint.comp,
        isUsed: stint.isUsed,
        age: stint.ageAtStart,
        lapStart: stint.lapStart,
        lapEnd: stint.lapEnd,
        len: stint.stintLen,
        avgPace: stint.avgPace ? formatLapTime(stint.avgPace) : null,
        bestLap: stint.bestStintLap ? `${formatLapTime(stint.bestStintLap)} (L${stint.bestStintLapNum})` : null,
        deg: stint.degPerLap !== null ? `${stint.degPerLap >= 0 ? '+' : ''}${stint.degPerLap.toFixed(3)}s/lap` : null,
        pitInfo: stint.pitAtEnd ? `Lap ${stint.pitAtEnd.lap_number} (${pitDurStr})` : null
      }));

      html += `
        <div class="strategy-stint enhanced ${stint.compoundClass} ${usedClass}" style="width:${widthPct}%" data-stint-tip="${tooltipPayload}">
          ${stint.stintLen >= 3 ? `<span class="stint-comp-tag">${compChar}</span><span class="stint-laps-num">${stint.stintLen}</span>` : `<span class="stint-laps-num">${compChar}</span>`}
        </div>
      `;

      if (sIdx < driverStints.length - 1) {
        html += `<div class="strat-pit-divider" title="Pit Stop around Lap ${stint.lapEnd}${pitDurStr ? ` • ${pitDurStr}` : ''}"></div>`;
      }
    });

    html += `</div></div>`;
  }

  html += `</div></div>`;

  // Secondary Grid: Fastest Pit Stops Leaderboard + Compound Performance Breakdown
  const topPits = validPitRecords.slice(0, 8);
  const bestPitDur = topPits[0]?.primaryDur || 1;

  const pitRowsHtml = topPits.length > 0 ? topPits.map((p, idx) => {
    const d = driverMap.get(p.driver_number) || {};
    const col = getTeamColor(d.team_colour);
    const { isFavD } = isDriverOrTeamFavorite(d);
    const delta = idx === 0 ? 'FASTEST' : `+${(p.primaryDur - bestPitDur).toFixed(2)}s`;
    const barPct = Math.max(35, Math.min(100, (bestPitDur / p.primaryDur) * 100));

    // Identify compound transition around this pit lap
    const dStints = richStintsByDriver.get(p.driver_number) || [];
    let transitionHtml = '';
    const beforeStint = dStints.find(s => Math.abs(s.lapEnd - p.lap_number) <= 2);
    const afterStint = dStints.find(s => Math.abs(s.lapStart - p.lap_number) <= 2 && s !== beforeStint);
    if (beforeStint && afterStint) {
      transitionHtml = `<span class="pit-trans-pill"><span class="strat-dot ${beforeStint.compoundClass}">${beforeStint.comp[0]}</span> → <span class="strat-dot ${afterStint.compoundClass}">${afterStint.comp[0]}</span></span>`;
    }

    return `
      <div class="pit-leader-row ${isFavD ? 'fav-pinned-strat' : ''}">
        <span class="pit-rank ${idx === 0 ? 'p1' : ''}">${idx + 1}</span>
        <span class="strat-team-bar" style="background:${col}"></span>
        <div class="pit-driver-meta">
          <div style="font-weight:700;font-size:0.82rem;color:var(--text-primary);">${d.name_acronym || `#${p.driver_number}`}${isFavD ? ' <i class="fa-solid fa-star fav-inline-star"></i>' : ''} <span style="font-weight:500;color:var(--text-muted);font-size:0.72rem;">Lap ${p.lap_number}</span></div>
          <div class="pit-speed-bar-wrap"><div class="pit-speed-bar" style="width:${barPct}%;background:${idx === 0 ? '#fbbf24' : col};"></div></div>
        </div>
        ${transitionHtml}
        <div style="text-align:right;">
          <div class="mono" style="font-size:0.84rem;font-weight:800;color:${idx === 0 ? '#fbbf24' : 'var(--text-primary)'};">${p.primaryDur.toFixed(2)}s</div>
          <div class="mono" style="font-size:0.65rem;color:${idx === 0 ? '#39b54a' : 'var(--text-muted)'};font-weight:700;">${delta}</div>
        </div>
      </div>
    `;
  }).join('') : '<div style="color:var(--text-muted);font-size:0.8rem;padding:12px 0;">No timed pit stops recorded for this session.</div>';

  const compoundCardsHtml = compoundList.map(cs => {
    const sharePct = Math.round((cs.totalLaps / Math.max(1, totalStintLapsAll)) * 100);
    const avgLen = (cs.totalLaps / Math.max(1, cs.stintCount)).toFixed(1);
    const avgCleanPace = cs.cleanCount > 0 ? formatLapTime(cs.cleanSum / cs.cleanCount) : '—';
    const bestLapStr = cs.bestLap < Infinity ? formatLapTime(cs.bestLap) : '—';
    const bestDrv = cs.bestDriver ? driverMap.get(cs.bestDriver)?.name_acronym : '';
    const maxDrv = cs.maxDriver ? driverMap.get(cs.maxDriver)?.name_acronym : '';

    return `
      <div class="compound-stat-card">
        <div class="compound-card-top">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="strat-dot lg ${cs.compoundClass}">${cs.comp[0]}</span>
            <div>
              <div style="font-weight:800;font-size:0.86rem;color:var(--text-primary);">${cs.comp}</div>
              <div style="font-size:0.68rem;color:var(--text-muted);">${cs.stintCount} Stint${cs.stintCount !== 1 ? 's' : ''} • ${cs.totalLaps} Laps</div>
            </div>
          </div>
          <span class="compound-share-badge">${sharePct}%</span>
        </div>
        <div class="compound-metrics-row">
          <div><span>Avg / Max Stint</span><strong>${avgLen}L / ${cs.maxLen}L${maxDrv ? ` (${maxDrv})` : ''}</strong></div>
          <div><span>Avg Clean Pace</span><strong class="mono">${avgCleanPace}</strong></div>
          <div><span>Fastest Lap</span><strong class="mono">${bestLapStr}${bestDrv ? ` (${bestDrv})` : ''}</strong></div>
        </div>
      </div>
    `;
  }).join('');

  html += `
    <div class="strategy-bottom-grid">
      <div class="chart-container" style="margin-bottom:0;">
        <div class="chart-title"><i class="fa-solid fa-stopwatch" style="color:#fbbf24;margin-right:6px;"></i> Fastest Pit Stops Leaderboard</div>
        <div class="pit-leaderboard-list">${pitRowsHtml}</div>
      </div>
      <div class="chart-container" style="margin-bottom:0;">
        <div class="chart-title"><i class="fa-solid fa-circle-notch" style="color:var(--f1-red);margin-right:6px;"></i> Compound Performance Telemetry</div>
        <div class="compound-cards-stack">${compoundCardsHtml}</div>
      </div>
    </div>
  `;

  container.innerHTML = html;

  // Bind rich hover tooltips on stint bars
  const tooltip = getOrCreateGlobalTooltip();
  container.querySelectorAll('[data-stint-tip]').forEach(el => {
    el.addEventListener('mousemove', (e) => {
      try {
        const info = JSON.parse(decodeURIComponent(el.dataset.stintTip));
        const tyreState = info.isUsed ? `Used Set (${info.age > 0 ? `${info.age}L prior` : 'Scrubbed'})` : 'Fresh Set';
        tooltip.innerHTML = `
          <div style="border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:5px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <strong style="color:#fff;font-size:0.8rem;display:inline-flex;align-items:center;gap:6px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${info.color};display:inline-block;"></span>
              ${info.driver}
            </strong>
            <span style="font-size:0.7rem;color:var(--text-muted);font-weight:700;">${info.pos}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;font-size:0.73rem;">
            <div><span style="color:var(--text-muted);">Stint #${info.stintNum}:</span> <strong style="color:#fff;">${info.comp}</strong> <span style="color:var(--text-secondary);">(${tyreState})</span></div>
            <div><span style="color:var(--text-muted);">Range:</span> <strong class="mono" style="color:#fff;">Lap ${info.lapStart} → ${info.lapEnd} (${info.len} Laps)</strong></div>
            ${info.avgPace ? `<div><span style="color:var(--text-muted);">Avg Clean Pace:</span> <strong class="mono" style="color:#39b54a;">${info.avgPace}</strong></div>` : ''}
            ${info.bestLap ? `<div><span style="color:var(--text-muted);">Best Stint Lap:</span> <strong class="mono" style="color:#c084fc;">${info.bestLap}</strong></div>` : ''}
            ${info.deg ? `<div><span style="color:var(--text-muted);">Pace Trend:</span> <strong class="mono" style="color:#38bdf8;">${info.deg}</strong></div>` : ''}
            ${info.pitInfo ? `<div style="margin-top:2px;padding-top:3px;border-top:1px dashed rgba(255,255,255,0.08);"><span style="color:#fbbf24;">🔧 Pit Stop:</span> <strong class="mono" style="color:#fff;">${info.pitInfo}</strong></div>` : ''}
          </div>
        `;
        tooltip.style.display = 'block';
        const rect = tooltip.getBoundingClientRect();
        let tx = e.clientX + 14;
        let ty = e.clientY + 14;
        if (tx + rect.width > window.innerWidth) tx = e.clientX - rect.width - 14;
        if (ty + rect.height > window.innerHeight) ty = e.clientY - rect.height - 14;
        tooltip.style.left = `${tx}px`;
        tooltip.style.top = `${ty}px`;
      } catch { /* ignore */ }
    });
    el.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  });

  // Clicking a strategy row opens the driver race deep-dive modal
  container.querySelectorAll('.strategy-row.enhanced[data-driver-number]').forEach(row => {
    row.addEventListener('click', () => {
      tooltip.style.display = 'none';
      showRaceDriverDetail(parseInt(row.dataset.driverNumber, 10));
    });
  });
}

function renderOvertakes(container) {
  if (raceDataCache.overtakes && raceDataCache.laps) {
    raceDataCache.overtakes = enrichOvertakesWithLaps(raceDataCache.overtakes, raceDataCache.laps);
  }
  const { overtakes, driverMap } = raceDataCache;

  if (!overtakes || overtakes.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-icon"><i class="fa-solid fa-car-side fa-3x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div><div class="no-data-text">No overtake data available</div></div>';
    return;
  }

  if (!raceDataCache.overtakeFilterMode) raceDataCache.overtakeFilterMode = 'all';
  if (!raceDataCache.overtakeDriverFilter) raceDataCache.overtakeDriverFilter = 'all';

  const sorted = [...overtakes].sort((a, b) => {
    const timeA = new Date(a.date).getTime();
    const timeB = new Date(b.date).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return (a.lap_number || 0) - (b.lap_number || 0);
  });

  // Compute overtake analytics
  const madeMap = new Map();
  const lostMap = new Map();
  const byLapMap = new Map();
  let podiumPasses = 0;

  for (const ot of sorted) {
    madeMap.set(ot.overtaking_driver_number, (madeMap.get(ot.overtaking_driver_number) || 0) + 1);
    lostMap.set(ot.overtaken_driver_number, (lostMap.get(ot.overtaken_driver_number) || 0) + 1);
    if (ot.lap_number) {
      byLapMap.set(ot.lap_number, (byLapMap.get(ot.lap_number) || 0) + 1);
    }
    if (ot.position <= 3) podiumPasses++;
  }

  const allInvolved = new Set([...madeMap.keys(), ...lostMap.keys()]);
  const balanceList = Array.from(allInvolved).map(dn => {
    const made = madeMap.get(dn) || 0;
    const lost = lostMap.get(dn) || 0;
    return { dn, d: driverMap.get(dn) || {}, made, lost, net: made - lost };
  }).sort((a, b) => b.made - a.made || b.net - a.net);

  const topAttacker = balanceList[0] || null;
  const bestNet = balanceList.slice().sort((a, b) => b.net - a.net)[0] || null;
  const busiestLap = Array.from(byLapMap.entries()).sort((a, b) => b[1] - a[1])[0] || null;

  // Apply active filters
  const mode = raceDataCache.overtakeFilterMode;
  const drvFilter = raceDataCache.overtakeDriverFilter;
  const filteredFeed = sorted.filter(ot => {
    if (drvFilter !== 'all') {
      const targetDn = parseInt(drvFilter, 10);
      if (ot.overtaking_driver_number !== targetDn && ot.overtaken_driver_number !== targetDn) return false;
    }
    if (mode === 'podium') return ot.position <= 3;
    if (mode === 'points') return ot.position <= 10;
    if (mode === 'favs') {
      const d1 = driverMap.get(ot.overtaking_driver_number);
      const d2 = driverMap.get(ot.overtaken_driver_number);
      return (d1 && (isFavoriteDriver(d1.name_acronym) || isFavoriteTeam(d1.team_name))) ||
             (d2 && (isFavoriteDriver(d2.name_acronym) || isFavoriteTeam(d2.team_name)));
    }
    return true;
  });

  const driverSelectOptions = balanceList.map(item => {
    const acr = item.d.name_acronym || `#${item.dn}`;
    const name = item.d.full_name || acr;
    return `<option value="${item.dn}" ${String(drvFilter) === String(item.dn) ? 'selected' : ''}>${acr} — ${name} (${item.made}▲ / ${item.lost}▼)</option>`;
  }).join('');

  const topMoversChips = balanceList.slice(0, 6).map(item => {
    const col = getTeamColor(item.d.team_colour);
    const netStr = item.net > 0 ? `+${item.net}` : `${item.net}`;
    const netCol = item.net > 0 ? '#39b54a' : (item.net < 0 ? '#f87171' : 'var(--text-muted)');
    return `
      <button type="button" class="ot-balance-chip ${String(drvFilter) === String(item.dn) ? 'active' : ''}" data-ot-driver-chip="${item.dn}">
        <span style="width:7px;height:7px;border-radius:50%;background:${col};"></span>
        <strong>${item.d.name_acronym || `#${item.dn}`}</strong>
        <span class="mono" style="font-size:0.7rem;color:var(--text-secondary);">${item.made}▲ ${item.lost}▼</span>
        <span class="mono" style="font-size:0.7rem;font-weight:800;color:${netCol};">(${netStr})</span>
      </button>
    `;
  }).join('');

  let html = `
    <div class="rd-telemetry-kpi-grid" style="margin-bottom:16px;">
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-arrows-left-right" style="color:#60a5fa;"></i> Total Passes</div>
        <div class="rd-kpi-val">${sorted.length}</div>
        <div class="rd-kpi-sub">${podiumPasses} Top-3 Podium / Lead Passes</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-fire" style="color:var(--f1-red);"></i> Overtake King</div>
        <div class="rd-kpi-val">${topAttacker ? `${topAttacker.d.name_acronym || `#${topAttacker.dn}`} (${topAttacker.made})` : '—'}</div>
        <div class="rd-kpi-sub">${topAttacker ? `Lost ${topAttacker.lost} • Net ${topAttacker.net >= 0 ? '+' : ''}${topAttacker.net}` : 'Most passes made'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-arrow-trend-up" style="color:#39b54a;"></i> Best Net Balance</div>
        <div class="rd-kpi-val" style="color:#39b54a;">${bestNet ? `${bestNet.d.name_acronym || `#${bestNet.dn}`} +${Math.max(0, bestNet.net)}` : '—'}</div>
        <div class="rd-kpi-sub">${bestNet ? `${bestNet.made} Made vs ${bestNet.lost} Suffered` : 'Passes delta'}</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-bolt" style="color:#fbbf24;"></i> Peak Action Lap</div>
        <div class="rd-kpi-val">${busiestLap ? `Lap ${busiestLap[0]}` : '—'}</div>
        <div class="rd-kpi-sub">${busiestLap ? `${busiestLap[1]} Overtakes recorded` : '—'}</div>
      </div>
    </div>

    <div class="chart-container">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <div class="chart-title" style="margin-bottom:0;">Overtakes Telemetry Feed (${filteredFeed.length}${filteredFeed.length !== sorted.length ? ` of ${sorted.length}` : ''})</div>
        <select id="ot-driver-select" class="rd-mini-select" style="min-width:190px;">
          <option value="all">All Drivers (${sorted.length} Passes)</option>
          ${driverSelectOptions}
        </select>
      </div>

      <div class="rd-preset-pills" style="margin-bottom:12px;">
        <button type="button" class="rd-preset-btn ${mode === 'all' ? 'active' : ''}" data-ot-mode="all">All</button>
        <button type="button" class="rd-preset-btn ${mode === 'podium' ? 'active' : ''}" data-ot-mode="podium">👑 Lead &amp; Podium</button>
        <button type="button" class="rd-preset-btn ${mode === 'points' ? 'active' : ''}" data-ot-mode="points">🎯 Points Zone (P1–P10)</button>
        <button type="button" class="rd-preset-btn ${mode === 'favs' ? 'active' : ''}" data-ot-mode="favs">★ Favorites</button>
      </div>

      <div class="ot-movers-strip">${topMoversChips}</div>

      <div class="overtakes-feed" style="max-height: 480px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm) 0;">
  `;

  if (filteredFeed.length === 0) {
    html += `<div style="text-align:center;color:var(--text-muted);padding:28px 12px;font-size:0.84rem;">No overtakes match the selected filter.</div>`;
  } else {
    for (const ot of filteredFeed) {
      const overtaker = driverMap.get(ot.overtaking_driver_number);
      const overtaken = driverMap.get(ot.overtaken_driver_number);
      const oName = overtaker ? (overtaker.full_name || overtaker.name_acronym) : `#${ot.overtaking_driver_number}`;
      const tName = overtaken ? (overtaken.full_name || overtaken.name_acronym) : `#${ot.overtaken_driver_number}`;
      const oColor = overtaker ? getTeamColor(overtaker.team_colour) : '#666';
      const isFavO = overtaker && isFavoriteDriver(overtaker.name_acronym);
      const isFavT = overtaken && isFavoriteDriver(overtaken.name_acronym);

      const isLeadChange = ot.position === 1;
      const isPodiumPass = ot.position <= 3 && !isLeadChange;
      const badgeText = isLeadChange ? '👑 Lead' : isPodiumPass ? '⭐ Podium' : '';
      const badgeStyle = isLeadChange
        ? 'background: rgba(255, 215, 0, 0.15); border-color: #ffd700; color: #ffd700;'
        : isPodiumPass
          ? 'background: rgba(168, 85, 247, 0.15); border-color: #a855f7; color: #a855f7;'
          : '';

      html += `
        <div class="overtake-item ${isFavO || isFavT ? 'fav-pinned-strat' : ''}" style="border-left: 4px solid ${oColor}; background: var(--bg-card); padding: 12px 16px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--border-subtle); border-left-color: ${oColor};">
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="font-size: 0.72rem; color: var(--f1-red); font-family: 'JetBrains Mono', monospace; font-weight: 600; display:flex; align-items:center; gap:8px;">
              <span>${ot.lap_number ? `LAP ${ot.lap_number}` : 'RACE PASS'}</span>
              ${ot.date ? `<span style="color:var(--text-muted);font-weight:500;font-size:0.66rem;">${new Date(ot.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>` : ''}
            </div>
            <div style="font-size: 0.85rem; color: var(--text-primary); line-height: 1.4;">
              <strong>${oName}${isFavO ? ' ★' : ''}</strong> overtook <strong>${tName}${isFavT ? ' ★' : ''}</strong>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            ${badgeText ? `<span style="font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 8px; border-radius: 100px; border: 1px solid; ${badgeStyle}">${badgeText}</span>` : ''}
            <div class="overtake-position" style="font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 0.9rem; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-primary);" title="Position gained to P${ot.position}">P${ot.position}</div>
          </div>
        </div>
      `;
    }
  }

  html += '</div></div>';
  container.innerHTML = html;

  document.getElementById('ot-driver-select')?.addEventListener('change', (e) => {
    raceDataCache.overtakeDriverFilter = e.target.value;
    renderOvertakes(container);
  });

  container.querySelectorAll('[data-ot-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      raceDataCache.overtakeFilterMode = btn.dataset.otMode;
      renderOvertakes(container);
    });
  });

  container.querySelectorAll('[data-ot-driver-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const target = chip.dataset.otDriverChip;
      raceDataCache.overtakeDriverFilter = String(raceDataCache.overtakeDriverFilter) === String(target) ? 'all' : target;
      renderOvertakes(container);
    });
  });
}

// ── Weather & Environment Renderer ──

async function loadAndRenderWeather(sessionKey, container) {
  if (!container) return;
  container.innerHTML = '';
  container.style.display = 'none';

  try {
    const weatherData = await getWeather({ session_key: sessionKey });
    if (!weatherData || weatherData.length === 0) return;

    // Filter out null/invalid entries
    const validAir = weatherData.map(w => w.air_temperature).filter(v => v !== null && v !== undefined);
    const validTrack = weatherData.map(w => w.track_temperature).filter(v => v !== null && v !== undefined);
    const validHum = weatherData.map(w => w.humidity).filter(v => v !== null && v !== undefined);
    const validWind = weatherData.map(w => w.wind_speed).filter(v => v !== null && v !== undefined);
    const hasRain = weatherData.some(w => w.rainfall === 1 || w.rainfall === true);

    if (validAir.length === 0 && validTrack.length === 0) return;

    const avgAir = (validAir.reduce((a, b) => a + b, 0) / validAir.length).toFixed(1);
    const avgTrack = (validTrack.reduce((a, b) => a + b, 0) / validTrack.length).toFixed(1);
    const avgHum = validHum.length > 0 ? (validHum.reduce((a, b) => a + b, 0) / validHum.length).toFixed(0) : null;
    const avgWind = validWind.length > 0 ? (validWind.reduce((a, b) => a + b, 0) / validWind.length).toFixed(1) : null;

    container.innerHTML = `
      <div class="weather-item" title="Average Air Temperature"><i class="fa-solid fa-temperature-half" style="margin-right: 5px; color: var(--text-secondary);"></i>Air: <span>${avgAir}°C</span></div>
      <div class="weather-item" title="Average Track Temperature"><i class="fa-solid fa-road" style="margin-right: 5px; color: var(--text-secondary);"></i>Track: <span>${avgTrack}°C</span></div>
      ${avgHum ? `<div class="weather-item" title="Average Humidity"><i class="fa-solid fa-droplet" style="margin-right: 5px; color: #2b7bcd;"></i>Humid: <span>${avgHum}%</span></div>` : ''}
      ${avgWind ? `<div class="weather-item" title="Average Wind Speed"><i class="fa-solid fa-wind" style="margin-right: 5px; color: var(--text-secondary);"></i>Wind: <span>${avgWind} m/s</span></div>` : ''}
      <div class="weather-item">${hasRain ? '<i class="fa-solid fa-cloud-showers-heavy" style="margin-right: 5px; color: #2b7bcd;"></i><span>Wet</span>' : '<i class="fa-solid fa-sun" style="margin-right: 5px; color: #ffd000;"></i><span>Dry</span>'}</div>
    `;
    container.style.display = 'flex';
  } catch (err) {
    console.warn('[Race Detail] Failed to render weather:', err);
  }
}

// ── Incidents & Race Control Renderer ──

async function loadAndRenderIncidents(container) {
  if (raceDataCache.incidents) {
    renderIncidents(container);
    return;
  }
  container.innerHTML = Array(4).fill('<div class="skeleton skeleton-row"></div>').join('');
  try {
    const incidents = await getRaceControl({ session_key: raceDataCache.sessionKey });
    raceDataCache.incidents = incidents;
    renderIncidents(container);
  } catch (e) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load incidents feed. Please try again.</div></div>';
  }
}

function renderIncidents(container) {
  const { incidents } = raceDataCache;

  if (!incidents || incidents.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-icon"><i class="fa-regular fa-flag fa-3x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div><div class="no-data-text">No race control incidents recorded for this session</div></div>';
    return;
  }

  if (!raceDataCache.incidentCategory) raceDataCache.incidentCategory = 'all';
  if (raceDataCache.incidentQuery === undefined) raceDataCache.incidentQuery = '';

  const sorted = [...incidents].sort((a, b) => new Date(a.date) - new Date(b.date));

  let scCount = 0;
  let flagCount = 0;
  let stewardsCount = 0;

  const classifiedList = sorted.map(inc => {
    const msg = inc.message || '';
    const msgUpper = msg.toUpperCase();
    let catClass = 'incident-info';
    let filterGroup = 'info';
    let icon = '<i class="fa-solid fa-circle-info" style="color: var(--text-muted);"></i>';

    if (inc.flag === 'RED' || msgUpper.includes('RED FLAG') || msgUpper.includes('SUSPENDED')) {
      catClass = 'incident-flag-red';
      filterGroup = 'sc';
      scCount++;
      icon = '<i class="fa-solid fa-flag" style="color: var(--f1-red);"></i>';
    } else if (inc.category === 'SafetyCar' || msgUpper.includes('SAFETY CAR') || msgUpper.includes('VSC')) {
      catClass = 'incident-sc';
      filterGroup = 'sc';
      if (msgUpper.includes('DEPLOYED') || msgUpper.includes('ENDING') === false) scCount++;
      icon = '<i class="fa-solid fa-triangle-exclamation" style="color: #ffd000;"></i>';
    } else if (msgUpper.includes('INVESTIGAT') || msgUpper.includes('PENALTY') || msgUpper.includes('STEWARDS') || msgUpper.includes('DELETED')) {
      catClass = 'incident-stewards';
      filterGroup = 'stewards';
      stewardsCount++;
      icon = '<i class="fa-solid fa-gavel" style="color: #38bdf8;"></i>';
    } else if (inc.flag === 'YELLOW' || inc.flag === 'DOUBLE YELLOW' || msgUpper.includes('YELLOW')) {
      catClass = 'incident-flag-yellow';
      filterGroup = 'flags';
      flagCount++;
      icon = '<i class="fa-solid fa-flag" style="color: #ffd000;"></i>';
    } else if (inc.flag === 'GREEN' || msgUpper.includes('GREEN FLAG') || msgUpper.includes('CLEAR')) {
      catClass = 'incident-flag-green';
      filterGroup = 'flags';
      icon = '<i class="fa-solid fa-flag" style="color: #39b54a;"></i>';
    }

    return { inc, msg, msgUpper, catClass, filterGroup, icon };
  });

  const activeCat = raceDataCache.incidentCategory;
  const query = raceDataCache.incidentQuery.trim().toUpperCase();

  const filtered = classifiedList.filter(item => {
    if (activeCat !== 'all' && item.filterGroup !== activeCat) return false;
    if (query) {
      const lapStr = item.inc.lap_number ? `LAP ${item.inc.lap_number}` : 'PRE-RACE';
      if (!item.msgUpper.includes(query) && !lapStr.includes(query)) return false;
    }
    return true;
  });

  let html = `
    <div class="rd-telemetry-kpi-grid" style="margin-bottom:16px;">
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-tower-broadcast" style="color:#60a5fa;"></i> Dispatches</div>
        <div class="rd-kpi-val">${sorted.length}</div>
        <div class="rd-kpi-sub">Official FIA Race Control logs</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-car-burst" style="color:#fbbf24;"></i> SC / VSC / Red</div>
        <div class="rd-kpi-val" style="color:${scCount > 0 ? '#fbbf24' : 'var(--text-primary)'};">${scCount}</div>
        <div class="rd-kpi-sub">Neutralization alerts</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-flag" style="color:#ffd000;"></i> Yellow Warnings</div>
        <div class="rd-kpi-val">${flagCount}</div>
        <div class="rd-kpi-sub">Sector hazard flags</div>
      </div>
      <div class="rd-kpi-tile">
        <div class="rd-kpi-label"><i class="fa-solid fa-gavel" style="color:#38bdf8;"></i> Stewards &amp; Limits</div>
        <div class="rd-kpi-val" style="color:#38bdf8;">${stewardsCount}</div>
        <div class="rd-kpi-sub">Penalties, investigations &amp; deletions</div>
      </div>
    </div>

    <div class="chart-container">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <div class="chart-title" style="margin-bottom:0;">Race Control Timeline (${filtered.length}${filtered.length !== sorted.length ? ` of ${sorted.length}` : ''})</div>
        <div class="rd-search-inline">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input type="text" id="inc-search-input" placeholder="Search driver, penalty, lap..." value="${raceDataCache.incidentQuery.replace(/"/g, '&quot;')}">
        </div>
      </div>

      <div class="rd-preset-pills" style="margin-bottom:14px;">
        <button type="button" class="rd-preset-btn ${activeCat === 'all' ? 'active' : ''}" data-inc-cat="all">All (${sorted.length})</button>
        <button type="button" class="rd-preset-btn ${activeCat === 'sc' ? 'active' : ''}" data-inc-cat="sc">🚨 SC / VSC / Red</button>
        <button type="button" class="rd-preset-btn ${activeCat === 'stewards' ? 'active' : ''}" data-inc-cat="stewards">⚖️ Stewards &amp; Penalties</button>
        <button type="button" class="rd-preset-btn ${activeCat === 'flags' ? 'active' : ''}" data-inc-cat="flags">🏳️ Sector Flags</button>
        <button type="button" class="rd-preset-btn ${activeCat === 'info' ? 'active' : ''}" data-inc-cat="info">ℹ️ Track Info</button>
      </div>

      <div class="incidents-feed" style="max-height:520px;overflow-y:auto;">
  `;

  if (filtered.length === 0) {
    html += `<div style="text-align:center;color:var(--text-muted);padding:28px 12px;font-size:0.84rem;">No Race Control dispatches match your filter.</div>`;
  } else {
    filtered.forEach((item, idx) => {
      const { inc, msg, catClass, icon } = item;
      const lapText = inc.lap_number ? `Lap ${inc.lap_number}` : 'Pre-Session';
      const timeStr = new Date(inc.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      html += `
        <div class="incident-item ${catClass}" style="animation-delay: ${Math.min(idx * 25, 300)}ms">
          <div class="incident-badge">${icon}</div>
          <div class="incident-card">
            <div class="incident-meta">
              <span class="incident-lap">${lapText}</span>
              <span class="incident-time">${timeStr}</span>
            </div>
            <div class="incident-msg">${msg}</div>
          </div>
        </div>
      `;
    });
  }

  html += '</div></div>';
  container.innerHTML = html;

  container.querySelectorAll('[data-inc-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      raceDataCache.incidentCategory = btn.dataset.incCat;
      renderIncidents(container);
    });
  });

  const searchEl = document.getElementById('inc-search-input');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      raceDataCache.incidentQuery = e.target.value;
      renderIncidents(container);
      const next = document.getElementById('inc-search-input');
      if (next) {
        next.focus();
        try { next.setSelectionRange(pos, pos); } catch { /* ignore */ }
      }
    });
  }
}

// ── Grand Prix Driver Deep-Dive Modal Setup (v3.2 Telemetry Edition) ──

let overlay = null;
let activeDriverModalReqId = 0;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.getElementById('driver-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'driver-modal-overlay';
    overlay.id = 'driver-modal-overlay';
    overlay.innerHTML = '<div class="driver-modal" id="driver-modal"></div>';
    document.body.appendChild(overlay);
  }

  overlay._onCloseCleanup = () => {
    if (scheduleInterval) {
      clearInterval(scheduleInterval);
      scheduleInterval = null;
    }
  };

  if (!overlay.dataset.boundClose) {
    overlay.dataset.boundClose = 'true';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('open')) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        closeModal();
      } else if (e.key === 'ArrowLeft' && typeof overlay._onKeyNav === 'function') {
        e.preventDefault();
        overlay._onKeyNav(-1);
      } else if (e.key === 'ArrowRight' && typeof overlay._onKeyNav === 'function') {
        e.preventDefault();
        overlay._onKeyNav(1);
      }
    });
  }

  return overlay;
}

function closeModal() {
  if (overlay) {
    overlay.classList.remove('open');
    overlay._onKeyNav = null;
    document.body.style.overflow = '';
    if (typeof overlay._onCloseCleanup === 'function') {
      overlay._onCloseCleanup();
    }
  }
}

/**
 * Show a comprehensive Grand Prix Driver Deep-Dive modal with:
 * - Prev / Next classified driver quick navigation (+ keyboard arrows)
 * - Accurate grid vs finish movement, points earned & gap to leader
 * - Session-relative sector telemetry (Purple vs Green), Optimal Lap & Clean Consistency
 * - Interactive Clean Lap Pace Trace canvas chart
 * - Proportional Tyre Strategy Strip + Stint Pace & Degradation cards + Pit Stop Telemetry
 * - Filterable Lap-by-Lap Telemetry table (with speed trap & tyre compound)
 * - Driver Track Battles (Overtakes Made / Conceded) + FIA Stewards log
 */
export async function showRaceDriverDetail(driverNumber) {
  const activeOverlay = ensureOverlay();
  const modal = document.getElementById('driver-modal');
  if (!raceDataCache) return;

  const reqId = ++activeDriverModalReqId;
  const order = raceDataCache.order || [];
  const driverMap = raceDataCache.driverMap || new Map();

  const d = driverMap.get(driverNumber) || {
    name_acronym: `#${driverNumber}`,
    team_name: 'Unknown',
    team_colour: '666666',
    full_name: `Driver #${driverNumber}`,
    headshot_url: ''
  };
  const teamColor = getTeamColor(d.team_colour);

  // Prev / Next Driver in Session Classification
  const orderIdx = order.findIndex(o => o.driver_number === driverNumber);
  const prevEntry = orderIdx > 0 ? order[orderIdx - 1] : null;
  const nextEntry = (orderIdx >= 0 && orderIdx < order.length - 1) ? order[orderIdx + 1] : null;
  const prevDrv = prevEntry ? (driverMap.get(prevEntry.driver_number) || { name_acronym: `#${prevEntry.driver_number}` }) : null;
  const nextDrv = nextEntry ? (driverMap.get(nextEntry.driver_number) || { name_acronym: `#${nextEntry.driver_number}` }) : null;

  activeOverlay._onKeyNav = (dir) => {
    if (dir < 0 && prevEntry) showRaceDriverDetail(prevEntry.driver_number);
    else if (dir > 0 && nextEntry) showRaceDriverDetail(nextEntry.driver_number);
  };

  const sessionType = raceDataCache.currentSessionType;
  const isRace = isRaceSession(sessionType);
  const isQuali = isQualifyingSession(sessionType);
  const circuitName = raceDataCache.meetingInfo?.circuit_short_name || raceDataCache.meetingInfo?.country_name || 'Grand Prix';

  const loadingLabel = isQuali
    ? 'Compiling Qualifying Sector & Stint Telemetry...'
    : (isRace ? 'Compiling Race Pace, Strategy & Battle Telemetry...' : 'Compiling Practice Run Telemetry...');

  // Glassmorphic loader with topbar preserved for smooth entity switching
  modal.innerHTML = `
    <div class="pm-topbar">
      <div class="pm-nav-group">
        <button type="button" class="pm-nav-btn" id="rd-prev-drv-loading" ${!prevEntry ? 'disabled' : ''}>
          <i class="fa-solid fa-chevron-left"></i>
          <span>${prevEntry ? `P${prevEntry.position || orderIdx} ${prevDrv.name_acronym}` : 'Prev'}</span>
        </button>
        <span class="pm-nav-indicator">${circuitName} · ${sessionType}</span>
        <button type="button" class="pm-nav-btn" id="rd-next-drv-loading" ${!nextEntry ? 'disabled' : ''}>
          <span>${nextEntry ? `P${nextEntry.position || (orderIdx + 2)} ${nextDrv.name_acronym}` : 'Next'}</span>
          <i class="fa-solid fa-chevron-right"></i>
        </button>
      </div>
      <button class="driver-modal-close pm-inline-close" id="dm-close" aria-label="Close">✕</button>
    </div>
    <div style="padding: 36px 24px; text-align: center; font-family:'Outfit',sans-serif;">
      <div style="position: relative; width: 76px; height: 76px; border-radius: 50%; background: rgba(255,255,255,0.03); border: 2px solid ${teamColor}; margin: 0 auto 14px auto; overflow: hidden;">
        <img src="${d.headshot_url || ''}" alt="${d.name_acronym}" style="width: 100%; height: auto; object-fit: cover;" onerror="this.style.display='none'">
      </div>
      <div style="font-family:'Outfit',sans-serif; font-weight:800; font-size:1.15rem; color:var(--text-primary); margin-bottom:2px;">${d.full_name}</div>
      <div style="font-size:0.74rem; color:${teamColor}; text-transform:uppercase; letter-spacing:0.06em; font-weight:700; margin-bottom:22px;">${d.team_name}</div>
      <div style="display:flex; flex-direction:column; gap:10px; max-width:320px; margin: 0 auto;">
        <div class="skeleton skeleton-row" style="height:12px; width:100%;"></div>
        <div class="skeleton skeleton-row" style="height:12px; width:84%;"></div>
        <div class="skeleton skeleton-row" style="height:12px; width:92%;"></div>
      </div>
      <div style="font-size:0.78rem; color:var(--text-muted); margin-top:18px; font-weight:600;">${loadingLabel}</div>
    </div>
  `;
  document.getElementById('dm-close')?.addEventListener('click', closeModal);
  document.getElementById('rd-prev-drv-loading')?.addEventListener('click', () => {
    if (prevEntry) showRaceDriverDetail(prevEntry.driver_number);
  });
  document.getElementById('rd-next-drv-loading')?.addEventListener('click', () => {
    if (nextEntry) showRaceDriverDetail(nextEntry.driver_number);
  });

  activeOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  try {
    const activeSessionKey = raceDataCache.sessionKey;
    raceDataCache.driverTelemetry = raceDataCache.driverTelemetry || {};
    let stints, pits, laps, positions;

    if (raceDataCache.driverTelemetry[driverNumber]) {
      const cached = raceDataCache.driverTelemetry[driverNumber];
      stints = cached.stints;
      pits = cached.pits;
      laps = cached.laps;
      positions = cached.positions;
    } else {
      const results = await Promise.all([
        getStints({ session_key: activeSessionKey, driver_number: driverNumber }),
        getPits({ session_key: activeSessionKey, driver_number: driverNumber }),
        getLaps({ session_key: activeSessionKey, driver_number: driverNumber }),
        getPositions({ session_key: activeSessionKey, driver_number: driverNumber }),
        (!raceDataCache.laps && isQuali) ? getLaps({ session_key: activeSessionKey }) : Promise.resolve(null),
      ]);
      stints = results[0] || [];
      pits = results[1] || [];
      laps = results[2] || [];
      positions = results[3] || [];
      if (results[4] && raceDataCache && raceDataCache.sessionKey === activeSessionKey) {
        raceDataCache.laps = results[4];
      }
      if (raceDataCache && raceDataCache.sessionKey === activeSessionKey) {
        raceDataCache.driverTelemetry[driverNumber] = { stints, pits, laps, positions };
      }
    }

    // Fetch lightweight session incidents & (for races) overtakes if not yet cached
    const [incidents, overtakesRaw] = await Promise.all([
      raceDataCache.incidents ? Promise.resolve(raceDataCache.incidents) : getRaceControl({ session_key: activeSessionKey }),
      (isRace && !raceDataCache.overtakes) ? getOvertakes({ session_key: activeSessionKey }).catch(() => []) : Promise.resolve(raceDataCache.overtakes || []),
    ]);

    if (reqId !== activeDriverModalReqId || !raceDataCache || raceDataCache.sessionKey !== activeSessionKey) {
      return; // Superseded by another user navigation
    }

    raceDataCache.incidents = incidents || [];
    if (isRace && overtakesRaw) {
      raceDataCache.overtakes = enrichOvertakesWithLaps(overtakesRaw, raceDataCache.laps || laps);
    }

    const driverStints = [...stints].sort((a, b) => (a.stint_number || 0) - (b.stint_number || 0));
    const driverPits = [...pits].sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0));
    const driverLaps = [...laps].sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0));

    // ── Grid, Finish, Points & Gap to Winner ──
    const finishEntry = order.find(o => o.driver_number === driverNumber);
    const finishPos = finishEntry ? finishEntry.position : '—';
    const finishStatus = finishEntry ? (finishEntry.status || 'FINISHED') : 'FINISHED';
    const isDNS = finishStatus === 'DNS';
    const isDSQ = finishStatus === 'DSQ';
    const isDNF = finishStatus === 'DNF';

    let startPos = '—';
    if (isRace) {
      const gridMap = computeStartingGridMap();
      if (gridMap.has(driverNumber)) {
        startPos = gridMap.get(driverNumber);
      } else if (positions.length > 0) {
        const sortedPositions = [...positions].sort((a, b) => new Date(a.date) - new Date(b.date));
        startPos = sortedPositions[0].position ?? '—';
      }
    }

    let gainLossBadgeHtml = '';
    if (isRace) {
      if (isDNS) {
        gainLossBadgeHtml = `<span class="pm-hero-delta neutral"><i class="fa-solid fa-ban"></i> Did Not Start (DNS)</span>`;
      } else if (isDSQ) {
        gainLossBadgeHtml = `<span class="pm-hero-delta down"><i class="fa-solid fa-gavel"></i> Disqualified (DSQ)</span>`;
      } else if (isDNF) {
        gainLossBadgeHtml = `<span class="pm-hero-delta down"><i class="fa-solid fa-triangle-exclamation"></i> Retired on Lap ${driverLaps.length || '—'} (Started P${startPos})</span>`;
      } else if (typeof startPos === 'number' && typeof finishPos === 'number') {
        const diff = startPos - finishPos;
        if (diff > 0) {
          gainLossBadgeHtml = `<span class="pm-hero-delta up"><i class="fa-solid fa-circle-up"></i> +${diff} Pos Gained (P${startPos} → P${finishPos})</span>`;
        } else if (diff < 0) {
          gainLossBadgeHtml = `<span class="pm-hero-delta down"><i class="fa-solid fa-circle-down"></i> ${diff} Pos Lost (P${startPos} → P${finishPos})</span>`;
        } else {
          gainLossBadgeHtml = `<span class="pm-hero-delta neutral"><i class="fa-solid fa-circle-right"></i> Held Grid Position (P${finishPos})</span>`;
        }
      }
    } else if (isQuali) {
      gainLossBadgeHtml = `<span class="pm-hero-delta neutral"><i class="fa-solid fa-stopwatch"></i> Qualified P${finishPos}</span>`;
    } else {
      gainLossBadgeHtml = `<span class="pm-hero-delta neutral"><i class="fa-solid fa-gauge-high"></i> Classified P${finishPos} in ${sessionType}</span>`;
    }

    // Session-wide benchmarks (purple lap & sectors) when raceDataCache.laps is available
    const sessionLaps = raceDataCache.laps || [];
    let sessBestLap = Infinity, sessBestLapDrv = null;
    let sessBestS1 = Infinity, sessBestS2 = Infinity, sessBestS3 = Infinity;
    let maxSessionLap = driverLaps.length;

    for (const sl of sessionLaps) {
      if (sl.lap_number && sl.lap_number > maxSessionLap) maxSessionLap = sl.lap_number;
      const validRaceLap = isRace ? (sl.lap_number > 1 && !sl.is_pit_out_lap) : !sl.is_pit_out_lap;
      if (sl.lap_duration && validRaceLap && sl.lap_duration < sessBestLap) {
        sessBestLap = sl.lap_duration;
        sessBestLapDrv = sl.driver_number;
      }
      if (sl.duration_sector_1 && sl.duration_sector_1 > 0 && sl.duration_sector_1 < sessBestS1) sessBestS1 = sl.duration_sector_1;
      if (sl.duration_sector_2 && sl.duration_sector_2 > 0 && sl.duration_sector_2 < sessBestS2) sessBestS2 = sl.duration_sector_2;
      if (sl.duration_sector_3 && sl.duration_sector_3 > 0 && sl.duration_sector_3 < sessBestS3) sessBestS3 = sl.duration_sector_3;
    }

    // Personal Best Lap, Sectors & Clean Pace Analytics
    let bestLap = Infinity, bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity;
    let bestLapNum = '—', bestS1Num = '—', bestS2Num = '—', bestS3Num = '—';
    let topSpeed = 0, topSpeedLap = '—';

    const pitLapSet = new Set(driverPits.map(p => p.lap_number));
    const rawValidDurations = [];

    driverLaps.forEach(l => {
      const validForBest = isRace ? (!l.is_pit_out_lap && l.lap_number > 1) : !l.is_pit_out_lap;
      if (l.lap_duration && validForBest && l.lap_duration < bestLap) {
        bestLap = l.lap_duration;
        bestLapNum = l.lap_number;
      }
      if (l.duration_sector_1 && l.duration_sector_1 > 0 && l.duration_sector_1 < bestS1) {
        bestS1 = l.duration_sector_1;
        bestS1Num = l.lap_number;
      }
      if (l.duration_sector_2 && l.duration_sector_2 > 0 && l.duration_sector_2 < bestS2) {
        bestS2 = l.duration_sector_2;
        bestS2Num = l.lap_number;
      }
      if (l.duration_sector_3 && l.duration_sector_3 > 0 && l.duration_sector_3 < bestS3) {
        bestS3 = l.duration_sector_3;
        bestS3Num = l.lap_number;
      }
      const spd = l.st_speed || l.i2_speed || l.i1_speed || 0;
      if (spd > topSpeed) {
        topSpeed = spd;
        topSpeedLap = l.lap_number;
      }
      if (l.lap_duration && !l.is_pit_out_lap && !pitLapSet.has(l.lap_number) && (!isRace || l.lap_number > 1)) {
        rawValidDurations.push({ lap: l.lap_number, dur: l.lap_duration });
      }
    });

    // Filter out safety-car / cooldown outliers (> 108% of personal best in Race, > 107% in Practice/Quali)
    const cleanThreshold = bestLap < Infinity ? bestLap * (isRace ? 1.085 : 1.07) : Infinity;
    const cleanLapObjs = rawValidDurations.filter(item => item.dur <= cleanThreshold);
    const cleanDurs = cleanLapObjs.map(item => item.dur).sort((a, b) => a - b);

    let medianCleanPace = null;
    let cleanPaceStdDev = null;
    if (cleanDurs.length > 0) {
      const mid = Math.floor(cleanDurs.length / 2);
      medianCleanPace = cleanDurs.length % 2 === 0 ? (cleanDurs[mid - 1] + cleanDurs[mid]) / 2 : cleanDurs[mid];
      if (cleanDurs.length >= 3) {
        const mean = cleanDurs.reduce((a, b) => a + b, 0) / cleanDurs.length;
        const variance = cleanDurs.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / cleanDurs.length;
        cleanPaceStdDev = Math.sqrt(variance);
      }
    }

    const theoreticalBest = (bestS1 < Infinity && bestS2 < Infinity && bestS3 < Infinity)
      ? (bestS1 + bestS2 + bestS3)
      : null;
    const potentialGain = (bestLap < Infinity && theoreticalBest !== null && bestLap >= theoreticalBest)
      ? (bestLap - theoreticalBest)
      : null;

    const hasSessionFastestLap = sessBestLap < Infinity && bestLap < Infinity && (sessBestLapDrv === driverNumber || Math.abs(bestLap - sessBestLap) < 0.0005);

    // Points & Gap computation for Race/Sprint
    let driverPts = 0;
    let gapDisplayStr = '—';
    if (isRace && finishEntry) {
      const isSprintSession = sessionType === 'Sprint';
      const awardFL = !isSprintSession && (raceDataCache.meetingInfo?.year || 2025) < 2025;
      if (finishEntry.points !== undefined) {
        driverPts = finishEntry.points;
      } else if (!isDNS && !isDSQ && typeof finishPos === 'number') {
        driverPts = getPointsForPosition(finishPos, isSprintSession);
        if (awardFL && hasSessionFastestLap && finishPos <= 10 && finishStatus === 'FINISHED') {
          driverPts += 1;
        }
      }

      if (isDNS || isDSQ || isDNF) {
        gapDisplayStr = finishStatus;
      } else if (finishPos === 1) {
        gapDisplayStr = 'WINNER';
      } else {
        let latestInt = null;
        if (raceDataCache.intervals && raceDataCache.intervals.length > 0) {
          for (const ie of raceDataCache.intervals) {
            if (ie.driver_number === driverNumber) {
              if (!latestInt || new Date(ie.date) > new Date(latestInt.date)) latestInt = ie;
            }
          }
        }
        const lapsDiff = maxSessionLap - driverLaps.length;
        if (maxSessionLap > 0 && lapsDiff > 0 && lapsDiff < 15) {
          gapDisplayStr = `+${lapsDiff} Lap${lapsDiff > 1 ? 's' : ''}`;
        } else if (latestInt && latestInt.gap_to_leader != null) {
          const gVal = parseFloat(latestInt.gap_to_leader);
          gapDisplayStr = !isNaN(gVal) ? `+${gVal.toFixed(3)}s` : String(latestInt.gap_to_leader);
        } else {
          gapDisplayStr = `${driverPits.length} Stop${driverPits.length !== 1 ? 's' : ''}`;
        }
      }
    } else if (!isRace) {
      if (finishPos === 1) {
        gapDisplayStr = isQuali ? 'POLE' : 'P1';
      } else if (bestLap < Infinity && sessBestLap < Infinity && bestLap >= sessBestLap) {
        gapDisplayStr = `+${(bestLap - sessBestLap).toFixed(3)}s`;
      }
    }

    // ── Helper for Mini Tyre Badges ──
    const getMiniTyreBadge = (comp, size = 16) => {
      if (!comp) return '<span style="color:var(--text-muted);">—</span>';
      const cClass = getCompoundClass(comp);
      let bg = 'rgba(255,255,255,0.08)', color = 'var(--text-muted)';
      const char = comp[0] || '?';
      if (cClass.includes('soft')) { bg = 'var(--tyre-soft)'; color = '#fff'; }
      else if (cClass.includes('medium')) { bg = 'var(--tyre-medium)'; color = '#000'; }
      else if (cClass.includes('hard')) { bg = 'var(--tyre-hard)'; color = '#000'; }
      else if (cClass.includes('inter')) { bg = 'var(--tyre-inter)'; color = '#fff'; }
      else if (cClass.includes('wet')) { bg = 'var(--tyre-wet)'; color = '#fff'; }
      return `<span class="tyre-badge ${cClass}" style="width:${size}px;height:${size}px;font-size:${size >= 22 ? '0.66rem' : '0.5rem'};border-radius:50%;font-weight:900;display:inline-flex;align-items:center;justify-content:center;background:${bg};color:${color};border:1px solid rgba(255,255,255,0.12);line-height:1;flex-shrink:0;" title="${comp}">${char}</span>`;
    };

    // ── Enriched Stints & Proportional Strategy Strip ──
    const enrichedStints = driverStints.map((s, idx) => {
      const comp = (s.compound || 'UNKNOWN').toUpperCase();
      const cClass = getCompoundClass(comp);
      const lapStart = s.lap_start || 1;
      const lapEnd = s.lap_end || Math.max(lapStart, driverLaps.length || lapStart);
      const lapsCount = Math.max(1, lapEnd - lapStart + 1);
      const ageAtStart = typeof s.tyre_age_at_start === 'number' ? s.tyre_age_at_start : 0;
      const isUsed = s.tyre_new === false || s.tyre_new === 'false' || s.tyre_new === 0 || ageAtStart > 0;

      // Compute clean pace & linear degradation inside this stint
      const stintClean = cleanLapObjs.filter(cl => cl.lap >= lapStart && cl.lap <= lapEnd);
      const avgStintPace = stintClean.length > 0
        ? stintClean.reduce((sum, x) => sum + x.dur, 0) / stintClean.length
        : null;
      const bestStintObj = driverLaps
        .filter(l => l.lap_number >= lapStart && l.lap_number <= lapEnd && l.lap_duration && !l.is_pit_out_lap && (!isRace || l.lap_number > 1))
        .reduce((best, cur) => (!best || cur.lap_duration < best.lap_duration ? cur : best), null);

      let degSlope = null;
      if (stintClean.length >= 4) {
        const n = stintClean.length;
        const meanX = stintClean.reduce((s0, p0) => s0 + p0.lap, 0) / n;
        const meanY = avgStintPace;
        let num = 0, den = 0;
        for (const pt of stintClean) {
          num += (pt.lap - meanX) * (pt.dur - meanY);
          den += (pt.lap - meanX) * (pt.lap - meanX);
        }
        if (den > 0) degSlope = num / den;
      }

      const matchingPit = driverPits.find(p => Math.abs((p.lap_number || 0) - lapEnd) <= 1);

      return {
        stintNumber: s.stint_number || (idx + 1),
        comp,
        cClass,
        lapStart,
        lapEnd,
        lapsCount,
        ageAtStart,
        isUsed,
        avgStintPace,
        bestStintLap: bestStintObj ? bestStintObj.lap_duration : null,
        bestStintLapNum: bestStintObj ? bestStintObj.lap_number : null,
        degSlope,
        matchingPit
      };
    });

    const totalStintSpan = Math.max(1, enrichedStints.reduce((s0, st) => s0 + st.lapsCount, 0));
    const stintStripHtml = enrichedStints.length > 0 ? `
      <div class="pm-card-box" style="margin-bottom:var(--space-md);">
        <div class="pm-card-box-hdr">
          <span><i class="fa-solid fa-timeline" style="color:${teamColor};margin-right:6px;"></i>Compound Stint Proportion (${driverLaps.length} Laps)</span>
          <span class="pm-subtle-tag">${enrichedStints.length} Stint${enrichedStints.length !== 1 ? 's' : ''}${isRace ? ` · ${driverPits.length} Stop${driverPits.length !== 1 ? 's' : ''}` : ''}</span>
        </div>
        <div class="strategy-bar" style="height:28px;border-radius:6px;overflow:hidden;display:flex;gap:3px;background:rgba(0,0,0,0.3);padding:3px;">
          ${enrichedStints.map(st => `
            <div class="strategy-stint enhanced ${st.cClass} ${st.isUsed ? 'used-tyre' : ''}" style="width:${Math.max(5, (st.lapsCount / totalStintSpan) * 100)}%;border-radius:4px;" title="Stint #${st.stintNumber}: ${st.comp} (L${st.lapStart}–L${st.lapEnd}, ${st.lapsCount}L)">
              <span class="stint-comp-tag">${st.comp[0]}</span>
              ${st.lapsCount >= 3 ? `<span class="stint-laps-num">${st.lapsCount}L</span>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    const stintsCardsHtml = enrichedStints.length === 0
      ? `<div class="pm-empty-note">No tyre compound stint data recorded for this session.</div>`
      : `<div style="display:flex;flex-direction:column;gap:10px;">
          ${enrichedStints.map(st => {
            const stateTxt = st.isUsed ? `Used${st.ageAtStart > 0 ? ` (+${st.ageAtStart}L)` : ''}` : 'Fresh Set';
            const degStr = st.degSlope !== null ? `${st.degSlope >= 0 ? '+' : ''}${st.degSlope.toFixed(3)}s/lap` : '—';
            const degCol = st.degSlope === null ? 'var(--text-muted)' : (st.degSlope <= 0.02 ? '#2ecc71' : st.degSlope <= 0.09 ? '#fbbf24' : '#f87171');
            return `
              <div class="pm-stint-detail-card">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                  <div style="display:flex;align-items:center;gap:10px;">
                    ${getMiniTyreBadge(st.comp, 26)}
                    <div>
                      <div style="font-size:0.86rem;font-weight:800;color:var(--text-primary);">Stint #${st.stintNumber} · ${st.comp} <span class="dm-stint-pill" style="margin-left:4px;">${stateTxt}</span></div>
                      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:1px;">Lap ${st.lapStart} → Lap ${st.lapEnd} (${st.lapsCount} Lap${st.lapsCount !== 1 ? 's' : ''})</div>
                    </div>
                  </div>
                  <div class="pm-stint-metrics">
                    <div><span>Avg Clean</span><strong class="mono">${st.avgStintPace ? formatLapTime(st.avgStintPace) : '—'}</strong></div>
                    <div><span>Best Lap</span><strong class="mono" style="color:#c084fc;">${st.bestStintLap ? `${formatLapTime(st.bestStintLap)} (L${st.bestStintLapNum})` : '—'}</strong></div>
                    <div><span>Deg Trend</span><strong class="mono" style="color:${degCol};">${degStr}</strong></div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>`;

    // Pit Stops Section
    let pitsSectionHtml = '';
    if (isRace) {
      const totalPitLaneTime = driverPits.reduce((sum, p) => sum + (parseFloat(p.pit_duration) || 0), 0);
      const pitCards = driverPits.length === 0
        ? `<div class="pm-empty-note">Zero pit stops recorded during this ${sessionType}.</div>`
        : `<div style="display:flex;flex-direction:column;gap:8px;">
            ${driverPits.map((p, idx) => {
              const stopDur = p.stop_duration ? `${parseFloat(p.stop_duration).toFixed(2)}s stop` : null;
              const laneDur = p.pit_duration ? `${parseFloat(p.pit_duration).toFixed(2)}s lane` : null;
              const beforeSt = enrichedStints.find(s => Math.abs(s.lapEnd - p.lap_number) <= 2);
              const afterSt = enrichedStints.find(s => Math.abs(s.lapStart - p.lap_number) <= 2 && s !== beforeSt);
              const transHtml = (beforeSt && afterSt)
                ? `<span style="display:inline-flex;align-items:center;gap:5px;">${getMiniTyreBadge(beforeSt.comp, 16)} <i class="fa-solid fa-arrow-right" style="font-size:0.6rem;color:var(--text-muted);"></i> ${getMiniTyreBadge(afterSt.comp, 16)}</span>`
                : '';
              return `
                <div class="pm-pit-card">
                  <div style="display:flex;align-items:center;gap:10px;">
                    <span class="pm-num-pill" style="color:#fbbf24;border-color:rgba(251,191,36,0.3);">STOP #${idx + 1}</span>
                    <span style="font-weight:700;font-size:0.84rem;color:var(--text-primary);">Lap ${p.lap_number}</span>
                    ${transHtml}
                  </div>
                  <div class="mono" style="font-size:0.82rem;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:10px;">
                    ${stopDur ? `<span style="color:#fbbf24;"><i class="fa-solid fa-stopwatch"></i> ${stopDur}</span>` : ''}
                    ${laneDur ? `<span style="color:var(--text-secondary);">${laneDur}</span>` : (!stopDur ? '—' : '')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>`;

      pitsSectionHtml = `
        <div style="margin-top:var(--space-lg);">
          <div class="dm-section-title" style="margin-top:0;display:flex;align-items:center;justify-content:space-between;">
            <span><i class="fa-solid fa-wrench" style="color:#fbbf24;margin-right:6px;"></i>Pit Stop Telemetry (${driverPits.length})</span>
            ${totalPitLaneTime > 0 ? `<span class="pm-subtle-tag">Total Pit Loss: ${totalPitLaneTime.toFixed(2)}s</span>` : ''}
          </div>
          ${pitCards}
        </div>
      `;
    }

    // ── Qualifying Q1 / Q2 / Q3 Progression Section ──
    let qualiSegmentsSectionHtml = '';
    let q1Laps = [], q2Laps = [], q3Laps = [];
    if (isQuali) {
      const entry = finishEntry || {};
      const q1Str = entry.q1 ? formatLapTime(entry.q1) : '—';
      const q2Str = entry.q2 ? formatLapTime(entry.q2) : '—';
      const q3Str = entry.q3 ? formatLapTime(entry.q3) : '—';
      const qProg = (entry.q1 && entry.q3) ? (entry.q3 - entry.q1) : ((entry.q1 && entry.q2) ? (entry.q2 - entry.q1) : null);

      qualiSegmentsSectionHtml = `
        <div class="pm-card-box" style="margin-bottom:var(--space-md);">
          <div class="pm-card-box-hdr">
            <span><i class="fa-solid fa-layer-group" style="color:#a855f7;margin-right:6px;"></i>Qualifying Knockout Progression</span>
            ${qProg !== null ? `<span class="pm-subtle-tag" style="color:${qProg <= 0 ? '#2ecc71' : '#f87171'};">${qProg <= 0 ? '' : '+'}${qProg.toFixed(3)}s Evolution</span>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;">
            <div class="dm-stat-tile" style="padding:10px 8px;">
              <div class="dm-stat-label">Q1 / SQ1</div>
              <div class="mono" style="font-size:0.9rem;font-weight:800;color:var(--text-primary);margin-top:4px;">${q1Str}</div>
            </div>
            <div class="dm-stat-tile" style="padding:10px 8px;">
              <div class="dm-stat-label">Q2 / SQ2</div>
              <div class="mono" style="font-size:0.9rem;font-weight:800;color:${entry.q2 ? '#38bdf8' : 'var(--text-muted)'};margin-top:4px;">${q2Str}</div>
            </div>
            <div class="dm-stat-tile" style="padding:10px 8px;">
              <div class="dm-stat-label">Q3 / SQ3</div>
              <div class="mono" style="font-size:0.9rem;font-weight:800;color:${entry.q3 ? '#c084fc' : 'var(--text-muted)'};margin-top:4px;">${q3Str}</div>
            </div>
          </div>
        </div>
      `;

      if (raceDataCache.laps) {
        const partitioned = partitionQualiLaps(raceDataCache.laps);
        q1Laps = partitioned.q1 || [];
        q2Laps = partitioned.q2 || [];
        q3Laps = partitioned.q3 || [];
      }
    }

    // ── Sector Comparison Cards ──
    const buildSectorCard = (label, val, lapNum, sessBest) => {
      if (val >= Infinity) {
        return `
          <div class="pm-sector-card">
            <div class="pm-sector-lbl">${label}</div>
            <div class="pm-sector-val mono">—</div>
            <div class="pm-sector-sub">No data</div>
          </div>
        `;
      }
      const isPurple = sessBest < Infinity && Math.abs(val - sessBest) < 0.0005;
      const gapToPurple = (sessBest < Infinity && !isPurple && val > sessBest) ? `+${(val - sessBest).toFixed(3)}s` : null;
      const accent = isPurple ? '#c084fc' : '#2ecc71';
      return `
        <div class="pm-sector-card" style="border-color:${isPurple ? 'rgba(192,132,252,0.35)' : 'var(--border-subtle)'};">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
            <span class="pm-sector-lbl">${label}</span>
            <span class="pm-sector-badge" style="color:${accent};background:${accent}1a;">${isPurple ? '🟣 PURPLE' : '🟢 PB'}</span>
          </div>
          <div class="pm-sector-val mono" style="color:${isPurple ? '#c084fc' : 'var(--text-primary)'};">${val.toFixed(3)}s</div>
          <div class="pm-sector-sub">Lap ${lapNum}${gapToPurple ? ` · <span class="mono">${gapToPurple}</span>` : ''}</div>
        </div>
      `;
    };

    const hasSpeedTrap = topSpeed > 0;

    // ── Build Filterable Lap-by-Lap Rows ──
    const cleanLapNumSet = new Set(cleanLapObjs.map(c => c.lap));
    const lapRowsHtml = driverLaps.map(l => {
      const lapNum = l.lap_number;
      const isPB = l.lap_duration && l.lap_duration === bestLap;
      const isOutLap = Boolean(l.is_pit_out_lap);
      const isPitIn = pitLapSet.has(lapNum);
      const isClean = cleanLapNumSet.has(lapNum);

      let tags = '';
      if (isQuali && raceDataCache.laps) {
        if (q1Laps.some(ql => ql.driver_number === driverNumber && ql.lap_number === lapNum)) tags += ' <span class="pm-lap-tag">Q1</span>';
        else if (q2Laps.some(ql => ql.driver_number === driverNumber && ql.lap_number === lapNum)) tags += ' <span class="pm-lap-tag q2">Q2</span>';
        else if (q3Laps.some(ql => ql.driver_number === driverNumber && ql.lap_number === lapNum)) tags += ' <span class="pm-lap-tag q3">Q3</span>';
      }
      if (isOutLap) tags += ' <span class="pm-lap-tag pit">OUT</span>';
      else if (isPitIn) tags += ' <span class="pm-lap-tag pit">IN</span>';

      let deltaStr = '';
      if (l.lap_duration && bestLap < Infinity && !isPB) {
        const dlt = l.lap_duration - bestLap;
        if (dlt >= 0 && dlt < 30) deltaStr = ` <span style="font-size:0.64rem;color:var(--text-muted);">+${dlt.toFixed(2)}s</span>`;
      }

      const timeStr = l.lap_duration
        ? (isPB
            ? `<span style="color:${hasSessionFastestLap ? '#c084fc' : '#2ecc71'};font-weight:800;">${formatLapTime(l.lap_duration)} ${hasSessionFastestLap ? '🟣' : '🟢'}</span>`
            : `${formatLapTime(l.lap_duration)}${deltaStr}`)
        : '—';

      const fmtSec = (v, pb, sb) => {
        if (!v) return '<span style="color:var(--text-muted);">—</span>';
        const purp = sb < Infinity && Math.abs(v - sb) < 0.0005;
        const green = v === pb;
        const col = purp ? '#c084fc' : (green ? '#2ecc71' : 'var(--text-secondary)');
        return `<span class="mono" style="color:${col};font-weight:${(purp || green) ? '800' : '500'};">${v.toFixed(3)}</span>`;
      };

      const stint = driverStints.find(s => lapNum >= (s.lap_start || 1) && lapNum <= (s.lap_end || 999));
      const comp = stint ? stint.compound : null;
      const spd = l.st_speed || l.i2_speed || l.i1_speed || null;

      const filterCat = (isOutLap || isPitIn) ? 'pit' : (isClean ? 'clean' : 'other');

      return `
        <tr data-lap-cat="${filterCat}" data-lap-pb="${isPB ? '1' : '0'}">
          <td class="pm-td-mono" style="font-weight:700;color:var(--text-secondary);white-space:nowrap;">L${lapNum}${tags}</td>
          <td class="pm-td-mono" style="white-space:nowrap;">${timeStr}</td>
          <td>${fmtSec(l.duration_sector_1, bestS1, sessBestS1)}</td>
          <td>${fmtSec(l.duration_sector_2, bestS2, sessBestS2)}</td>
          <td>${fmtSec(l.duration_sector_3, bestS3, sessBestS3)}</td>
          ${hasSpeedTrap ? `<td class="pm-td-mono" style="text-align:right;color:${spd === topSpeed ? '#38bdf8' : 'var(--text-muted)'};">${spd ? `${Math.round(spd)}` : '—'}</td>` : ''}
          <td style="text-align:center;">${getMiniTyreBadge(comp, 16)}</td>
        </tr>
      `;
    }).join('');

    // ── Track Battles (Overtakes) + FIA Stewards Log ──
    let battlesSectionHtml = '';
    let driverBattlesCount = 0;
    if (isRace) {
      const allOvertakes = raceDataCache.overtakes || [];
      const myPasses = allOvertakes.filter(o => o.overtaking_driver_number === driverNumber);
      const passedBy = allOvertakes.filter(o => o.overtaken_driver_number === driverNumber);
      const netPasses = myPasses.length - passedBy.length;
      const combinedBattles = allOvertakes
        .filter(o => o.overtaking_driver_number === driverNumber || o.overtaken_driver_number === driverNumber)
        .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      driverBattlesCount = combinedBattles.length;

      const battleFeedHtml = combinedBattles.length === 0
        ? `<div class="pm-empty-note">No recorded on-track position passes involving ${d.name_acronym} in OpenF1 telemetry.</div>`
        : `<div class="pm-battle-list custom-scrollbar">
            ${combinedBattles.map(b => {
              const isGain = b.overtaking_driver_number === driverNumber;
              const rivalNum = isGain ? b.overtaken_driver_number : b.overtaking_driver_number;
              const rival = driverMap.get(rivalNum) || { name_acronym: `#${rivalNum}`, team_colour: '666666' };
              const rivalCol = getTeamColor(rival.team_colour);
              const lapLbl = b.lap_number ? `Lap ${b.lap_number}` : 'Race';
              const posLbl = b.position ? `for P${b.position}` : '';
              return `
                <div class="pm-battle-row ${isGain ? 'gain' : 'loss'}">
                  <span class="pm-battle-lap mono">${lapLbl}</span>
                  <span class="pm-battle-dir ${isGain ? 'up' : 'down'}">${isGain ? '▲ PASSED' : '▼ PASSED BY'}</span>
                  <span style="display:inline-flex;align-items:center;gap:6px;font-weight:700;color:var(--text-primary);">
                    <span style="width:7px;height:7px;border-radius:50%;background:${rivalCol};"></span>
                    ${rival.full_name || rival.name_acronym}
                  </span>
                  <span class="mono" style="margin-left:auto;font-size:0.72rem;color:var(--text-secondary);font-weight:700;">${posLbl}</span>
                </div>
              `;
            }).join('')}
          </div>`;

      battlesSectionHtml = `
        <div style="margin-bottom:var(--space-lg);">
          <div class="dm-section-title" style="margin-top:0;"><i class="fa-solid fa-arrows-left-right" style="color:#38bdf8;margin-right:6px;"></i>On-Track Overtakes & Battles</div>
          <div class="dm-stats-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:var(--space-sm);">
            <div class="dm-stat-tile" style="padding:10px 8px;">
              <div class="dm-stat-value" style="color:#2ecc71;font-size:1.25rem;">▲ ${myPasses.length}</div>
              <div class="dm-stat-label">Passes Made</div>
            </div>
            <div class="dm-stat-tile" style="padding:10px 8px;">
              <div class="dm-stat-value" style="color:#f87171;font-size:1.25rem;">▼ ${passedBy.length}</div>
              <div class="dm-stat-label">Times Passed</div>
            </div>
            <div class="dm-stat-tile" style="padding:10px 8px;">
              <div class="dm-stat-value" style="color:${netPasses > 0 ? '#2ecc71' : netPasses < 0 ? '#f87171' : 'var(--text-primary)'};font-size:1.25rem;">${netPasses > 0 ? `+${netPasses}` : netPasses}</div>
              <div class="dm-stat-label">Net Track Passes</div>
            </div>
          </div>
          ${battleFeedHtml}
        </div>
      `;
    }

    // Steward decisions & Race Control filtering
    const acronym = d.name_acronym || '';
    const lastName = d.full_name ? d.full_name.split(' ').pop().toUpperCase() : '';
    const numberStr = driverNumber.toString();

    const driverIncidents = (incidents || []).filter(inc => {
      if (inc.driver_number === driverNumber) return true;
      const msg = (inc.message || '').toUpperCase();
      return (acronym && !acronym.startsWith('#') && msg.includes(`(${acronym.toUpperCase()})`)) ||
             (acronym && !acronym.startsWith('#') && new RegExp(`\\b${acronym.toUpperCase()}\\b`).test(msg)) ||
             (lastName && lastName.length > 2 && msg.includes(lastName)) ||
             msg.includes(`CAR ${numberStr} `) ||
             msg.includes(`CAR ${numberStr},`) ||
             msg.includes(`CAR ${numberStr}.`) ||
             msg.includes(`CAR ${numberStr}(`) ||
             msg.endsWith(`CAR ${numberStr}`);
    });

    const incidentsHtml = driverIncidents.length === 0
      ? `<div class="pm-empty-note">Clean sheet — no FIA steward investigations, track-limit warnings, or penalties logged for Car #${driverNumber}.</div>`
      : `<div class="incidents-feed" style="margin-top:8px;max-height:320px;">
          ${driverIncidents.map(inc => {
            const msg = inc.message || '';
            const msgUpper = msg.toUpperCase();
            let catClass = 'incident-info';
            let icon = '<i class="fa-solid fa-circle-info" style="color: var(--text-muted);"></i>';
            if (msgUpper.includes('PENALTY') || msgUpper.includes('INVESTIGAT') || msgUpper.includes('STEWARDS') || msgUpper.includes('NOTED')) {
              catClass = 'incident-stewards';
              icon = '<i class="fa-solid fa-gavel" style="color: #c084fc;"></i>';
            } else if (msgUpper.includes('DELETED') || msgUpper.includes('TRACK LIMITS') || msgUpper.includes('BLACK AND WHITE')) {
              catClass = 'incident-flag-yellow';
              icon = '<i class="fa-solid fa-triangle-exclamation" style="color: #fbbf24;"></i>';
            }
            const lapText = inc.lap_number ? `Lap ${inc.lap_number}` : sessionType;
            const timeStr = inc.date ? new Date(inc.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
            return `
              <div class="incident-item ${catClass}" style="margin-bottom:8px;">
                <div class="incident-badge">${icon}</div>
                <div class="incident-card" style="padding:10px 14px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.05);">
                  <div class="incident-meta" style="margin-bottom:4px;">
                    <span class="incident-lap">${lapText}</span>
                    <span class="incident-time">${timeStr}</span>
                  </div>
                  <div class="incident-msg" style="font-size:0.78rem;line-height:1.4;">${msg}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>`;

    // ── Primary KPI Tiles ──
    const bestTimeStr = bestLap < Infinity ? formatLapTime(bestLap) : '—';
    const optTimeStr = theoreticalBest ? formatLapTime(theoreticalBest) : '—';
    const medPaceStr = medianCleanPace ? formatLapTime(medianCleanPace) : '—';
    const stdDevStr = cleanPaceStdDev !== null ? `±${cleanPaceStdDev.toFixed(2)}s` : '—';

    const kpiGridHtml = isRace ? `
      <div class="dm-stats-grid" style="margin-bottom:var(--space-sm);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:var(--text-secondary);">${startPos !== '—' ? `P${startPos}` : '—'}</div>
          <div class="dm-stat-label">Start Grid</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${(isDNF || isDSQ) ? 'var(--f1-red)' : (finishPos <= 3 ? '#ffd700' : 'var(--text-primary)')};">
            ${isDNS ? 'DNS' : isDSQ ? 'DSQ' : `P${finishPos}`}
          </div>
          <div class="dm-stat-label">${isDNF ? 'Retired (DNF)' : 'Classification'}</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${driverPts > 0 ? '#2ecc71' : 'var(--text-secondary)'};">${driverPts > 0 ? `+${driverPts}` : '0'}</div>
          <div class="dm-stat-label">Points Scored</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value mono" style="font-size:1.05rem;">${gapDisplayStr}</div>
          <div class="dm-stat-label">${finishPos === 1 ? 'Race Status' : 'Gap / Interval'}</div>
        </div>
      </div>
    ` : `
      <div class="dm-stats-grid" style="margin-bottom:var(--space-sm);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${finishPos <= 3 ? '#ffd700' : 'var(--text-primary)'};">P${finishPos}</div>
          <div class="dm-stat-label">Classification</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value mono" style="font-size:1.02rem;color:${hasSessionFastestLap ? '#c084fc' : 'var(--text-primary)'};">${bestTimeStr}</div>
          <div class="dm-stat-label">Best Lap (L${bestLapNum})</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value mono" style="font-size:1.02rem;">${gapDisplayStr}</div>
          <div class="dm-stat-label">Gap to P1</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${driverLaps.length}</div>
          <div class="dm-stat-label">Laps Run</div>
        </div>
      </div>
    `;

    const paceAnalyticsBoxHtml = `
      <div class="pm-card-box" style="margin-bottom:var(--space-md);">
        <div class="pm-card-box-hdr">
          <span><i class="fa-solid fa-gauge-simple-high" style="color:${teamColor};margin-right:6px;"></i>Lap Pace & Optimal Theoretical Envelope</span>
          ${topSpeed > 0 ? `<span class="pm-subtle-tag" style="color:#38bdf8;"><i class="fa-solid fa-wind"></i> ${Math.round(topSpeed)} km/h (L${topSpeedLap})</span>` : ''}
        </div>
        <div class="pm-micro-kpis">
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">Personal Best</span>
            <strong class="pm-micro-val mono" style="color:${hasSessionFastestLap ? '#c084fc' : 'var(--text-primary)'};">${bestTimeStr}${hasSessionFastestLap ? ' 🟣' : ''}</strong>
          </div>
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">Optimal (S1+2+3)</span>
            <strong class="pm-micro-val mono" style="color:#a855f7;">${optTimeStr}</strong>
          </div>
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">${isRace ? 'Median Clean Pace' : 'Potential Delta'}</span>
            <strong class="pm-micro-val mono">${isRace ? medPaceStr : (potentialGain !== null ? `−${potentialGain.toFixed(3)}s` : '—')}</strong>
          </div>
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">Clean Consistency</span>
            <strong class="pm-micro-val mono" style="color:${cleanPaceStdDev !== null && cleanPaceStdDev < 0.45 ? '#2ecc71' : 'var(--text-primary)'};">${stdDevStr}</strong>
          </div>
        </div>
      </div>
    `;

    const paceChartHtml = cleanLapObjs.length >= 3 ? `
      <div class="dm-section-title" style="margin-top:var(--space-md);">Clean Lap Pace Trace (${cleanLapObjs.length} Representative Laps)</div>
      <div class="dm-chart-wrap" style="padding:12px 10px 6px 6px;">
        <canvas id="rd-driver-pace-canvas" style="width:100%;height:155px;display:block;"></canvas>
      </div>
    ` : '';

    // ── Header & Segmented Tabs Assembly ──
    const flagInfo = DRIVER_NATIONALITY[d.name_acronym?.toUpperCase()];
    const flagBgUrl = flagInfo?.code ? `https://flagcdn.com/w320/${flagInfo.code}.png` : '';
    const rankBadgeTxt = isDNS ? 'DNS' : isDSQ ? 'DSQ' : `P${finishPos}`;
    const rankBadgeCls = (!isDNS && !isDSQ && finishPos === 1) ? 'pm-rank-p1'
      : (!isDNS && !isDSQ && finishPos === 2) ? 'pm-rank-p2'
        : (!isDNS && !isDSQ && finishPos === 3) ? 'pm-rank-p3' : '';

    const eventsCount = driverBattlesCount + driverIncidents.length;

    modal.innerHTML = `
      <div class="pm-topbar">
        <div class="pm-nav-group">
          <button type="button" class="pm-nav-btn" id="rd-prev-drv" ${!prevEntry ? 'disabled' : ''} title="${prevEntry ? `Previous: P${prevEntry.position || orderIdx} ${prevDrv.name_acronym} (←)` : 'First classified'}">
            <i class="fa-solid fa-chevron-left"></i>
            <span>${prevEntry ? `P${prevEntry.position || orderIdx} ${prevDrv.name_acronym}` : 'Prev'}</span>
          </button>
          <span class="pm-nav-indicator">${circuitName} · ${sessionType}</span>
          <button type="button" class="pm-nav-btn" id="rd-next-drv" ${!nextEntry ? 'disabled' : ''} title="${nextEntry ? `Next: P${nextEntry.position || (orderIdx + 2)} ${nextDrv.name_acronym} (→)` : 'Last classified'}">
            <span>${nextEntry ? `P${nextEntry.position || (orderIdx + 2)} ${nextDrv.name_acronym}` : 'Next'}</span>
            <i class="fa-solid fa-chevron-right"></i>
          </button>
        </div>
        <button class="driver-modal-close pm-inline-close" id="dm-close" aria-label="Close">✕</button>
      </div>

      <div class="dm-header pm-hero-header" style="--dm-team-color:${teamColor};color:${teamColor}">
        <div class="pm-hero-accent" style="background:${teamColor};"></div>
        ${flagBgUrl ? `<img class="dm-header-flag-bg" src="${flagBgUrl}" alt="" aria-hidden="true">` : ''}
        <div class="pm-avatar-wrap">
          <img class="dm-headshot" src="${d.headshot_url || ''}" alt="${d.name_acronym}" style="border-color:${teamColor}"
               onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect fill=%22%231a1a25%22 width=%2280%22 height=%2280%22/><text y=%2250%%22 x=%2250%%22 font-family=%22sans-serif%22 font-size=%2224%22 fill=%22%23777%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22>${d.name_acronym}</text></svg>'">
          <span class="pm-avatar-rank ${rankBadgeCls}" style="${finishPos > 3 || isDNS || isDSQ ? `border-color:${(isDNF || isDSQ) ? 'var(--f1-red)' : teamColor};color:${(isDNF || isDSQ) ? '#f87171' : teamColor};` : ''}">${rankBadgeTxt}</span>
        </div>
        <div class="dm-header-info">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span class="pm-num-pill" style="color:${teamColor};border-color:${teamColor}44;">#${driverNumber}</span>
            <span style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;color:${teamColor};">${d.team_name}</span>
            ${hasSessionFastestLap ? '<span class="pm-fl-pill"><i class="fa-solid fa-bolt"></i> Fastest Lap</span>' : ''}
            ${d.name_acronym && !d.name_acronym.startsWith('#') ? `
              <button type="button" class="modal-fav-pin-btn ${isFavoriteDriver(d.name_acronym) ? 'active' : ''}" id="rd-modal-fav-btn">
                <i class="fa-${isFavoriteDriver(d.name_acronym) ? 'solid' : 'regular'} fa-star"></i>
                <span>${isFavoriteDriver(d.name_acronym) ? 'Pinned' : 'Pin Driver'}</span>
              </button>
            ` : ''}
          </div>
          <div class="dm-driver-name" style="color:var(--text-primary);margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span>${d.full_name}</span>
            ${getDriverFlagImg(d.name_acronym, 'width:19px;border-radius:2px;')}
          </div>
          <div style="margin-top:5px;">${gainLossBadgeHtml}</div>
        </div>
        <div class="dm-driver-number" aria-hidden="true">${driverNumber}</div>
      </div>

      <div class="dm-body">
        <div class="dm-tabs pm-segmented-tabs" role="tablist">
          <button type="button" class="dm-tab active" data-tab="pace"><i class="fa-solid fa-stopwatch"></i> Overview & Pace</button>
          <button type="button" class="dm-tab" data-tab="strategy"><i class="fa-solid fa-circle-notch"></i> ${isRace ? 'Strategy & Pits' : 'Tyre Runs'} (${enrichedStints.length})</button>
          <button type="button" class="dm-tab" data-tab="laps"><i class="fa-solid fa-list-ol"></i> Laps (${driverLaps.length})</button>
          <button type="button" class="dm-tab" data-tab="events"><i class="fa-solid fa-${isRace ? 'bolt' : 'flag'}"></i> ${isRace ? 'Battles & FIA' : 'FIA Logs'}${eventsCount > 0 ? ` (${eventsCount})` : ''}</button>
        </div>

        <!-- TAB 1: Overview & Pace -->
        <div id="rd-tab-pace" class="dm-tab-content active">
          ${kpiGridHtml}
          ${qualiSegmentsSectionHtml}
          ${paceAnalyticsBoxHtml}

          <div class="dm-section-title" style="margin-top:0;">Sector Best Telemetry</div>
          <div class="pm-sectors-grid">
            ${buildSectorCard('Sector 1', bestS1, bestS1Num, sessBestS1)}
            ${buildSectorCard('Sector 2', bestS2, bestS2Num, sessBestS2)}
            ${buildSectorCard('Sector 3', bestS3, bestS3Num, sessBestS3)}
          </div>

          ${paceChartHtml}
        </div>

        <!-- TAB 2: Strategy & Pit Stops -->
        <div id="rd-tab-strategy" class="dm-tab-content">
          ${stintStripHtml}
          <div class="dm-section-title" style="margin-top:0;">Chronological Stint Breakdown</div>
          ${stintsCardsHtml}
          ${pitsSectionHtml}
        </div>

        <!-- TAB 3: Lap-by-Lap Telemetry -->
        <div id="rd-tab-laps" class="dm-tab-content">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            <div class="pm-filter-pills" id="rd-lap-filters">
              <button type="button" class="pm-filter-pill active" data-filter="all">All (${driverLaps.length})</button>
              <button type="button" class="pm-filter-pill" data-filter="clean">Clean (${cleanLapObjs.length})</button>
              <button type="button" class="pm-filter-pill" data-filter="pit">In / Out</button>
            </div>
            <span style="font-size:0.68rem;color:var(--text-muted);">🟣 Session Best · 🟢 Personal Best</span>
          </div>
          <div class="pm-table-wrap custom-scrollbar" style="max-height:380px;">
            <table class="pm-data-table">
              <thead>
                <tr>
                  <th>Lap</th>
                  <th>Lap Time</th>
                  <th>S1</th>
                  <th>S2</th>
                  <th>S3</th>
                  ${hasSpeedTrap ? '<th style="text-align:right;" title="Speed Trap (km/h)">km/h</th>' : ''}
                  <th style="text-align:center;">Tyre</th>
                </tr>
              </thead>
              <tbody id="rd-modal-laps-tbody">
                ${lapRowsHtml || `<tr><td colspan="${hasSpeedTrap ? 7 : 6}" style="text-align:center;color:var(--text-muted);padding:16px;">No laps recorded</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <!-- TAB 4: Battles & FIA Stewards -->
        <div id="rd-tab-events" class="dm-tab-content">
          ${battlesSectionHtml}
          <div>
            <div class="dm-section-title" style="margin-top:0;"><i class="fa-solid fa-gavel" style="color:#c084fc;margin-right:6px;"></i>FIA Race Control & Stewards (${driverIncidents.length})</div>
            ${incidentsHtml}
          </div>
        </div>
      </div>
    `;

    // ── Event Bindings ──
    document.getElementById('dm-close')?.addEventListener('click', closeModal);
    document.getElementById('rd-prev-drv')?.addEventListener('click', () => {
      if (prevEntry) showRaceDriverDetail(prevEntry.driver_number);
    });
    document.getElementById('rd-next-drv')?.addEventListener('click', () => {
      if (nextEntry) showRaceDriverDetail(nextEntry.driver_number);
    });

    const rdFavBtn = document.getElementById('rd-modal-fav-btn');
    if (rdFavBtn && d.name_acronym) {
      rdFavBtn.addEventListener('click', () => {
        const nowPinned = toggleFavoriteDriver(d.name_acronym);
        rdFavBtn.classList.toggle('active', nowPinned);
        rdFavBtn.innerHTML = `<i class="fa-${nowPinned ? 'solid' : 'regular'} fa-star"></i><span>${nowPinned ? 'Pinned' : 'Pin Driver'}</span>`;
      });
    }

    // Draw Clean Pace Trace Canvas
    const renderDriverPaceChart = () => {
      if (cleanLapObjs.length < 3) return;
      const canvas = document.getElementById('rd-driver-pace-canvas');
      if (!canvas) return;
      drawLineChart(
        canvas,
        [{
          label: d.name_acronym,
          data: cleanLapObjs.map(c => c.dur),
          color: teamColor
        }],
        {
          padTop: 14,
          padRight: 14,
          padBottom: 26,
          padLeft: 46,
          lineWidth: 2,
          showDots: cleanLapObjs.length <= 32,
          yDecimals: 1,
          xLabels: cleanLapObjs.map(c => `L${c.lap}`)
        }
      );
    };

    // Segmented Tab Switching
    const tabs = modal.querySelectorAll('.dm-tab');
    const panels = modal.querySelectorAll('.dm-tab-content');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-tab');
        tabs.forEach(t => t.classList.toggle('active', t === tab));
        panels.forEach(p => p.classList.toggle('active', p.id === `rd-tab-${target}`));
        if (target === 'pace') {
          requestAnimationFrame(renderDriverPaceChart);
        }
      });
    });

    // Lap Table Filter Pills
    const filterContainer = document.getElementById('rd-lap-filters');
    const lapsTbody = document.getElementById('rd-modal-laps-tbody');
    if (filterContainer && lapsTbody) {
      filterContainer.querySelectorAll('.pm-filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          const mode = pill.getAttribute('data-filter');
          filterContainer.querySelectorAll('.pm-filter-pill').forEach(p => p.classList.toggle('active', p === pill));
          lapsTbody.querySelectorAll('tr[data-lap-cat]').forEach(tr => {
            const cat = tr.getAttribute('data-lap-cat');
            const show = mode === 'all' || (mode === 'clean' && cat === 'clean') || (mode === 'pit' && cat === 'pit');
            tr.style.display = show ? '' : 'none';
          });
        });
      });
    }

    modal.scrollTop = 0;
    requestAnimationFrame(renderDriverPaceChart);

  } catch (error) {
    console.error('Failed to load driver race stats deep dive:', error);
    modal.innerHTML = `
      <button class="driver-modal-close" id="dm-close" aria-label="Close">✕</button>
      <div style="padding: 32px 24px; text-align: center; color: var(--f1-red); font-family:'Outfit',sans-serif;">
        <div style="font-size: 2.5rem; margin-bottom: 8px;">⚠️</div>
        <h3 style="font-size:1.15rem; font-weight:700; margin-bottom:4px;">Deep-Dive Loading Error</h3>
        <p style="font-size: 0.8rem; color: var(--text-muted);">Failed to compile detailed telemetry. Please check your network connection.</p>
      </div>
    `;
    document.getElementById('dm-close')?.addEventListener('click', closeModal);
  }
}

/**
 * Controller to switch active session detail between any weekend session type.
 * Clears cached telemetry objects so the new session loads fresh telemetry records.
 */
async function switchRaceDetailSession(sessionType) {
  if (!raceDataCache || raceDataCache.currentSessionType === sessionType) return;
  
  const session = raceDataCache.sessions[sessionType];
  if (!session) return;
  
  const isRace = isRaceSession(sessionType);
  
  const pillsContainer = $('#race-session-pills');
  if (pillsContainer) {
    pillsContainer.querySelectorAll('.session-pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.session === sessionType);
    });
  }
  
  raceDataCache.currentSessionType = sessionType;
  raceDataCache.sessionKey = session.session_key;
  raceDataCache.order = session.results || [];
  
  // Clear lazy-loaded telemetries so they get fetched fresh
  raceDataCache.laps = null;
  raceDataCache.stints = null;
  raceDataCache.pits = null;
  raceDataCache.overtakes = null;
  raceDataCache.incidents = null;
  raceDataCache.intervals = null;
  raceDataCache.driverTelemetry = {};
  raceDataCache.selectedLapDrivers = null;
  raceDataCache.selectedPositionDrivers = null;
  raceDataCache.lapTimesZoom = null;
  raceDataCache.positionsZoom = null;
  raceDataCache.overtakeFilterMode = 'all';
  raceDataCache.overtakeDriverFilter = 'all';
  raceDataCache.incidentCategory = 'all';
  raceDataCache.incidentQuery = '';
  
  // Update tab visibility for new session type
  updateTabVisibility(sessionType);
  
  // Render loading skeleton
  const content = $('#race-detail-content');
  content.innerHTML = Array(5).fill('<div class="skeleton skeleton-row"></div>').join('');
  
  const weatherBar = $('#race-weather-bar');
  loadAndRenderWeather(session.session_key, weatherBar);
  
  // Fetch fresh drivers for this session
  try {
    const sessionDrivers = await getSessionDrivers(session.session_key);
    if (sessionDrivers && sessionDrivers.length > 0) {
      raceDataCache.drivers = sessionDrivers;
      raceDataCache.driverMap = buildDriverMap(sessionDrivers);
    }
  } catch (err) {
    console.warn('[Race Detail] Failed to fetch session drivers:', err);
  }
  
  try {
    // Render current active tab layout in skeleton state
    renderTab();
    
    // Background enrichment — only fetch overtakes/intervals for race sessions
    const [laps, pits, overtakes, intervals] = await Promise.all([
      getLaps({ session_key: session.session_key }),
      getPits({ session_key: session.session_key }),
      isRace ? getOvertakes({ session_key: session.session_key }) : Promise.resolve([]),
      isRace ? getIntervals({ session_key: session.session_key }) : Promise.resolve([]),
    ]);
    
    if (raceDataCache && raceDataCache.sessionKey === session.session_key) {
      raceDataCache.laps = laps;
      raceDataCache.pits = pits;
      raceDataCache.overtakes = enrichOvertakesWithLaps(overtakes, laps);
      raceDataCache.intervals = intervals;
      
      // For qualifying sessions, always enrich the existing order with Q1/Q2/Q3 times from telemetry
      if (isQualifyingSession(sessionType)) {
        const telemetryOrder = buildQualifyingOrder(laps, raceDataCache.driverMap, sessionType);
        if (raceDataCache.order && raceDataCache.order.length > 0) {
          const telemetryMap = new Map(telemetryOrder.map(r => [r.driver_number, r]));
          raceDataCache.order = raceDataCache.order.map(entry => {
            const tel = telemetryMap.get(entry.driver_number);
            return tel ? { ...entry, q1: tel.q1, q2: tel.q2, q3: tel.q3, bestLap: tel.bestLap || entry.bestLap } : entry;
          });
        } else {
          raceDataCache.order = telemetryOrder;
        }
      } else if (!isRace && (!raceDataCache.order || raceDataCache.order.length === 0)) {
        raceDataCache.order = buildQualifyingOrder(laps, raceDataCache.driverMap, sessionType);
      }
      
      if (currentTab === 'results') {
        renderResults(content);
      } else if (currentTab === 'overtakes') {
        renderOvertakes(content);
      }
    }
  } catch (err) {
    console.warn('[Race Detail] Switch session enrichment failed:', err);
  }
}

// ── Future Weekend Schedule Modal ──

let scheduleInterval = null;

function parseGmtOffset(offsetStr) {
  if (!offsetStr) return 0;
  const parts = offsetStr.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  const seconds = parts.length > 2 ? parseInt(parts[2], 10) : 0;
  const sign = hours < 0 || offsetStr.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(hours) * 3600000 + minutes * 60000 + seconds * 1000);
}

function generateFallbackSessions(gp) {
  const startDay = new Date(gp.date_start);
  
  // Clean startDay to midnight UTC of the start date
  const baseTime = Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate());
  
  // Standard track times (in hours since midnight of that day)
  const scheduleDef = [
    { name: 'Practice 1', dayOffset: 0, startHour: 13.5, durationHours: 1 },
    { name: 'Practice 2', dayOffset: 0, startHour: 17.0, durationHours: 1 },
    { name: 'Practice 3', dayOffset: 1, startHour: 12.5, durationHours: 1 },
    { name: 'Qualifying', dayOffset: 1, startHour: 16.0, durationHours: 1 },
    { name: 'Race', dayOffset: 2, startHour: 15.0, durationHours: 2 }
  ];
  
  // Parse GMT offset in hours to shift UTC times
  const tzHours = parseInt((gp.gmt_offset || '00:00:00').split(':')[0], 10);
  
  return scheduleDef.map(def => {
    // start time in UTC = baseTime + dayOffset (in ms) + startHour (in ms) - tzHours (in ms)
    const startMs = baseTime + (def.dayOffset * 24 * 3600000) + (def.startHour * 3600000) - (tzHours * 3600000);
    const endMs = startMs + (def.durationHours * 3600000);
    
    return {
      session_name: def.name,
      session_type: def.name === 'Qualifying' ? 'Qualifying' : (def.name === 'Race' ? 'Race' : 'Practice'),
      date_start: new Date(startMs).toISOString(),
      date_end: new Date(endMs).toISOString(),
      session_key: `mock_${def.name.toLowerCase().replace(' ', '_')}`
    };
  });
}

export async function showFutureRaceSchedule(gp) {
  ensureOverlay();
  const modal = document.getElementById('driver-modal');
  const accentColor = 'var(--f1-red)';
  const accentColorAlpha = 'rgba(225, 6, 0, 0.15)';

  const now = new Date();
  const startDate = new Date(gp.date_start);
  const endDate = new Date(gp.date_end);

  let statusText = 'Upcoming Event';
  let statusBg = 'rgba(225,6,0,0.1)';
  let statusColor = 'var(--f1-red)';

  if (now > endDate) {
    statusText = 'Concluded Event';
    statusBg = 'rgba(255,255,255,0.06)';
    statusColor = 'var(--text-muted)';
  } else if (now >= startDate && now <= endDate) {
    statusText = 'Active Event';
    statusBg = 'rgba(46,204,113,0.15)';
    statusColor = '#2ecc71';
  }

  // Build header with circuit image fallback
  const circuitAvatar = gp.circuit_image
    ? `<div class="dm-header-avatar" style="border-radius:var(--radius-md); background: rgba(255,255,255,0.02); border-color: rgba(255,255,255,0.1); width: 100px; height: 75px; padding: 4px;"><img src="${gp.circuit_image}" alt="${gp.circuit_short_name}" style="width: 100%; height: 100%; object-fit: contain; filter: invert(1);"></div>`
    : '';

  modal.innerHTML = `
    <button class="driver-modal-close" id="dm-close" aria-label="Close">✕</button>
    
    <!-- Modal Header Banner -->
    <div class="dm-header-banner" style="--dm-team-color: var(--f1-red); --dm-team-color-alpha: rgba(225, 6, 0, 0.15);">
      <div class="dm-header-bar"></div>
      ${gp.country_flag ? `<img class="dm-header-flag-bg" src="${gp.country_flag}" alt="" aria-hidden="true">` : ''}
      
      ${circuitAvatar}
      
      <div style="flex: 1; min-width: 200px; z-index: 1; position: relative;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-family:'Outfit',sans-serif; font-size:0.75rem; font-weight:800; color:${statusColor}; background:${statusBg}; padding:2px 8px; border-radius:4px; text-transform:uppercase; letter-spacing:0.05em;">${statusText}</span>
          <span style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; color:var(--text-secondary);">${gp.circuit_short_name}, ${gp.country_name}</span>
        </div>
        <h2 style="font-family:'Outfit',sans-serif; font-size:1.5rem; font-weight:800; margin: 6px 0 2px 0; color:var(--text-primary);">
          ${gp.meeting_name}
        </h2>
        <div style="font-size:0.85rem; color:var(--text-muted); display:flex; align-items:center; gap:6px; font-weight:500;">
          <i class="fa-regular fa-calendar-days" style="color:var(--text-muted);"></i>
          <span>${formatDateRange(gp.date_start, gp.date_end)}</span>
        </div>
      </div>
    </div>
    
    <!-- Countdown Banner -->
    <div id="schedule-countdown-banner" style="padding: 12px 24px; background: rgba(0,0,0,0.12); border-bottom: 1px solid var(--border-subtle); font-size: 0.85rem; color: var(--text-secondary); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
      <span id="countdown-text" style="font-family:'Outfit',sans-serif; font-weight:600;">Loading weekend sessions...</span>
    </div>
    
    <!-- Sessions Schedule Body -->
    <div style="padding: 24px; display: flex; flex-direction: column; gap: 16px;" id="schedule-sessions-list">
      <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
        <div class="skeleton skeleton-row" style="height:56px; width:100%;"></div>
        <div class="skeleton skeleton-row" style="height:56px; width:100%;"></div>
        <div class="skeleton skeleton-row" style="height:56px; width:100%;"></div>
      </div>
    </div>
  `;

  document.getElementById('dm-close').addEventListener('click', closeModal);
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  try {
    let sessions = await getMeetingSessions(gp.meeting_key);
    let isFallback = false;

    // Filter out cancelled and sort chronologically
    sessions = (sessions || []).filter(s => !s.is_cancelled);

    if (sessions.length === 0) {
      sessions = generateFallbackSessions(gp);
      isFallback = true;
    } else {
      sessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    }

    const sessionsListEl = document.getElementById('schedule-sessions-list');
    const countdownTextEl = document.getElementById('countdown-text');
    const trackOffsetMs = parseGmtOffset(gp.gmt_offset || '00:00:00');

    // Build timezone offset label (e.g. GMT+2)
    const sign = (gp.gmt_offset || '00:00:00').startsWith('-') ? '' : '+';
    const tzHours = (gp.gmt_offset || '00:00:00').split(':')[0];
    const gmtLabel = `GMT${sign}${parseInt(tzHours, 10)}`;

    let sessionsHtml = '';

    // If fallback is shown, display the warning banner/disclaimer
    if (isFallback) {
      sessionsHtml += `
        <div style="padding: 10px 14px; background: rgba(225, 6, 0, 0.05); border: 1px solid var(--border-accent); border-radius: var(--radius-md); display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px;">
          <i class="fa-solid fa-circle-exclamation" style="color: var(--f1-red); font-size: 1.1rem; margin-top: 2px;"></i>
          <div style="font-size: 0.76rem; color: var(--text-secondary); line-height: 1.45;">
            <strong style="color: var(--text-primary); display: block; margin-bottom: 2px;">Estimated Schedule Displayed</strong>
            Official session times are not yet published for this GP weekend. Displaying standard timeline approximations. Official sessions may vary depending on local promoter schedule changes.
          </div>
        </div>
      `;
    }

    sessionsHtml += `<div style="display:flex; flex-direction:column; gap:12px;">`;

    sessions.forEach(s => {
      const now = new Date();
      const start = new Date(s.date_start);
      const end = new Date(s.date_end);

      let statusBadge = '';
      let isLive = false;
      let opacityStyle = '';

      if (now > end) {
        statusBadge = `<span style="font-size:0.65rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; background:rgba(255,255,255,0.03); padding:2px 8px; border-radius:100px; border:1px solid var(--border-subtle);"><i class="fa-solid fa-check" style="margin-right:3px;"></i> Concluded</span>`;
        opacityStyle = 'opacity: 0.55;';
      } else if (now >= start && now <= end) {
        statusBadge = `<span style="font-size:0.65rem; font-weight:800; color:white; text-transform:uppercase; background:var(--f1-red); padding:2px 8px; border-radius:100px; animation:pulse 2s infinite; display:inline-flex; align-items:center; gap:4px;"><span style="width:5px; height:5px; background:white; border-radius:50%; display:inline-block;"></span> LIVE</span>`;
        isLive = true;
      } else {
        statusBadge = `<span style="font-size:0.65rem; font-weight:700; color:var(--text-secondary); text-transform:uppercase; background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:100px; border:1px solid var(--border-subtle);">Upcoming</span>`;
      }

      // Determine session icon
      let icon = '<i class="fa-solid fa-gauge-high" style="color: var(--text-secondary);"></i>';
      if (s.session_name.includes('Qualifying')) {
        icon = '<i class="fa-solid fa-stopwatch" style="color: #ffd000;"></i>';
      } else if (s.session_name.includes('Sprint')) {
        icon = '<i class="fa-solid fa-bolt" style="color: #a855f7;"></i>';
      } else if (s.session_name === 'Race') {
        icon = '<i class="fa-solid fa-flag-checkered" style="color: var(--f1-red);"></i>';
      }

      // 1. User Local Time
      const dateOptions = { weekday: 'short', month: 'short', day: 'numeric' };
      const timeOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
      const localDate = start.toLocaleDateString(undefined, dateOptions);
      const localStart = start.toLocaleTimeString(undefined, timeOptions);
      const localEnd = end.toLocaleTimeString(undefined, timeOptions);
      const tz = start.toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop();

      // 2. Track Local Time
      const trackStart = new Date(start.getTime() + trackOffsetMs);
      const trackEnd = new Date(end.getTime() + trackOffsetMs);
      const trackDate = trackStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
      const trackStartStr = trackStart.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
      const trackEndStr = trackEnd.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

      sessionsHtml += `
        <div style="background:var(--bg-card); border:1px solid ${isLive ? 'var(--border-accent)' : 'var(--border-subtle)'}; border-radius:var(--radius-md); padding:14px 18px; display:flex; flex-direction:column; gap:8px; ${opacityStyle}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
            <div style="display:flex; align-items:center; gap:10px; font-family:'Outfit',sans-serif; font-weight:700; font-size:0.95rem; color:var(--text-primary);">
              <span style="width:28px; height:28px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:50%; display:inline-flex; align-items:center; justify-content:center;">
                ${icon}
              </span>
              <span>${s.session_name}</span>
            </div>
            ${statusBadge}
          </div>
          
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:8px; border-top: 1px solid rgba(255,255,255,0.03); padding-top:8px; margin-top:2px;">
            <div>
              <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.03em;">Your Local Time</div>
              <div style="font-size:0.8rem; font-weight:700; color:var(--text-primary); margin-top:2px;">
                ${localDate} • ${localStart} – ${localEnd} <span style="font-size:0.65rem; color:var(--text-secondary); font-weight:600; padding:1px 5px; background:rgba(255,255,255,0.05); border-radius:3px; margin-left:3px;">${tz}</span>
              </div>
            </div>
            <div>
              <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.03em;">Track Local Time</div>
              <div style="font-size:0.8rem; font-weight:600; color:var(--text-secondary); margin-top:2px;">
                ${trackDate} • ${trackStartStr} – ${trackEndStr} <span style="font-size:0.65rem; color:var(--text-muted); font-weight:500; margin-left:3px;">(${gmtLabel})</span>
              </div>
            </div>
          </div>
        </div>
      `;
    });

    sessionsHtml += `</div>`;
    sessionsListEl.innerHTML = sessionsHtml;

    // Start ticking countdown timer
    if (scheduleInterval) clearInterval(scheduleInterval);

    function tickCountdown() {
      const now = new Date();
      
      // Find the next upcoming session, or currently live session
      let nextSession = null;
      let liveSession = null;

      for (const s of sessions) {
        const start = new Date(s.date_start);
        const end = new Date(s.date_end);
        if (now >= start && now <= end) {
          liveSession = s;
          break;
        }
        if (start > now) {
          nextSession = s;
          break;
        }
      }

      if (liveSession) {
        countdownTextEl.innerHTML = `
          <span style="color:var(--f1-red); font-weight:800; display:flex; align-items:center; gap:6px;">
            <span style="width:8px; height:8px; background:var(--f1-red); border-radius:50%; animation:pulse 2s infinite; display:inline-block;"></span>
            ${liveSession.session_name} IS LIVE NOW!
          </span>
        `;
      } else if (nextSession) {
        const diffMs = new Date(nextSession.date_start).getTime() - now.getTime();
        const days = Math.floor(diffMs / (24 * 3600000));
        const hours = Math.floor((diffMs % (24 * 3600000)) / 3600000);
        const minutes = Math.floor((diffMs % 3600000) / 60000);
        const seconds = Math.floor((diffMs % 60000) / 1000);

        let timeStr = '';
        if (days > 0) timeStr += `${days}d `;
        timeStr += `${hours}h ${minutes}m ${seconds}s`;

        countdownTextEl.innerHTML = `
          <span style="color:var(--text-secondary); font-weight:600; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-stopwatch animate-pulse" style="color: var(--f1-red);"></i>
            <span>${nextSession.session_name} starts in:</span>
          </span>
          <span style="font-family:'JetBrains Mono',monospace; font-weight:800; color:var(--text-primary); font-size:0.9rem;">${timeStr}</span>
        `;
      } else {
        countdownTextEl.innerHTML = `
          <span style="color:var(--text-muted); font-weight:600; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-flag-checkered"></i>
            <span>This GP weekend has concluded. Results are compiling.</span>
          </span>
        `;
      }
    }

    tickCountdown();
    scheduleInterval = setInterval(tickCountdown, 1000);

  } catch (err) {
    console.error('[Race Schedule] Failed to load schedule:', err);
    sessionsListEl.innerHTML = `
      <div class="no-data">
        <div class="no-data-text">Failed to fetch race schedule. Please try clearing your cache or reloading.</div>
      </div>
    `;
    countdownTextEl.innerHTML = `<span style="color:var(--f1-red);">Offline / Error loading schedule</span>`;
  }
}



