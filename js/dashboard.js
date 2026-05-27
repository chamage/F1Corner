// =============================================
// PITCORNER — Hero Dashboard Section
// Uses compiled season data (shared)
// =============================================

import { getMeetings, getOvertakes } from './api.js';
import { getSeasonData, computeStandingsFromSeason } from './season-data.js';
import { isPast, isThisWeek, formatDateRange, formatLapTime, getTeamColor, getPointsForPosition, $ } from './utils.js';
import { drawLineChart } from './charts.js';

export async function initDashboard(year) {
  const heroBadge = $('#hero-badge-text');
  const latestRaceEl = $('#latest-race-info');
  const progressFill = $('#progress-fill');
  const progressLabel = $('#progress-completed');

  heroBadge.textContent = `${year} SEASON`;

  // Reset stats while loading
  document.getElementById('stat-races').textContent = '…';
  document.getElementById('stat-sprints').textContent = '…';
  document.getElementById('stat-overtakes').textContent = '…';
  document.getElementById('stat-fastest').textContent = '…';
  latestRaceEl.innerHTML = '';

  try {
    const [meetings, seasonData] = await Promise.all([
      getMeetings(year),
      getSeasonData(year),
    ]);

    // Filter to actual Grand Prix events that aren't cancelled
    const gps = meetings.filter(m =>
      m.meeting_name.includes('Grand Prix') && !m.is_cancelled
    );

    const allRaceSessions = seasonData.totalRaceSessions || [];
    const fullRaces = allRaceSessions.filter(s => s.session_name === 'Race');
    const completedRaces = fullRaces.filter(s => isPast(s.date_end));
    const sprintRaces = allRaceSessions.filter(s => s.session_name === 'Sprint');
    const completedSprints = sprintRaces.filter(s => isPast(s.date_end));

    // Season progress
    const totalRaces = gps.length;
    const completedCount = completedRaces.length;
    const progressPct = totalRaces > 0 ? (completedCount / totalRaces) * 100 : 0;
    progressFill.style.width = `${progressPct}%`;
    progressLabel.textContent = `${completedCount} of ${totalRaces} races completed`;

    // Update basic stat cards immediately
    document.getElementById('stat-races').textContent = completedCount;
    document.getElementById('stat-sprints').textContent = completedSprints.length;

    // Find current/next race
    const currentWeekend = gps.find(m => isThisWeek(m.date_start, m.date_end));
    const nextRace = gps.find(m => !isPast(m.date_end));

    // Get winner from compiled season data (zero API calls)
    const compiledRaces = seasonData.races || [];
    const lastCompiledRace = compiledRaces.filter(r => r.session_name === 'Race').pop();

    let lastWinner = '';
    let lastRaceName = '';
    if (lastCompiledRace && lastCompiledRace.results.length > 0) {
      const winnerNum = lastCompiledRace.results[0].driver_number;
      const winnerInfo = seasonData.drivers.get(winnerNum);
      lastWinner = winnerInfo ? winnerInfo.full_name : `#${winnerNum}`;
      const meeting = gps.find(m => m.meeting_key === lastCompiledRace.meeting_key);
      lastRaceName = meeting ? meeting.meeting_name : lastCompiledRace.circuit_short_name;
    }

    // Find the overall fastest lap of the season
    let overallFastestLap = null;
    let overallFastestDriver = null;
    let overallFastestRace = null;
    for (const race of compiledRaces) {
      if (race.fastest_lap_time && (!overallFastestLap || race.fastest_lap_time < overallFastestLap)) {
        overallFastestLap = race.fastest_lap_time;
        overallFastestDriver = race.fastest_lap_driver;
        overallFastestRace = race;
      }
    }

    if (overallFastestLap && overallFastestDriver) {
      const driverInfo = seasonData.drivers.get(overallFastestDriver);
      const driverName = driverInfo ? driverInfo.name_acronym : `#${overallFastestDriver}`;
      document.getElementById('stat-fastest').textContent = `${formatLapTime(overallFastestLap)} (${driverName})`;
      document.getElementById('stat-fastest').title = `${driverInfo?.full_name || driverName} at ${overallFastestRace.circuit_short_name}`;
    } else {
      document.getElementById('stat-fastest').textContent = '—';
    }

    // Overtakes from last 3 completed races (these are small requests)
    const enrichPromise = (async () => {
      let totalOvertakes = 0;
      const recent = completedRaces.slice(-3);
      if (recent.length > 0) {
        for (const r of recent) {
          try {
            const ots = await getOvertakes({ session_key: r.session_key });
            totalOvertakes += ots.length;
          } catch { /* ignore */ }
        }
      }
      document.getElementById('stat-overtakes').textContent = totalOvertakes > 0 ? `${totalOvertakes}+` : '—';
    })();

    // Show latest race or current weekend
    if (currentWeekend) {
      latestRaceEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;justify-content:center;">
          <span style="width:8px;height:8px;background:var(--f1-red);border-radius:50%;animation:pulse 2s ease-in-out infinite;display:inline-block;"></span>
          <span style="color:var(--f1-red);font-weight:600;">RACE WEEKEND LIVE</span>
        </div>
        <div style="font-family:'Outfit',sans-serif;font-size:1.2rem;font-weight:700;margin-top:4px;">${currentWeekend.meeting_name}</div>
        <div style="color:var(--text-muted);font-size:0.85rem;">${currentWeekend.location} • ${formatDateRange(currentWeekend.date_start, currentWeekend.date_end)}</div>
      `;
    } else if (lastWinner) {
      latestRaceEl.innerHTML = `
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">Latest Result</div>
        <div style="font-family:'Outfit',sans-serif;font-size:1.1rem;font-weight:700;margin-top:4px;">${lastRaceName}</div>
        <div style="color:var(--text-secondary);font-size:0.9rem;margin-top:2px;display:flex;align-items:center;justify-content:center;gap:6px;"><i class="fa-solid fa-trophy" style="color: #ffd700;"></i> <span>${lastWinner}</span></div>
      `;
    } else if (nextRace) {
      latestRaceEl.innerHTML = `
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">Next Race</div>
        <div style="font-family:'Outfit',sans-serif;font-size:1.1rem;font-weight:700;margin-top:4px;">${nextRace.meeting_name}</div>
        <div style="color:var(--text-muted);font-size:0.85rem;">${formatDateRange(nextRace.date_start, nextRace.date_end)}</div>
      `;
    }

    // ── Championship Battle Points Tracker ──
    currentSeasonData = seasonData;
    const selectEl = document.getElementById('chart-drivers-count');
    const defaultCount = selectEl ? parseInt(selectEl.value, 10) : 5;
    drawChampionshipBattle(seasonData, defaultCount);

    if (selectEl && !changeListenerAdded) {
      selectEl.addEventListener('change', (e) => {
        if (currentSeasonData) {
          drawChampionshipBattle(currentSeasonData, parseInt(e.target.value, 10));
        }
      });
      changeListenerAdded = true;
    }

    // Don't block on enrichment
    enrichPromise.catch(e => console.warn('Dashboard enrichment error:', e));

  } catch (err) {
    console.error('Dashboard init failed:', err);
    document.getElementById('stat-races').textContent = '—';
    document.getElementById('stat-sprints').textContent = '—';
    document.getElementById('stat-overtakes').textContent = '—';
    document.getElementById('stat-fastest').textContent = '—';
  }
}

let currentSeasonData = null;
let changeListenerAdded = false;

function drawChampionshipBattle(seasonData, driversCount) {
  const standings = computeStandingsFromSeason(seasonData);
  const topDrivers = standings.drivers.slice(0, driversCount);

  const chartCanvas = document.getElementById('dashboard-championship-chart');
  const legendEl = document.getElementById('dashboard-chart-legend');

  if (chartCanvas && legendEl) {
    if (topDrivers.length === 0) {
      chartCanvas.style.display = 'none';
      legendEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No points data available yet</div>';
    } else {
      chartCanvas.style.display = 'block';

      // Gather completed meetings in chronological order to match the timeline indexes
      const meetingsMap = new Map();
      for (const r of seasonData.races) {
        if (!r.results || r.results.length === 0) continue;
        if (!meetingsMap.has(r.meeting_key)) {
          meetingsMap.set(r.meeting_key, {
            meeting_key: r.meeting_key,
            circuit_short_name: r.circuit_short_name,
            date_end: r.date_end,
          });
        }
        const m = meetingsMap.get(r.meeting_key);
        if (new Date(r.date_end) > new Date(m.date_end)) {
          m.date_end = r.date_end;
        }
      }
      const sortedMeetings = Array.from(meetingsMap.values())
        .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

      const datasets = topDrivers.map(d => {
        return {
          label: d.name_acronym,
          data: d.pointsHistory || [],
          color: getTeamColor(d.team_colour),
          alpha: 0.9,
        };
      });

      // Store current datasets and meetings on canvas to avoid closure bugs across redraws
      chartCanvas._chartData = {
        datasets,
        sortedMeetings,
        topDrivers
      };

      // Create/grab dynamic tooltip container inside parent element
      let tooltip = chartCanvas.parentElement.querySelector('.chart-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'chart-tooltip';
        chartCanvas.parentElement.appendChild(tooltip);
      }

      function drawChartWithHover(hoverIndex) {
        const data = chartCanvas._chartData;
        if (!data) return;
        requestAnimationFrame(() => {
          drawLineChart(chartCanvas, data.datasets, {
            xLabel: 'Races Completed',
            yLabel: 'Points',
            lineWidth: 2.5,
            showDots: true,
            yMin: 0,
            hoveredIndex: hoverIndex,
          });
        });
      }

      // Draw initial state (no hover)
      drawChartWithHover(undefined);

      // Attach event listeners for hover interaction (once per canvas lifetime)
      if (!chartCanvas._hoverInitialized) {
        chartCanvas._hoverInitialized = true;

        const handleHover = (e) => {
          const data = chartCanvas._chartData;
          if (!data) return;

          const rect = chartCanvas.getBoundingClientRect();
          const clientX = e.clientX || (e.touches && e.touches[0].clientX);
          const clientY = e.clientY || (e.touches && e.touches[0].clientY);
          
          const mouseX = clientX - rect.left;
          const mouseY = clientY - rect.top;

          // Padding variables used in charts.js
          const padLeft = 60;
          const padRight = 20;
          const plotW = rect.width - padLeft - padRight;
          
          if (mouseX >= padLeft && mouseX <= rect.width - padRight) {
            const maxLen = data.sortedMeetings.length;
            const ratio = (mouseX - padLeft) / plotW;
            let idx = Math.round(ratio * (maxLen - 1));
            idx = Math.max(0, Math.min(maxLen - 1, idx));

            // Repaint chart with hover highlight
            drawChartWithHover(idx);

            // Populate and position the tooltip
            const meeting = data.sortedMeetings[idx];
            const roundNumber = idx + 1;

            // Gather values of top drivers at this index
            const hoverDrivers = data.datasets.map(ds => {
              const driverInfo = data.topDrivers.find(td => td.name_acronym === ds.label);
              return {
                acronym: ds.label,
                fullName: driverInfo?.full_name || ds.label,
                color: ds.color,
                points: ds.data[idx] || 0
              };
            }).sort((a, b) => b.points - a.points); // sort highest points first

            let html = `
              <div class="chart-tooltip-header">
                Round ${roundNumber}: ${meeting.circuit_short_name} GP
              </div>
            `;
            
            hoverDrivers.forEach(hd => {
              html += `
                <div class="chart-tooltip-row">
                  <span class="chart-tooltip-driver">
                    <span class="chart-tooltip-color-dot" style="background:${hd.color}"></span>
                    <span>${hd.acronym}</span>
                  </span>
                  <span class="chart-tooltip-value">${hd.points} pts</span>
                </div>
              `;
            });

            tooltip.innerHTML = html;
            tooltip.classList.add('show');

            // Position tooltip dynamically near the hover point
            const tooltipRect = tooltip.getBoundingClientRect();
            const leftOffset = mouseX + 15;
            const rightEdge = leftOffset + tooltipRect.width;

            if (rightEdge > rect.width) {
              tooltip.style.left = `${mouseX - tooltipRect.width - 15}px`;
            } else {
              tooltip.style.left = `${leftOffset}px`;
            }
            tooltip.style.top = `${Math.max(10, Math.min(rect.height - tooltipRect.height - 10, mouseY - tooltipRect.height / 2))}px`;
          } else {
            clearHover();
          }
        };

        const clearHover = () => {
          drawChartWithHover(undefined);
          tooltip.classList.remove('show');
        };

        chartCanvas.addEventListener('mousemove', handleHover);
        chartCanvas.addEventListener('mouseleave', clearHover);
        chartCanvas.addEventListener('touchstart', handleHover, { passive: true });
        chartCanvas.addEventListener('touchmove', handleHover, { passive: true });
        chartCanvas.addEventListener('touchend', clearHover);
      }

      // Render legend
      legendEl.innerHTML = datasets.map(ds => `
        <span style="display:inline-flex;align-items:center;gap:6px;font-size:0.75rem;font-weight:600;color:var(--text-primary);">
          <span style="width:12px;height:12px;border-radius:50%;background:${ds.color};display:inline-block;border:2px solid var(--bg-card);"></span>
          ${ds.label}
        </span>
      `).join('');
    }
  }
}

