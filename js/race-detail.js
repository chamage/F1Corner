// =============================================
// F1 CORNER — Race Deep-Dive Section
// Lazy-loads heavy charts and feeds to avoid API timeouts
// =============================================

import { getLaps, getStints, getPits, getOvertakes, getSessionDrivers, getRaceControl, getWeather, getIntervals } from './api.js';
import { getSeasonData, getResultsForSession } from './season-data.js';
import { formatLapTime, getTeamColor, getCompoundClass, buildDriverMap, getPointsForPosition, $ } from './utils.js';
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

    const order = getResultsForSession(seasonData, sessionKey);
    const driverMap = buildDriverMap(drivers);

    // Initial minimal cache
    raceDataCache = { 
      sessionKey, 
      meetingInfo, 
      order, 
      drivers, 
      driverMap,
      laps: null,
      stints: null,
      pits: null,
      overtakes: null,
      incidents: null,
      weather: null,
      intervals: null
    };

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
    container.innerHTML = '<div class="no-data"><div class="no-data-icon">🏎️</div><div class="no-data-text">No results data available for this race</div></div>';
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
      <tr>
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
    container.innerHTML = '<div class="no-data"><div class="no-data-icon">🛞</div><div class="no-data-text">No strategy data available</div></div>';
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
    container.innerHTML = '<div class="no-data"><div class="no-data-icon">🏎️</div><div class="no-data-text">No overtake data available</div></div>';
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
      <div class="weather-item" title="Average Air Temperature">🌡️ Air: <span>${avgAir}°C</span></div>
      <div class="weather-item" title="Average Track Temperature">🛣️ Track: <span>${avgTrack}°C</span></div>
      ${avgHum ? `<div class="weather-item" title="Average Humidity">💧 Humid: <span>${avgHum}%</span></div>` : ''}
      ${avgWind ? `<div class="weather-item" title="Average Wind Speed">💨 Wind: <span>${avgWind} m/s</span></div>` : ''}
      <div class="weather-item">${hasRain ? '🌧️ <span>Wet</span>' : '☀️ <span>Dry</span>'}</div>
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
    container.innerHTML = '<div class="no-data"><div class="no-data-icon">🏳️</div><div class="no-data-text">No race control incidents recorded for this session</div></div>';
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
    let icon = 'ℹ️';

    if (inc.category === 'SafetyCar' || msgUpper.includes('SAFETY CAR') || msgUpper.includes('VSC') || msgUpper.includes('TRACK STATUS')) {
      catClass = 'incident-sc';
      icon = '🚨';
    } else if (inc.flag === 'RED' || msgUpper.includes('RED FLAG') || msgUpper.includes('SUSPENDED')) {
      catClass = 'incident-flag-red';
      icon = '🔴';
    } else if (inc.flag === 'YELLOW' || inc.flag === 'DOUBLE YELLOW' || msgUpper.includes('YELLOW FLAG')) {
      catClass = 'incident-flag-yellow';
      icon = '🟡';
    } else if (inc.flag === 'GREEN' || msgUpper.includes('GREEN FLAG') || msgUpper.includes('RESUMED') || msgUpper.includes('CLEAR')) {
      catClass = 'incident-flag-green';
      icon = '🟢';
    } else if (msgUpper.includes('INVESTIGAT') || msgUpper.includes('PENALTY') || msgUpper.includes('TIME PENALTY') || msgUpper.includes('STEWARDS')) {
      catClass = 'incident-stewards';
      icon = '🔍';
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

