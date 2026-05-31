// =============================================
// PITCORNER — Championship Standings
// Uses compiled season data (zero extra API calls)
// =============================================

import { getTeamColor, getPointsForPosition, getDriverFlagImg, $ } from './utils.js';
import { drawSparkline } from './charts.js';
import { showDriverProfile } from './driver-profile.js';
import { showTeamProfile } from './team-profile.js';
import { getSeasonData, computeStandingsFromSeason } from './season-data.js';

let cachedStandings = null;

/**
 * Render driver standings table
 */
function renderDriverStandings(standings, container) {
  const maxPoints = standings.drivers.length > 0 ? standings.drivers[0].points : 1;

  let html = `
    <div style="overflow-x:auto;">
    <table class="standings-table" id="drivers-standings-table">
      <thead>
        <tr>
          <th style="width:40px">Pos</th>
          <th>Driver</th>
          <th style="width:80px">Points</th>
          <th style="width:120px"></th>
          <th style="width:60px">Wins</th>
          <th style="width:70px">Podiums</th>
          <th style="width:80px">Trend</th>
        </tr>
      </thead>
      <tbody>
  `;

  standings.drivers.forEach((d, i) => {
    const pos = i + 1;
    const posClass = pos <= 3 ? `p${pos}` : '';
    const barWidth = maxPoints > 0 ? (d.points / maxPoints) * 100 : 0;
    const teamColor = getTeamColor(d.team_colour);
    const sparkId = `sparkline-driver-${d.name_acronym}`;
    const isChampion = i === 0 && (standings.isFinished || standings.driverClinched);
    const champClass = isChampion ? 'champion-row' : '';

    html += `
      <tr data-driver="${d.name_acronym}" class="${champClass}">
        <td><span class="position-badge ${posClass}">${pos}</span></td>
        <td>
          <div class="driver-cell">
            <div class="team-color-bar" style="background:${teamColor}"></div>
            <img class="driver-headshot" src="${d.headshot_url || ''}" alt="${d.name_acronym}" loading="lazy" onerror="this.style.display='none'">
            <div class="driver-info">
              <div class="driver-name" style="display:flex;align-items:center;gap:6px;">
                ${getDriverFlagImg(d.name_acronym, 'width:15px;box-shadow:none;border-radius:1px;flex-shrink:0;')}
                <span>${d.full_name || d.name_acronym}</span>
                ${isChampion ? `<span class="champion-badge ${!standings.isFinished ? 'clinched' : ''}" title="${standings.isFinished ? 'World Champion' : 'Mathematically Secured Title'}"><i class="fa-solid fa-crown"></i> ${standings.isFinished ? 'Champion' : 'Clinched'}</span>` : ''}
              </div>
              <div class="driver-team">${d.team_name}</div>
            </div>
          </div>
        </td>
        <td class="points-cell">${d.points}</td>
        <td>
          <div class="points-bar-wrap">
            <div class="points-bar" style="width:${barWidth}%;background:${teamColor}"></div>
          </div>
        </td>
        <td style="text-align:center">${d.wins}</td>
        <td style="text-align:center">${d.podiums}</td>
        <td class="sparkline-cell"><canvas id="${sparkId}" width="80" height="28" style="width:80px;height:28px"></canvas></td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  requestAnimationFrame(() => {
    standings.drivers.forEach(d => {
      const canvas = document.getElementById(`sparkline-driver-${d.name_acronym}`);
      if (canvas && (d.pointsHistory && d.pointsHistory.length > 1)) {
        drawSparkline(canvas, d.pointsHistory, getTeamColor(d.team_colour));
      } else if (canvas && d.raceResults.length > 1) {
        let cumulative = [];
        let sum = 0;
        for (const res of d.raceResults) {
          sum += getPointsForPosition(res);
          cumulative.push(sum);
        }
        drawSparkline(canvas, cumulative, getTeamColor(d.team_colour));
      }
    });
  });

  // Click-to-open driver profile & Teammate hover visual connection
  container.querySelectorAll('tr[data-driver]').forEach(row => {
    row.addEventListener('click', () => {
      const acronym = row.dataset.driver;
      const driver = standings.drivers.find(d => d.name_acronym === acronym);
      if (driver) {
        showDriverProfile(driver, standings, standings.raceSessions || []);
      }
    });

    row.addEventListener('mouseenter', () => {
      const acronym = row.dataset.driver;
      const driver = standings.drivers.find(d => d.name_acronym === acronym);
      if (driver) {
        const teamName = driver.team_name;
        container.querySelectorAll('tr[data-driver]').forEach(otherRow => {
          if (otherRow !== row) {
            const otherAcronym = otherRow.dataset.driver;
            const otherDriver = standings.drivers.find(d => d.name_acronym === otherAcronym);
            if (otherDriver && otherDriver.team_name === teamName) {
              otherRow.style.background = 'rgba(255, 255, 255, 0.04)';
              otherRow.style.boxShadow = `inset 4px 0 0 ${getTeamColor(driver.team_colour)}`;
              otherRow.style.transition = 'all var(--transition-fast)';
            } else {
              otherRow.style.opacity = '0.35';
              otherRow.style.transition = 'all var(--transition-fast)';
            }
          }
        });
      }
    });

    row.addEventListener('mouseleave', () => {
      container.querySelectorAll('tr[data-driver]').forEach(otherRow => {
        otherRow.style.background = '';
        otherRow.style.boxShadow = '';
        otherRow.style.opacity = '';
        otherRow.style.transition = 'all var(--transition-fast)';
      });
    });
  });
}

/**
 * Render constructor standings table
 */
function renderConstructorStandings(standings, container) {
  const maxPoints = standings.constructors.length > 0 ? standings.constructors[0].points : 1;

  let html = `
    <div style="overflow-x:auto;">
    <table class="standings-table" id="constructors-standings-table">
      <thead>
        <tr>
          <th style="width:40px">Pos</th>
          <th>Constructor</th>
          <th style="width:80px">Points</th>
          <th style="width:200px"></th>
          <th style="width:60px">Wins</th>
          <th style="width:160px">Drivers</th>
        </tr>
      </thead>
      <tbody>
  `;

  standings.constructors.forEach((t, i) => {
    const pos = i + 1;
    const posClass = pos <= 3 ? `p${pos}` : '';
    const teamColor = getTeamColor(t.team_colour);
    const barWidth = maxPoints > 0 ? (t.points / maxPoints) * 100 : 0;
    const isChampion = i === 0 && (standings.isFinished || standings.constructorClinched);
    const champClass = isChampion ? 'champion-row' : '';

    const totalTeamPts = t.points || 1;
    const driverBars = t.drivers.map((d, idx) =>
      `<span style="display:inline-block;width:${(d.points / totalTeamPts) * 100}%;min-width:8px;height:6px;background:${teamColor};opacity:${idx === 0 ? 1 : 0.5};border-radius:3px;"></span>`
    ).join('');

    html += `
      <tr data-team="${t.team_name}" class="${champClass}">
        <td><span class="position-badge ${posClass}">${pos}</span></td>
        <td>
          <div class="driver-cell">
            <div class="team-color-bar" style="background:${teamColor}"></div>
            <div class="driver-info">
              <div class="driver-name" style="display:flex;align-items:center;gap:8px;">
                <span>${t.team_name}</span>
                ${isChampion ? `<span class="champion-badge constructor ${!standings.isFinished ? 'clinched' : ''}" title="${standings.isFinished ? 'World Constructor Champion' : 'Mathematically Secured Title'}"><i class="fa-solid fa-trophy"></i> ${standings.isFinished ? 'Champion' : 'Clinched'}</span>` : ''}
              </div>
            </div>
          </div>
        </td>
        <td class="points-cell">${t.points}</td>
        <td>
          <div class="points-bar-wrap">
            <div class="points-bar" style="width:${barWidth}%;background:${teamColor}"></div>
          </div>
        </td>
        <td style="text-align:center">${t.wins}</td>
        <td>
          <div class="constructor-drivers">
            ${t.drivers.map(d => `<span>${d.name} (${d.points})</span>`).join(' · ')}
          </div>
          <div class="constructor-bar-container">${driverBars}</div>
        </td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  // Click-to-open team profile
  container.querySelectorAll('tr[data-team]').forEach(row => {
    row.addEventListener('click', () => {
      const teamName = row.dataset.team;
      const team = standings.constructors.find(t => t.team_name === teamName);
      if (team) {
        showTeamProfile(team, standings);
      }
    });
  });
}

/**
 * Initialize standings section
 */
export async function initStandings(year) {
  const container = $('#standings-content');
  container.innerHTML = Array(10).fill('<div class="skeleton skeleton-row"></div>').join('');

  try {
    // Get compiled season data (shared with calendar, H2H, dashboard)
    const seasonData = await getSeasonData(year);

    // Compute standings from compiled data (zero API calls)
    const standings = computeStandingsFromSeason(seasonData);
    cachedStandings = standings;

    if (standings.drivers.length === 0) {
      container.innerHTML = `
        <div class="no-data">
          <div class="no-data-icon"><i class="fa-solid fa-flag-checkered fa-2x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div>
          <div class="no-data-text">No race results yet for ${year}</div>
          <div class="no-data-subtext">Standings will appear once races are completed</div>
        </div>
      `;
      return;
    }

    renderDriverStandings(standings, container);

    const driversBtn = $('#standings-drivers-btn');
    const constructorsBtn = $('#standings-constructors-btn');

    // Reset active state + clone to remove old event listeners
    const newDriversBtn = driversBtn.cloneNode(true);
    const newConstructorsBtn = constructorsBtn.cloneNode(true);
    newDriversBtn.classList.add('active');
    newConstructorsBtn.classList.remove('active');
    driversBtn.parentNode.replaceChild(newDriversBtn, driversBtn);
    constructorsBtn.parentNode.replaceChild(newConstructorsBtn, constructorsBtn);

    newDriversBtn.addEventListener('click', () => {
      newDriversBtn.classList.add('active');
      newConstructorsBtn.classList.remove('active');
      renderDriverStandings(standings, container);
    });

    newConstructorsBtn.addEventListener('click', () => {
      newConstructorsBtn.classList.add('active');
      newDriversBtn.classList.remove('active');
      renderConstructorStandings(standings, container);
    });

  } catch (err) {
    console.error('Standings init failed:', err);
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load standings</div></div>';
  }
}

export function getStandingsData() {
  return cachedStandings;
}
