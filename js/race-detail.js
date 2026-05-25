// =============================================
// F1 CORNER — Race Deep-Dive Section
// Lazy-loads heavy charts and feeds to avoid API timeouts
// =============================================

import { getLaps, getStints, getPits, getOvertakes, getSessionDrivers, getRaceControl, getWeather, getIntervals, getPositions } from './api.js';
import { getSeasonData, getResultsForSession } from './season-data.js';
import { formatLapTime, formatGap, getTeamColor, getCompoundColor, getCompoundClass, getDriverFlagImg, getPointsForPosition, isPast, buildDriverMap, $, $$ } from './utils.js';
import { drawLineChart, drawPositionChart } from './charts.js';

let currentTab = 'results';
let raceDataCache = null;

export async function loadRaceDetail(sessionKey, meetingInfo) {
  const section = $('#race-detail');
  const header = $('#race-detail-header');
  const content = $('#race-detail-content');
  const weatherBar = $('#race-weather-bar');

  section.style.display = 'block';
  header.innerHTML = `
    <div class="race-detail-title">${meetingInfo.meeting_name}</div>
    <div style="color:var(--text-muted);font-size:0.85rem;">${meetingInfo.circuit_short_name}, ${meetingInfo.country_name}</div>
  `;

  content.innerHTML = Array(5).fill('<div class="skeleton skeleton-row"></div>').join('');

  try {
    const year = meetingInfo.year || new Date(meetingInfo.date_start).getFullYear();

    // Trigger weather load instantly in background
    loadAndRenderWeather(sessionKey, weatherBar);

    // 1. Fetch only seasonData and drivers list (extremely light & fast!)
    const [seasonData, drivers] = await Promise.all([
      getSeasonData(year),
      getSessionDrivers(sessionKey),
    ]);

    // Check for Sprint session on this race weekend
    const meetingSessions = seasonData.races.filter(r => r.meeting_key === meetingInfo.meeting_key);
    const gpSession = meetingSessions.find(r => r.session_name === 'Race') || { session_key: sessionKey, results: getResultsForSession(seasonData, sessionKey) };
    const sprintSession = meetingSessions.find(r => r.session_name === 'Sprint');
    const hasSprint = !!sprintSession;

    // Render title with Saturday Sprint switch toggle if available
    header.innerHTML = `
      <div class="race-detail-title">${meetingInfo.meeting_name}</div>
      <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:6px;">
        <span style="color:var(--text-muted);font-size:0.85rem;">${meetingInfo.circuit_short_name}, ${meetingInfo.country_name}</span>
        ${hasSprint ? `
          <div class="session-selector-toggle" style="display:inline-flex; background:rgba(0,0,0,0.25); border:1px solid var(--border-subtle); padding:2px; border-radius:100px; margin-left:12px;">
            <button class="toggle-btn" data-session-type="Race" style="font-family:inherit; font-size:0.7rem; font-weight:700; padding:4px 12px; border-radius:100px; border:none; background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer; transition:all 150ms ease; box-shadow: 0 2px 6px rgba(0,0,0,0.25);">Grand Prix</button>
            <button class="toggle-btn" data-session-type="Sprint" style="font-family:inherit; font-size:0.7rem; font-weight:700; padding:4px 12px; border-radius:100px; border:none; background:transparent; color:var(--text-secondary); cursor:pointer; transition:all 150ms ease;">Sprint</button>
          </div>
        ` : ''}
      </div>
    `;

    const sessions = { Race: gpSession };
    if (sprintSession) sessions.Sprint = sprintSession;

    const order = gpSession.results || [];
    const driverMap = buildDriverMap(drivers);

    // Initial minimal cache
    raceDataCache = { 
      sessionKey, 
      meetingInfo, 
      order, 
      drivers, 
      driverMap,
      sessions,
      currentSessionType: 'Race',
      laps: null,
      stints: null,
      pits: null,
      overtakes: null,
      incidents: null,
      weather: null,
      intervals: null,
      driverTelemetry: {}
    };

    if (hasSprint) {
      const btns = header.querySelectorAll('.toggle-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          btns.forEach(b => {
            b.style.background = 'transparent';
            b.style.color = 'var(--text-secondary)';
            b.style.boxShadow = 'none';
          });
          btn.style.background = 'var(--bg-tertiary)';
          btn.style.color = 'var(--text-primary)';
          btn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.25)';
          
          switchRaceDetailSession(btn.dataset.sessionType);
        });
      });
    }

    // Reset tab to results
    currentTab = 'results';
    const tabs = document.querySelectorAll('#race-detail-tabs button');
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === 'results'));

    renderTab();
    setupTabs();

    // Scroll to section smoothly
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // 2. Background Enrichment: fetch detailed lap, pit, and overtake counts asynchronously
    Promise.all([
      getLaps({ session_key: sessionKey }),
      getPits({ session_key: sessionKey }),
      getOvertakes({ session_key: sessionKey }),
      getIntervals({ session_key: sessionKey }),
    ]).then(([laps, pits, overtakes, intervals]) => {
      // Safely update cache if we are still viewing the same race session
      if (raceDataCache && raceDataCache.sessionKey === sessionKey) {
        raceDataCache.laps = laps;
        raceDataCache.pits = pits;
        raceDataCache.overtakes = overtakes;
        raceDataCache.intervals = intervals;
        
        // Dynamic pop-in: re-render results tab if active
        if (currentTab === 'results') {
          renderResults(content);
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

  if (order.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-icon"><i class="fa-solid fa-car-side fa-3x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div><div class="no-data-text">No results data available for this race</div></div>';
    return;
  }

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

    // Backwards propagation to correct missing telemetry records for lead lap finishers
    const validOrder = order.filter(o => o.status !== 'DNS' && o.status !== 'DSQ');
    for (let i = validOrder.length - 2; i >= 0; i--) {
      const currentDriver = validOrder[i].driver_number;
      const nextDriver = validOrder[i+1].driver_number;
      const currentLap = computedLapCounts.get(currentDriver) || 0;
      const nextLap = computedLapCounts.get(nextDriver) || 0;
      computedLapCounts.set(currentDriver, Math.max(currentLap, nextLap));
    }
  }

  // Find fastest lap
  let fastestLap = Infinity;
  let fastestLapDriver = null;
  if (laps) {
    for (const lap of laps) {
      if (lap.lap_duration && !lap.is_pit_out_lap && lap.lap_number > 2 && lap.lap_duration < fastestLap) {
        fastestLap = lap.lap_duration;
        fastestLapDriver = lap.driver_number;
      }
    }
  }

  // Key stats
  const totalLaps = laps ? maxSessionLap : '…';
  const leaderChanges = overtakes ? new Set(
    overtakes.filter(o => o.position === 1).map(o => o.overtaking_driver_number)
  ).size : '…';
  const overtakesCount = overtakes ? overtakes.length : '…';
  const fastestLapTimeStr = fastestLap < Infinity ? formatLapTime(fastestLap) : '…';

  let html = `
    <div class="key-stats-grid">
      <div class="key-stat">
        <div class="key-stat-value">${totalLaps}</div>
        <div class="key-stat-label">Total Laps</div>
      </div>
      <div class="key-stat">
        <div class="key-stat-value">${overtakesCount}</div>
        <div class="key-stat-label">Overtakes</div>
      </div>
      <div class="key-stat">
        <div class="key-stat-value">${leaderChanges}</div>
        <div class="key-stat-label">Lead Changes</div>
      </div>
      <div class="key-stat">
        <div class="key-stat-value">${fastestLapTimeStr}</div>
        <div class="key-stat-label">Fastest Lap</div>
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
          <th>Laps</th>
          <th>Best Lap</th>
          <th>Pts</th>
          <th>Status</th>
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

  for (const { driver_number, position, status } of order) {
    const d = driverMap.get(driver_number) || { name_acronym: `#${driver_number}`, team_name: '?', team_colour: '666', full_name: `Driver #${driver_number}`, headshot_url: '' };
    const teamColor = getTeamColor(d.team_colour);
    
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
    let pts = isDSQ ? 0 : getPointsForPosition(position);
    const awardFastestLap = raceDataCache.meetingInfo.year < 2025;
    if (awardFastestLap && isFastest && position <= 10 && status === 'FINISHED') {
      pts += 1;
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
          statusText = `<span style="color:var(--text-secondary);font-size:0.75rem;font-family:\'JetBrains Mono\',monospace;">+${entry.gap_to_leader.toFixed(3)}s</span>`;
        } else {
          const stops = driverPits ? driverPits.length : 0;
          statusText = `<span style="color:var(--text-secondary);font-size:0.75rem;">${stops} Stop${stops !== 1 ? 's' : ''}</span>`;
        }
      }
    }

    html += `
      <tr class="clickable-driver-row" data-driver-number="${driver_number}" style="cursor:pointer;" title="Click for driver race deep-dive stats">
        <td><span class="position-badge ${posClass}">${displayPos}</span></td>
        <td>
          <div class="driver-cell">
            <div class="team-color-bar" style="background:${teamColor}"></div>
            <img class="driver-headshot" src="${d.headshot_url || ''}" alt="${d.name_acronym}" loading="lazy" onerror="this.style.display='none'" style="width:32px;height:32px;">
            <div class="driver-info">
              <div class="driver-name">${d.full_name || d.name_acronym}</div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-muted);font-size:0.8rem;">${d.team_name}</td>
        <td class="mono" style="font-size:0.8rem;">${driverLapCount}</td>
        <td class="mono ${isFastest ? 'fastest-lap' : ''}" style="font-size:0.8rem;">${isDNS ? '—' : (bestLap ? formatLapTime(bestLap) : '…')} ${isFastest ? '<span style="color:#a855f7;font-size:0.65rem;margin-left:4px;" title="Fastest Lap">🟣</span>' : ''}</td>
        <td class="points-cell" style="color:${pts > 0 ? 'var(--text-primary)' : 'var(--text-muted)'}">${pts || '—'}${awardFastestLap && isFastest && position <= 10 ? '<span style="color:#a855f7;font-size:0.65rem;margin-left:4px;" title="Includes +1 fastest lap bonus">+1</span>' : ''}</td>
        <td style="text-align:center;">${statusText}</td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  container.innerHTML = html;

  // Bind clicks to driver rows for deep-dive stats modal
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
  if (raceDataCache.overtakes) {
    renderOvertakes(container);
    return;
  }
  container.innerHTML = Array(4).fill('<div class="skeleton skeleton-row"></div>').join('');
  try {
    const overtakes = await getOvertakes({ session_key: raceDataCache.sessionKey });
    raceDataCache.overtakes = overtakes;
    renderOvertakes(container);
  } catch (e) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load overtakes feed. Please try again.</div></div>';
  }
}

// ── Tab Renderers ──

function renderLapTimes(container) {
  const { laps, order, driverMap } = raceDataCache;

  if (laps.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">No lap time data available</div></div>';
    return;
  }

  const topDrivers = order.slice(0, 10);
  const maxLap = Math.max(...laps.map(l => l.lap_number).filter(n => !isNaN(n)), 0);

  const datasets = topDrivers.map(({ driver_number }) => {
    const d = driverMap.get(driver_number) || {};
    const driverLaps = laps.filter(l => l.driver_number === driver_number);

    const data = new Array(maxLap).fill(null);
    for (const l of driverLaps) {
      if (l.lap_duration && !l.is_pit_out_lap && l.lap_number > 1) {
        data[l.lap_number - 1] = l.lap_duration;
      }
    }

    return {
      label: d.name_acronym || `#${driver_number}`,
      data,
      color: getTeamColor(d.team_colour),
      alpha: 0.7,
    };
  });

  container.innerHTML = `
    <div class="chart-container">
      <div class="chart-title">Lap Times — Top 10 Finishers</div>
      <canvas class="chart-canvas" id="laptimes-chart"></canvas>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
      ${datasets.map(ds => `
        <span style="display:inline-flex;align-items:center;gap:4px;font-size:0.72rem;color:var(--text-muted);">
          <span style="width:12px;height:3px;background:${ds.color};border-radius:2px;display:inline-block;"></span>
          ${ds.label}
        </span>
      `).join('')}
    </div>
  `;

  requestAnimationFrame(() => {
    const canvas = document.getElementById('laptimes-chart');
    if (canvas) drawLineChart(canvas, datasets, { xLabel: 'Lap' });
  });
}

