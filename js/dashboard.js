// =============================================
// F1 CORNER — Hero Dashboard Section
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
        <div style="color:var(--text-secondary);font-size:0.9rem;margin-top:2px;">🏆 ${lastWinner}</div>
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

      // Sort races chronologically
      const sortedRaces = [...seasonData.races]
        .filter(r => r.results.length > 0)
        .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

      const datasets = topDrivers.map(d => {
        const pointsProgression = [];
        let cumPoints = 0;

        for (const race of sortedRaces) {
          const isSprint = race.session_name === 'Sprint';
          const fastestLapDriver = !isSprint ? race.fastest_lap_driver : null;

          const r = race.results.find(res => res.driver_number === d.driver_number);
          if (r) {
            let pts = r.status === 'DSQ' ? 0 : getPointsForPosition(r.position, isSprint);
            if (seasonData.year < 2025 && fastestLapDriver === d.driver_number && r.position <= 10 && r.status === 'FINISHED') {
              pts += 1;
            }
            cumPoints += pts;
          }
          pointsProgression.push(cumPoints);
        }

        return {
          label: d.name_acronym,
          data: pointsProgression,
          color: getTeamColor(d.team_colour),
          alpha: 0.9,
        };
      });

      // Draw points line chart
      requestAnimationFrame(() => {
        drawLineChart(chartCanvas, datasets, {
          xLabel: 'Races Completed',
          yLabel: 'Points',
          lineWidth: 2.5,
          showDots: true,
        });
      });

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