function renderPositions(container) {
  const { laps, order, driverMap } = raceDataCache;

  if (laps.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">No position data available</div></div>';
    return;
  }

  const topDrivers = order.slice(0, 10);
  const maxLap = Math.max(...laps.map(l => l.lap_number).filter(n => !isNaN(n)), 0);

  // Build cumulative time per driver and rank
  const allDriverNums = [...new Set(laps.map(l => l.driver_number))];
  const driverCumTime = new Map();

  for (const dn of allDriverNums) {
    const dLaps = laps.filter(l => l.driver_number === dn).sort((a, b) => a.lap_number - b.lap_number);
    let cumTime = 0;
    const cumArr = [];
    for (const l of dLaps) {
      cumTime += (l.lap_duration || 200);
      cumArr.push({ lap: l.lap_number, cumTime });
    }
    driverCumTime.set(dn, cumArr);
  }

  // For each lap, rank drivers by cumulative time
  const positionsByLap = new Map();
  for (const dn of allDriverNums) {
    positionsByLap.set(dn, new Array(maxLap).fill(null));
  }

  for (let lap = 1; lap <= maxLap; lap++) {
    const rankings = [];
    for (const dn of allDriverNums) {
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

  const datasets = topDrivers.map(({ driver_number }) => {
    const d = driverMap.get(driver_number) || {};
    return {
      label: d.name_acronym || `#${driver_number}`,
      data: positionsByLap.get(driver_number) || [],
      color: getTeamColor(d.team_colour),
    };
  });

  container.innerHTML = `
    <div class="chart-container">
      <div class="chart-title">Position Changes — Top 10</div>
      <canvas class="chart-canvas" id="positions-chart"></canvas>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
      ${datasets.map(ds => `
        <span style="display:inline-flex;align-items:center;gap:4px;font-size:0.72rem;color:var(--text-muted);">
          <span style="width:12px;height:3px;background:${ds.color};border-radius:2px;display:inline-block;"></span>
          ${ds.label}
        </span>
      `).join('')}
    </div>
  `;

  requestAnimationFrame(() => {
    const canvas = document.getElementById('positions-chart');
    if (canvas) drawPositionChart(canvas, datasets, { xLabel: 'Lap' });
  });
}

function renderStrategy(container) {
  const { stints, order, driverMap, laps } = raceDataCache;

  if (stints.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-icon"><i class="fa-solid fa-circle-notch fa-3x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div><div class="no-data-text">No strategy data available</div></div>';
    return;
  }

  const maxLap = Math.max(...laps.map(l => l.lap_number).filter(n => !isNaN(n)), 1);
  const driverOrder = order.map(o => o.driver_number);

  let html = `
    <div class="chart-container">
      <div class="chart-title">Pit Strategy</div>
      <div style="display:flex;gap:16px;margin-bottom:12px;font-size:0.72rem;">
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;background:var(--tyre-soft);border-radius:2px;"></span> Soft</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;background:var(--tyre-medium);border-radius:2px;"></span> Medium</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;background:var(--tyre-hard);border-radius:2px;"></span> Hard</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;background:var(--tyre-inter);border-radius:2px;"></span> Inter</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;background:var(--tyre-wet);border-radius:2px;"></span> Wet</span>
      </div>
      <div class="strategy-timeline">
  `;

  for (const dn of driverOrder) {
    const d = driverMap.get(dn) || {};
    const driverStints = stints.filter(s => s.driver_number === dn).sort((a, b) => a.stint_number - b.stint_number);

    if (driverStints.length === 0) continue;

    html += `<div class="strategy-row">`;
    html += `<div class="strategy-driver">${d.name_acronym || `#${dn}`}</div>`;
    html += `<div class="strategy-bar-container">`;

    for (const stint of driverStints) {
      const stintLen = (stint.lap_end - stint.lap_start + 1);
      const widthPct = (stintLen / maxLap) * 100;
      const compoundClass = getCompoundClass(stint.compound);
      html += `<div class="strategy-stint ${compoundClass}" style="width:${widthPct}%" title="${stint.compound}: Lap ${stint.lap_start}–${stint.lap_end} (${stintLen} laps)">${stintLen}</div>`;
    }

    html += `</div></div>`;
  }

  html += '</div></div>';
  container.innerHTML = html;
}

function renderOvertakes(container) {
  const { overtakes, driverMap } = raceDataCache;

  if (overtakes.length === 0) {
    container.innerHTML = '<div class="no-data"><div class="no-data-icon"><i class="fa-solid fa-car-side fa-3x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div><div class="no-data-text">No overtake data available</div></div>';
    return;
  }

  // Sort chronologically by date first, fallback to lap_number
  const sorted = [...overtakes].sort((a, b) => {
    const timeA = new Date(a.date).getTime();
    const timeB = new Date(b.date).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return a.lap_number - b.lap_number;
  });

  let html = `
    <div class="chart-container">
      <div class="chart-title">Overtakes Feed (${sorted.length} total)</div>
      <div class="overtakes-feed" style="max-height: 480px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm) 0;">
  `;

  for (const ot of sorted) {
    const overtaker = driverMap.get(ot.overtaking_driver_number);
    const overtaken = driverMap.get(ot.overtaken_driver_number);
    const oName = overtaker ? (overtaker.full_name || overtaker.name_acronym) : `#${ot.overtaking_driver_number}`;
    const tName = overtaken ? (overtaken.full_name || overtaken.name_acronym) : `#${ot.overtaken_driver_number}`;
    const oColor = overtaker ? getTeamColor(overtaker.team_colour) : '#666';

    const isLeadChange = ot.position === 1;
    const isPodiumPass = ot.position <= 3 && !isLeadChange;
    const badgeText = isLeadChange ? '👑 Lead' : isPodiumPass ? '⭐ Podium' : '';
    const badgeStyle = isLeadChange ? 'background: rgba(255, 215, 0, 0.15); border-color: #ffd700; color: #ffd700;' 
                     : isPodiumPass ? 'background: rgba(168, 85, 247, 0.15); border-color: #a855f7; color: #a855f7;' 
                     : 'background: var(--bg-tertiary); border-color: var(--border-subtle); color: var(--text-muted);';

    html += `
      <div class="overtake-item" style="border-left: 4px solid ${oColor}; background: var(--bg-card); padding: 12px 16px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--border-subtle); border-left-color: ${oColor};">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="font-size: 0.72rem; color: var(--f1-red); font-family: 'JetBrains Mono', monospace; font-weight: 600;">LAP ${ot.lap_number || '—'}</div>
          <div style="font-size: 0.85rem; color: var(--text-primary); line-height: 1.4;">
            <strong>${oName}</strong> overtook <strong>${tName}</strong>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${badgeText ? `<span style="font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 8px; border-radius: 100px; border: 1px solid; ${badgeStyle}">${badgeText}</span>` : ''}
          <div class="overtake-position" style="font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 0.95rem; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-primary);" title="Position gained to P${ot.position}">P${ot.position}</div>
        </div>
      </div>
    `;
  }

  html += '</div></div>';
  container.innerHTML = html;
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

  // Sort chronologically (earliest to latest)
  const sorted = [...incidents].sort((a, b) => new Date(a.date) - new Date(b.date));

  let html = `
    <div class="chart-container">
      <div class="chart-title">Race Control Timeline</div>
      <div class="incidents-feed">
  `;

  sorted.forEach((inc, idx) => {
    const msg = inc.message || '';
    const msgUpper = msg.toUpperCase();
    let catClass = 'incident-info';
    let icon = '<i class="fa-solid fa-circle-info" style="color: var(--text-muted);"></i>';

    if (inc.category === 'SafetyCar' || msgUpper.includes('SAFETY CAR') || msgUpper.includes('VSC') || msgUpper.includes('TRACK STATUS')) {
      catClass = 'incident-sc';
      icon = '<i class="fa-solid fa-triangle-exclamation" style="color: #ffd000;"></i>';
    } else if (inc.flag === 'RED' || msgUpper.includes('RED FLAG') || msgUpper.includes('SUSPENDED')) {
      catClass = 'incident-flag-red';
      icon = '<i class="fa-solid fa-flag" style="color: var(--f1-red);"></i>';
    } else if (inc.flag === 'YELLOW' || inc.flag === 'DOUBLE YELLOW' || msgUpper.includes('YELLOW FLAG')) {
      catClass = 'incident-flag-yellow';
      icon = '<i class="fa-solid fa-flag" style="color: #ffd000;"></i>';
    } else if (inc.flag === 'GREEN' || msgUpper.includes('GREEN FLAG') || msgUpper.includes('RESUMED') || msgUpper.includes('CLEAR')) {
      catClass = 'incident-flag-green';
      icon = '<i class="fa-solid fa-flag" style="color: #39b54a;"></i>';
    } else if (msgUpper.includes('INVESTIGAT') || msgUpper.includes('PENALTY') || msgUpper.includes('TIME PENALTY') || msgUpper.includes('STEWARDS')) {
      catClass = 'incident-stewards';
      icon = '<i class="fa-solid fa-magnifying-glass" style="color: #38bdf8;"></i>';
    }

    const lapText = inc.lap_number ? `Lap ${inc.lap_number}` : 'Pre-Race';
    const timeStr = new Date(inc.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    html += `
      <div class="incident-item ${catClass}" style="animation-delay: ${idx * 40}ms">
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

  html += '</div></div>';
  container.innerHTML = html;
}

// ── Grand Prix Driver Deep-Dive Modal Setup ──

let overlay = null;

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
  
  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Close on Escape key press
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
  });

  return overlay;
}

function closeModal() {
  if (overlay) {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
}

/**
 * Show a highly personalized Grand Prix Driver Deep-Dive modal containing:
 * - Starting vs. Finishing positions (movement indicators)
 * - Chronological tyre compound stints timeline
 * - Exact pit stop durations
 * - Best sector times (Sector 1, Sector 2, Sector 3, Best Lap)
 * - Steward decisions and race control events filtered by acronym/number
 */
export async function showRaceDriverDetail(driverNumber) {
  ensureOverlay();
  const modal = document.getElementById('driver-modal');
  const d = raceDataCache.driverMap.get(driverNumber) || {
    name_acronym: `#${driverNumber}`,
    team_name: 'Unknown',
    team_colour: '666666',
    full_name: `Driver #${driverNumber}`,
    headshot_url: ''
  };
  const teamColor = getTeamColor(d.team_colour);

  // Render a glassmorphic loader skeleton
  modal.innerHTML = `
    <button class="driver-modal-close" id="dm-close" aria-label="Close">✕</button>
    <div style="padding: 32px 24px; text-align: center; font-family:'Outfit',sans-serif;">
      <div style="position: relative; width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.03); border: 2px solid ${teamColor}; margin: 0 auto 16px auto; overflow: hidden;">
        <img src="${d.headshot_url || ''}" alt="${d.name_acronym}" style="width: 100%; height: auto; object-fit: cover;" onerror="this.style.display='none'">
      </div>
      <div style="font-family:'Outfit',sans-serif; font-weight:700; font-size:1.15rem; color:var(--text-primary); margin-bottom:4px;">${d.full_name}</div>
      <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; font-weight:600; margin-bottom:24px;">${d.team_name}</div>
      
      <div style="display:flex; flex-direction:column; gap:12px; max-width:320px; margin: 0 auto;">
        <div class="skeleton skeleton-row" style="height:14px; width:100%;"></div>
        <div class="skeleton skeleton-row" style="height:14px; width:85%;"></div>
        <div class="skeleton skeleton-row" style="height:14px; width:95%;"></div>
      </div>
      <div style="font-size:0.8rem; color:var(--text-muted); margin-top:20px; font-weight:600;">Analyzing GP Telemetry...</div>
    </div>
  `;
  document.getElementById('dm-close').addEventListener('click', closeModal);
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  try {
    // Parallel driver-filtered loading to reduce payload size by 30x, bypass API 429 errors, and load instantly!
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
        getStints({ session_key: raceDataCache.sessionKey, driver_number: driverNumber }),
        getPits({ session_key: raceDataCache.sessionKey, driver_number: driverNumber }),
        getLaps({ session_key: raceDataCache.sessionKey, driver_number: driverNumber }),
        getPositions({ session_key: raceDataCache.sessionKey, driver_number: driverNumber })
      ]);
      stints = results[0];
      pits = results[1];
      laps = results[2];
      positions = results[3];

      // Save in driver-specific cache
      raceDataCache.driverTelemetry[driverNumber] = { stints, pits, laps, positions };
    }

    // Incidents (session-wide, lightweight)
    const incidents = raceDataCache.incidents || await getRaceControl({ session_key: raceDataCache.sessionKey });
    raceDataCache.incidents = incidents;

    const driverStints = stints.sort((a, b) => a.stint_number - b.stint_number);
    const driverPits = pits.sort((a, b) => a.lap_number - b.lap_number);
    const driverLaps = laps.sort((a, b) => a.lap_number - b.lap_number);

    // Calculate grid starting position from chronological positions telemetry
    const sortedPositions = [...positions].sort((a, b) => new Date(a.date) - new Date(b.date));
    const startPos = sortedPositions.length > 0 ? sortedPositions[0].position : '—';

    const finishEntry = raceDataCache.order.find(o => o.driver_number === driverNumber);
    const finishPos = finishEntry ? finishEntry.position : '—';
    const finishStatus = finishEntry ? finishEntry.status : '—';

    let gainLossText = '';
    let gainLossClass = '';
    if (typeof startPos === 'number' && typeof finishPos === 'number') {
      const diff = startPos - finishPos;
      if (diff > 0) {
        gainLossText = `<i class="fa-solid fa-circle-up" style="color:var(--f1-green); margin-right:6px;"></i>Gained ${diff} position${diff > 1 ? 's' : ''} from starting grid`;
        gainLossClass = 'style="color:var(--f1-green); font-weight:700; display:flex; align-items:center;"';
      } else if (diff < 0) {
        gainLossText = `<i class="fa-solid fa-circle-down" style="color:var(--f1-red); margin-right:6px;"></i>Lost ${Math.abs(diff)} position${Math.abs(diff) > 1 ? 's' : ''} from starting grid`;
        gainLossClass = 'style="color:var(--f1-red); font-weight:700; display:flex; align-items:center;"';
      } else {
        gainLossText = `<i class="fa-solid fa-circle-right" style="color:var(--text-muted); margin-right:6px;"></i>Maintained grid position`;
        gainLossClass = 'style="color:var(--text-muted); font-weight:700; display:flex; align-items:center;"';
      }
    }

    // Extract fastest sector times and lap markers
    let bestLap = Infinity, bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity;
    let bestLapNum = '—', bestS1Num = '—', bestS2Num = '—', bestS3Num = '—';

    driverLaps.forEach(l => {
      if (l.lap_duration && !l.is_pit_out_lap && l.lap_number > 1 && l.lap_duration < bestLap) {
        bestLap = l.lap_duration;
        bestLapNum = l.lap_number;
      }
      if (l.duration_sector_1 && l.duration_sector_1 < bestS1) {
        bestS1 = l.duration_sector_1;
        bestS1Num = l.lap_number;
      }
      if (l.duration_sector_2 && l.duration_sector_2 < bestS2) {
        bestS2 = l.duration_sector_2;
        bestS2Num = l.lap_number;
      }
      if (l.duration_sector_3 && l.duration_sector_3 < bestS3) {
        bestS3 = l.duration_sector_3;
        bestS3Num = l.lap_number;
      }
    });

    // Build stints timeline content
    let stintsHtml = '';
    if (driverStints.length === 0) {
      stintsHtml = `<div style="color:var(--text-muted); font-size:0.8rem; padding:6px 0;">No tyre compound information available</div>`;
    } else {
      stintsHtml = `
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:8px;">
          ${driverStints.map(s => {
            const comp = s.compound || 'UNKNOWN';
            const cClass = getCompoundClass(comp);
            let bg = 'var(--text-muted)';
            let color = '#fff';
            if (cClass.includes('soft')) { bg = 'var(--tyre-soft)'; color = '#fff'; }
            else if (cClass.includes('medium')) { bg = 'var(--tyre-medium)'; color = '#000'; }
            else if (cClass.includes('hard')) { bg = 'var(--tyre-hard)'; color = '#000'; }
            else if (cClass.includes('inter')) { bg = 'var(--tyre-inter)'; color = '#fff'; }
            else if (cClass.includes('wet')) { bg = 'var(--tyre-wet)'; color = '#fff'; }
            const isNew = s.tyre_new === true || s.tyre_new === 'true' || s.tyre_new === 1 ? 'New' : 'Used';
            const lapStart = s.lap_start || 1;
            const lapEnd = s.lap_end || lapStart;
            const lapsCount = lapEnd - lapStart + 1;
            return `
              <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md);">
                <div style="display:flex; align-items:center; gap:10px;">
                  <span class="tyre-badge ${cClass}" style="width:24px; height:24px; font-size:0.65rem; border-radius:50%; font-weight:900; display:flex; align-items:center; justify-content:center; background:${bg}; color:${color}; border:1px solid rgba(255,255,255,0.1);" title="${comp}">${comp[0]}</span>
                  <div>
                    <div style="font-size:0.85rem; font-weight:700; color:var(--text-primary);">${comp} compound (${isNew})</div>
                    <div style="font-size:0.7rem; color:var(--text-muted);">Laps ${lapStart} to ${lapEnd}</div>
                  </div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.85rem; font-weight:700; color:var(--text-secondary);">${lapsCount} Lap${lapsCount !== 1 ? 's' : ''}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Build pit stop content
    let pitsHtml = '';
    if (driverPits.length === 0) {
      pitsHtml = `<div style="color:var(--text-muted); font-size:0.8rem; padding:8px 0;">No pit stops recorded during this Grand Prix</div>`;
    } else {
      pitsHtml = `
        <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          ${driverPits.map(p => {
            const dur = p.pit_duration ? `${p.pit_duration.toFixed(2)}s` : '—';
            return `
              <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md);">
                <div>
                  <span style="font-size:0.8rem; font-weight:700; color:var(--text-secondary);">Lap ${p.lap_number}</span>
                </div>
                <div style="text-align:right; font-family:'JetBrains Mono', monospace; font-size:0.85rem; font-weight:700; color:var(--text-primary);">
                  <i class="fa-solid fa-stopwatch" style="color: var(--text-muted); margin-right: 4px;"></i> Duration: ${dur}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Steward decisions and events filtering
    const acronym = d.name_acronym || '';
    const lastName = d.full_name ? d.full_name.split(' ').pop().toUpperCase() : '';
    const numberStr = driverNumber.toString();

    const driverIncidents = incidents.filter(inc => {
      const msg = (inc.message || '').toUpperCase();
      return msg.includes(acronym.toUpperCase()) || 
             (lastName && msg.includes(lastName)) ||
             msg.includes(`CAR ${numberStr} `) ||
             msg.includes(`CAR ${numberStr},`) ||
             msg.includes(`CAR ${numberStr}.`) ||
             msg.includes(`CAR ${numberStr}\n`) ||
             msg.endsWith(`CAR ${numberStr}`);
    });

    let incidentsHtml = '';
    if (driverIncidents.length === 0) {
      incidentsHtml = `<div style="color:var(--text-muted); font-size:0.8rem; padding:8px 0;">No steward investigations, penalties, or incidents involving this driver.</div>`;
    } else {
      incidentsHtml = `
        <div class="incidents-feed" style="margin-top:8px;">
          ${driverIncidents.map(inc => {
            const msg = inc.message || '';
            const msgUpper = msg.toUpperCase();
            let catClass = 'incident-info';
            let icon = '<i class="fa-solid fa-circle-info" style="color: var(--text-muted);"></i>';

            if (msgUpper.includes('INVESTIGAT') || msgUpper.includes('PENALTY') || msgUpper.includes('TIME PENALTY') || msgUpper.includes('STEWARDS')) {
              catClass = 'incident-stewards';
              icon = '<i class="fa-solid fa-magnifying-glass" style="color: #38bdf8;"></i>';
            }
            const lapText = inc.lap_number ? `Lap ${inc.lap_number}` : 'Pre-Race';
            const timeStr = new Date(inc.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            return `
              <div class="incident-item ${catClass}" style="margin-bottom:8px;">
                <div class="incident-badge">${icon}</div>
                <div class="incident-card" style="padding:10px 14px; background:rgba(0,0,0,0.15); border:1px solid rgba(255,255,255,0.03);">
                  <div class="incident-meta" style="margin-bottom:6px;">
                    <span class="incident-lap">${lapText}</span>
                    <span class="incident-time">${timeStr}</span>
                  </div>
                  <div class="incident-msg" style="font-size:0.8rem; line-height:1.4;">${msg}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Compile beautiful UI with clean styled details
    modal.innerHTML = `
      <button class="driver-modal-close" id="dm-close" aria-label="Close">✕</button>
      
      <!-- Modal Header Banner -->
      <div class="dm-header-banner" style="--dm-team-color: ${teamColor}; --dm-team-color-alpha: ${teamColor}33;">
        <div class="dm-header-bar"></div>
        
        <div class="dm-header-avatar">
          <img src="${d.headshot_url || ''}" alt="${d.name_acronym}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect fill=%22%231a1a25%22 width=%2280%22 height=%2280%22/><text y=%2250%%22 x=%2250%%22 font-family=%22sans-serif%22 font-size=%2224%22 fill=%22%23777%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22>${d.name_acronym}</text></svg>'">
        </div>
        
        <div style="flex: 1; min-width: 200px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-family:'JetBrains Mono',monospace; font-size:0.9rem; font-weight:800; color:${teamColor}; background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px;">#${driverNumber}</span>
            <span style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; color:var(--text-muted);">${d.team_name}</span>
          </div>
          <h2 style="font-family:'Outfit',sans-serif; font-size:1.6rem; font-weight:800; margin: 6px 0 2px 0; color:var(--text-primary); display:flex; align-items:center; gap:8px;">
            <span>${d.full_name}</span>
            ${getDriverFlagImg(d.name_acronym, 'width:20px; border-radius:2px;')}
          </h2>
          <div ${gainLossClass} style="font-size:0.85rem; margin-top:4px;">${gainLossText || 'Maintained position'}</div>
        </div>
      </div>

      <!-- Quick Race Stats Metrics -->
      <div class="dm-grid-stats">
        <div style="background: rgba(255,255,255,0.01); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 10px; text-align: center;">
          <div style="font-size: 0.68rem; text-transform: uppercase; color: var(--text-muted); font-weight:600; letter-spacing: 0.05em;">Start Grid</div>
          <div style="font-family:'Outfit',sans-serif; font-size: 1.2rem; font-weight: 800; color: var(--text-secondary); margin-top: 4px;">P${startPos}</div>
        </div>
        <div style="background: rgba(255,255,255,0.01); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 10px; text-align: center;">
          <div style="font-size: 0.68rem; text-transform: uppercase; color: var(--text-muted); font-weight:600; letter-spacing: 0.05em;">Race Finish</div>
          <div style="font-family:'Outfit',sans-serif; font-size: 1.2rem; font-weight: 800; color: ${finishStatus === 'DNF' ? 'var(--f1-red)' : 'var(--text-primary)'}; margin-top: 4px;">
            ${finishStatus === 'DNS' ? 'DNS' : finishStatus === 'DSQ' ? 'DSQ' : `P${finishPos}`}
            ${finishStatus === 'DNF' ? '<span style="font-size:0.75rem;color:var(--f1-red);">(DNF)</span>' : ''}
          </div>
        </div>
        <div style="background: rgba(255,255,255,0.01); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 10px; text-align: center;">
          <div style="font-size: 0.68rem; text-transform: uppercase; color: var(--text-muted); font-weight:600; letter-spacing: 0.05em;">Completed Laps</div>
          <div style="font-family:'Outfit',sans-serif; font-size: 1.2rem; font-weight: 800; color: var(--text-primary); margin-top: 4px;">${driverLaps.length}</div>
        </div>
        <div style="background: rgba(255,255,255,0.01); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 10px; text-align: center;">
          <div style="font-size: 0.68rem; text-transform: uppercase; color: var(--text-muted); font-weight:600; letter-spacing: 0.05em;">Pit Stops</div>
          <div style="font-family:'Outfit',sans-serif; font-size: 1.2rem; font-weight: 800; color: var(--text-secondary); margin-top: 4px;">${driverPits.length}</div>
        </div>
      </div>

      <!-- Telemetry and Stints Timeline -->
      <div style="padding: 24px; display: flex; flex-direction: column; gap: 24px;">
        
        <!-- Sector Times -->
        <div>
          <div style="font-family:'Outfit',sans-serif; font-size:0.9rem; font-weight:800; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:10px; display:flex; align-items:center; gap:8px;">
            <i class="fa-solid fa-stopwatch" style="color: var(--text-secondary); width: 14px;"></i> Sector Best Times
          </div>
          <div class="dm-grid-sector">
            <div style="padding: 10px 14px; background:rgba(255,255,255,0.01); border:1px solid var(--border-subtle); border-radius:var(--radius-md);">
              <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.03em;">Personal Best Lap</div>
              <div style="font-family:'JetBrains Mono',monospace; font-size:1rem; font-weight:800; color:#a855f7; margin-top:4px;">${bestLap < Infinity ? formatLapTime(bestLap) : '—'}</div>
              <div style="font-size:0.62rem; color:var(--text-muted); margin-top:2px;">Lap ${bestLapNum}</div>
            </div>
            <div style="padding: 10px 14px; background:rgba(255,255,255,0.01); border:1px solid var(--border-subtle); border-radius:var(--radius-md);">
              <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.03em;">Best Sector 1</div>
              <div style="font-family:'JetBrains Mono',monospace; font-size:1rem; font-weight:800; color:var(--text-secondary); margin-top:4px;">${bestS1 < Infinity ? `${bestS1.toFixed(3)}s` : '—'}</div>
              <div style="font-size:0.62rem; color:var(--text-muted); margin-top:2px;">Lap ${bestS1Num}</div>
            </div>
            <div style="padding: 10px 14px; background:rgba(255,255,255,0.01); border:1px solid var(--border-subtle); border-radius:var(--radius-md);">
              <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.03em;">Best Sector 2</div>
              <div style="font-family:'JetBrains Mono',monospace; font-size:1rem; font-weight:800; color:var(--text-secondary); margin-top:4px;">${bestS2 < Infinity ? `${bestS2.toFixed(3)}s` : '—'}</div>
              <div style="font-size:0.62rem; color:var(--text-muted); margin-top:2px;">Lap ${bestS2Num}</div>
            </div>
            <div style="padding: 10px 14px; background:rgba(255,255,255,0.01); border:1px solid var(--border-subtle); border-radius:var(--radius-md);">
              <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.03em;">Best Sector 3</div>
              <div style="font-family:'JetBrains Mono',monospace; font-size:1rem; font-weight:800; color:var(--text-secondary); margin-top:4px;">${bestS3 < Infinity ? `${bestS3.toFixed(3)}s` : '—'}</div>
              <div style="font-size:0.62rem; color:var(--text-muted); margin-top:2px;">Lap ${bestS3Num}</div>
            </div>
          </div>
        </div>

        <!-- Tyre Stints Timeline -->
        <div>
          <div style="font-family:'Outfit',sans-serif; font-size:0.9rem; font-weight:800; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
            <i class="fa-solid fa-circle-notch" style="color: var(--text-secondary); width: 14px;"></i> Tyre Stints Timeline
          </div>
          ${stintsHtml}
        </div>

        <!-- Pit Stop Records -->
        <div>
          <div style="font-family:'Outfit',sans-serif; font-size:0.9rem; font-weight:800; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
            <i class="fa-solid fa-wrench" style="color: var(--text-secondary); width: 14px;"></i> Pit Stop Telemetry
          </div>
          ${pitsHtml}
        </div>

        <!-- Stewarding & Personal Incidents Feed -->
        <div>
          <div style="font-family:'Outfit',sans-serif; font-size:0.9rem; font-weight:800; color:var(--text-primary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
            <i class="fa-solid fa-triangle-exclamation" style="color: var(--text-secondary); width: 14px;"></i> Stewards Decisions & Incidents
          </div>
          ${incidentsHtml}
        </div>

      </div>
    `;

    // Rebind closing event to X button
    document.getElementById('dm-close').addEventListener('click', closeModal);

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
    document.getElementById('dm-close').addEventListener('click', closeModal);
  }
}

/**
 * Controller to switch active session detail between Grand Prix Race and Saturday Sprint.
 * Clears cached telemetry objects so Saturday Sprint loads fresh telemetry records.
 */
async function switchRaceDetailSession(sessionType) {
  if (!raceDataCache || raceDataCache.currentSessionType === sessionType) return;
  
  const session = raceDataCache.sessions[sessionType];
  if (!session) return;
  
  raceDataCache.currentSessionType = sessionType;
  raceDataCache.sessionKey = session.session_key;
  raceDataCache.order = session.results;
  
  // Clear lazy-loaded telemetries so they get fetched fresh for the Sprint
  raceDataCache.laps = null;
  raceDataCache.stints = null;
  raceDataCache.pits = null;
  raceDataCache.overtakes = null;
  raceDataCache.incidents = null;
  raceDataCache.intervals = null;
  raceDataCache.driverTelemetry = {};
  
  // Render loading skeleton
  const content = $('#race-detail-content');
  content.innerHTML = Array(5).fill('<div class="skeleton skeleton-row"></div>').join('');
  
  const weatherBar = $('#race-weather-bar');
  loadAndRenderWeather(session.session_key, weatherBar);
  
  try {
    // Render current active tab layout in skeleton state
    renderTab();
    
    // Background enrichment
    const [laps, pits, overtakes, intervals] = await Promise.all([
      getLaps({ session_key: session.session_key }),
      getPits({ session_key: session.session_key }),
      getOvertakes({ session_key: session.session_key }),
      getIntervals({ session_key: session.session_key }),
    ]);
    
    if (raceDataCache && raceDataCache.sessionKey === session.session_key) {
      raceDataCache.laps = laps;
      raceDataCache.pits = pits;
      raceDataCache.overtakes = overtakes;
      raceDataCache.intervals = intervals;
      
      if (currentTab === 'results') {
        renderResults(content);
      }
    }
  } catch (err) {
    console.warn('[Race Detail] Switch session enrichment failed:', err);
  }
}


