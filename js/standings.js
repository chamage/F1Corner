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
let activeSeasonData = null;
let activeYear = null;
let selectedRound = null; // null = latest completed round; number = specific round 1..N
let currentView = 'drivers'; // 'drivers' or 'constructors'

function buildHistoricalNoticeBannerHTML(standings) {
  if (!standings || !standings.isHistoricalRound || !standings.selectedMeeting) return '';
  const m = standings.selectedMeeting;
  const circuit = m.circuit_short_name || 'Grand Prix';
  return `
    <div class="standings-historical-banner">
      <div class="historical-banner-left">
        <i class="fa-solid fa-clock-rotate-left"></i>
        <span>Standings as of <strong>Round ${standings.currentRound}: ${circuit} GP</strong> (${standings.currentRound} of ${standings.totalRounds} completed races)</span>
      </div>
      <button class="historical-reset-btn" id="standings-historical-banner-reset" title="Show current/latest standings">
        <i class="fa-solid fa-forward-step"></i> View Latest Standings
      </button>
    </div>
  `;
}

function getPositionChangeHTML(change) {
  if (change > 0) {
    return `<span class="pos-change up" title="Gained ${change} position${change > 1 ? 's' : ''} since last race"><i class="fa-solid fa-caret-up"></i>${change}</span>`;
  } else if (change < 0) {
    const abs = Math.abs(change);
    return `<span class="pos-change down" title="Lost ${abs} position${abs > 1 ? 's' : ''} since last race"><i class="fa-solid fa-caret-down"></i>${abs}</span>`;
  }
  return '';
}

function buildStandingsOutlookBannerHTML(standings, isConstructors = false) {
  if (!standings || standings.isFinished || standings.isPreliminary) return '';
  const maxPts = isConstructors ? standings.maxRemainingConstructorPoints : standings.maxRemainingDriverPoints;
  if (!maxPts || maxPts <= 0) return '';

  const remGPs = standings.remainingGPs || 0;
  const remSprints = standings.remainingSprints || 0;
  if (remGPs === 0 && remSprints === 0) return '';

  const parts = [];
  if (remGPs > 0) parts.push(`${remGPs} GP${remGPs !== 1 ? 's' : ''}`);
  if (remSprints > 0) parts.push(`${remSprints} Sprint${remSprints !== 1 ? 's' : ''}`);
  const eventsText = `${parts.join(' + ')} left`;

  const sc = standings.scoringInfo || {};
  const breakdownParts = [];
  if (remGPs > 0) {
    const perGp = isConstructors ? (sc.maxConstructorPointsPerGP || 43) : (sc.maxPointsPerGP || 25);
    breakdownParts.push(`${perGp}/GP${sc.awardFastestLap ? ' (incl. FL)' : ''}`);
  }
  if (remSprints > 0) {
    const perSp = isConstructors ? (sc.maxConstructorSprintPoints || 15) : (sc.maxSprintPoints || 8);
    if (perSp > 0) breakdownParts.push(`${perSp}/Sprint`);
  }
  if (sc.doublePointsFinal) {
    breakdownParts.push('2× Finale');
  }

  return `
    <div class="standings-outlook-bar">
      <div class="outlook-bar-left">
        <i class="fa-solid fa-flag-checkered outlook-bar-icon"></i>
        <span><strong>${eventsText}</strong> in championship</span>
      </div>
      <div class="outlook-bar-right">
        <span class="outlook-max-pill">Max <strong>+${maxPts} pts</strong> available</span>
        ${breakdownParts.length > 0 ? `<span class="outlook-breakdown">${breakdownParts.join(' · ')}</span>` : ''}
      </div>
    </div>
  `;
}

function getPossiblePositionBadgeHTML(item, pos) {
  const best = item.bestPos ?? pos;
  const worst = item.worstPos ?? pos;
  const maxPts = item.maxPossiblePoints ?? item.points;

  if (best === worst) {
    return `<span class="pos-range-pill locked ${best === 1 ? 'title-locked' : ''}" title="Mathematically locked at P${best} • Max possible: ${maxPts} pts"><i class="fa-solid fa-lock"></i> P${best}</span>`;
  }

  const canGain = Math.max(0, pos - best);
  const canLose = Math.max(0, worst - pos);
  const stateClass = best === 1
    ? 'contender'
    : (canGain > 0 && canLose === 0 ? 'upward' : (canGain === 0 && canLose > 0 ? 'at-risk' : ''));

  const gainNote = canGain > 0 ? `can gain ${canGain}` : 'cannot gain higher';
  const loseNote = canLose > 0 ? `can lose ${canLose}` : 'safe from behind';
  const tooltip = `Best: P${best} • Worst: P${worst} • Max possible: ${maxPts} pts (${gainNote}, ${loseNote})`;

  return `
    <span class="pos-range-pill ${stateClass}" title="${tooltip}">
      ${best === 1 ? '<i class="fa-solid fa-trophy pos-range-trophy"></i>' : ''}
      <span class="pos-range-text">P${best}–P${worst}</span>
      <span class="pos-range-deltas">${canGain > 0 ? `<span class="delta-up">↑${canGain}</span>` : ''}${canLose > 0 ? `<span class="delta-down">↓${canLose}</span>` : ''}</span>
    </span>
  `;
}

/**
 * Render driver standings table
 */
export function renderDriverStandings(standings, container) {
  const maxPoints = standings.drivers.length > 0 ? standings.drivers[0].points : 1;
  const showRange = !standings.isFinished && !standings.isPreliminary && (standings.maxRemainingDriverPoints || 0) > 0;

  let html = buildHistoricalNoticeBannerHTML(standings);
  html += buildStandingsOutlookBannerHTML(standings, false);
  html += `
    <div style="overflow-x:auto;">
    <table class="standings-table drivers-standings-table" id="drivers-standings-table">
      <thead>
        <tr>
          <th style="width:40px">Pos</th>
          <th>Driver</th>
          <th style="width:80px">Points</th>
          <th class="col-pts-bar" style="width:120px"></th>
          ${showRange ? '<th class="col-pos-range" style="width:118px;text-align:center;" title="Mathematically achievable finishing positions">Possible</th>' : ''}
          <th class="col-wins" style="width:60px;text-align:center;">Wins</th>
          <th class="col-podiums" style="width:70px;text-align:center;">Podiums</th>
          <th class="col-trend" style="width:80px">Trend</th>
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
      <tr data-driver="${d.name_acronym}" class="${champClass}" style="cursor:pointer;">
        <td>
          <div class="pos-cell-container">
            <span class="position-badge ${posClass}">${pos}</span>
            ${getPositionChangeHTML(d.positionChange)}
          </div>
        </td>
        <td>
          <div class="driver-cell">
            <div class="team-color-bar" style="background:${teamColor}"></div>
            <img class="driver-headshot" src="${d.headshot_url || ''}" alt="${d.name_acronym}" loading="lazy" onerror="this.style.display='none'">
            <div class="driver-info">
              <div class="driver-name" style="display:flex;align-items:center;gap:6px;">
                ${getDriverFlagImg(d.name_acronym, 'width:15px;box-shadow:none;border-radius:1px;flex-shrink:0;')}
                <span class="driver-name-full">${d.full_name || d.name_acronym}</span>
                <span class="driver-name-acronym">${d.name_acronym}</span>
                ${isChampion ? `<span class="champion-badge ${!standings.isFinished ? 'clinched' : ''}" title="${standings.isFinished ? 'World Champion' : 'Mathematically Secured Title'}"><i class="fa-solid fa-crown"></i> <span class="badge-text">${standings.isFinished ? 'Champion' : 'Clinched'}</span></span>` : ''}
              </div>
              <div class="driver-team">${d.team_name}</div>
            </div>
          </div>
        </td>
        <td class="points-cell">${d.points}</td>
        <td class="col-pts-bar">
          <div class="points-bar-wrap">
            <div class="points-bar" style="width:${barWidth}%;background:${teamColor}"></div>
          </div>
        </td>
        ${showRange ? `<td class="col-pos-range" style="text-align:center;">${getPossiblePositionBadgeHTML(d, pos)}</td>` : ''}
        <td class="col-wins" style="text-align:center">${d.wins}</td>
        <td class="col-podiums" style="text-align:center">${d.podiums}</td>
        <td class="sparkline-cell col-trend"><canvas id="${sparkId}" width="80" height="28" style="width:80px;height:28px"></canvas></td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  const historicalResetBtn = container.querySelector('#standings-historical-banner-reset');
  if (historicalResetBtn) {
    historicalResetBtn.addEventListener('click', () => setStandingsRound(null));
  }

  // Draw sparklines after DOM is painted
  requestAnimationFrame(() => {
    drawStandingsSparklines(standings, container);
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
            if (teamName && teamName !== 'Unknown' && otherDriver && otherDriver.team_name === teamName) {
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
export function renderConstructorStandings(standings, container) {
  const maxPoints = standings.constructors.length > 0 ? standings.constructors[0].points : 1;
  const showRange = !standings.isFinished && !standings.isPreliminary && (standings.maxRemainingConstructorPoints || 0) > 0;

  let html = buildHistoricalNoticeBannerHTML(standings);
  html += buildStandingsOutlookBannerHTML(standings, true);
  html += `
    <div style="overflow-x:auto;">
    <table class="standings-table constructors-standings-table" id="constructors-standings-table">
      <thead>
        <tr>
          <th style="width:40px">Pos</th>
          <th>Constructor</th>
          <th style="width:80px">Points</th>
          <th class="col-pts-bar" style="width:180px"></th>
          ${showRange ? '<th class="col-pos-range" style="width:118px;text-align:center;" title="Mathematically achievable finishing positions">Possible</th>' : ''}
          <th class="col-wins" style="width:60px;text-align:center;">Wins</th>
          <th class="col-team-drivers" style="width:160px">Drivers</th>
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

    const driverCount = Math.max(t.drivers.length, 1);
    const driverBars = t.drivers.map((d, idx) => {
      const segPct = t.points > 0 ? (d.points / t.points) * 100 : (100 / driverCount);
      return `<span style="display:inline-block;width:${segPct}%;min-width:${d.points > 0 || t.points === 0 ? 6 : 3}px;height:6px;background:${teamColor};opacity:${idx === 0 ? 1 : (idx === 1 ? 0.6 : 0.38)};border-radius:3px;"></span>`;
    }).join('');

    html += `
      <tr data-team="${t.team_name}" class="${champClass}" style="cursor:pointer;">
        <td>
          <div class="pos-cell-container">
            <span class="position-badge ${posClass}">${pos}</span>
            ${getPositionChangeHTML(t.positionChange)}
          </div>
        </td>
        <td>
          <div class="driver-cell">
            <div class="team-color-bar" style="background:${teamColor}"></div>
            <div class="driver-info">
              <div class="driver-name" style="display:flex;align-items:center;gap:8px;">
                <span>${t.team_name}</span>
                ${isChampion ? `<span class="champion-badge constructor ${!standings.isFinished ? 'clinched' : ''}" title="${standings.isFinished ? 'World Constructor Champion' : 'Mathematically Secured Title'}"><i class="fa-solid fa-trophy"></i> <span class="badge-text">${standings.isFinished ? 'Champion' : 'Clinched'}</span></span>` : ''}
              </div>
            </div>
          </div>
        </td>
        <td class="points-cell">${t.points}</td>
        <td class="col-pts-bar">
          <div class="points-bar-wrap">
            <div class="points-bar" style="width:${barWidth}%;background:${teamColor}"></div>
          </div>
        </td>
        ${showRange ? `<td class="col-pos-range" style="text-align:center;">${getPossiblePositionBadgeHTML(t, pos)}</td>` : ''}
        <td class="col-wins" style="text-align:center">${t.wins}</td>
        <td class="col-team-drivers">
          <div class="constructor-drivers">
            ${t.drivers.map(d => `<span class="constructor-driver-chip">${d.name} (${d.points})</span>`).join('')}
          </div>
          <div class="constructor-bar-container">${driverBars}</div>
        </td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  const historicalResetBtn = container.querySelector('#standings-historical-banner-reset');
  if (historicalResetBtn) {
    historicalResetBtn.addEventListener('click', () => setStandingsRound(null));
  }

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
 * Set and switch standings to a specific round (or null for latest)
 */
export function setStandingsRound(round) {
  selectedRound = (round === null || round === 'latest' || round === undefined)
    ? null
    : (parseInt(round, 10) || null);
  renderStandingsForCurrentState();
}

/**
 * Initialize standings section
 */
export async function initStandings(year) {
  const container = $('#standings-content');
  if (container) {
    container.innerHTML = Array(10).fill('<div class="skeleton skeleton-row"></div>').join('');
  }

  if (activeYear !== year) {
    selectedRound = null;
    currentView = 'drivers';
  }
  activeYear = year;

  try {
    const seasonData = await getSeasonData(year);
    activeSeasonData = seasonData;

    renderStandingsForCurrentState();
  } catch (err) {
    console.error('Standings init failed:', err);
    if (container) {
      container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load standings</div></div>';
    }
  }
}

function renderStandingsForCurrentState() {
  const container = $('#standings-content');
  const heatmapContainer = $('#standings-heatmap-content');
  const roundControl = $('#standings-round-control');

  if (!activeSeasonData || !container) return;

  const standings = computeStandingsFromSeason(activeSeasonData, selectedRound);
  cachedStandings = standings;

  if (standings.drivers.length === 0) {
    if (roundControl) roundControl.style.display = 'none';
    container.innerHTML = `
      <div class="no-data">
        <div class="no-data-icon"><i class="fa-solid fa-flag-checkered fa-2x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div>
        <div class="no-data-text">No race results yet for ${activeYear}</div>
        <div class="no-data-subtext">Standings will appear once races are completed</div>
      </div>
    `;
    return;
  }

  setupRoundSelector(standings);
  setupToggleButtons();

  if (currentView === 'constructors') {
    renderConstructorStandings(standings, container);
    if (heatmapContainer) {
      renderFinishingHeatmap(standings, heatmapContainer, 'constructors');
    }
  } else {
    renderDriverStandings(standings, container);
    if (heatmapContainer) {
      renderFinishingHeatmap(standings, heatmapContainer, 'drivers');
    }
  }

  // Re-apply active search filter if any
  if (currentSearchQuery) {
    const input = $('#standings-search-input');
    if (input) input.dispatchEvent(new Event('input'));
  }
}

let searchWired = false;
let currentSearchQuery = '';

function setupToggleButtons() {
  const driversBtn = $('#standings-drivers-btn');
  const constructorsBtn = $('#standings-constructors-btn');
  const tableBtn = $('#standings-view-table-btn');
  const heatmapBtn = $('#standings-view-heatmap-btn');

  if (driversBtn && constructorsBtn) {
    driversBtn.classList.toggle('active', currentView === 'drivers');
    constructorsBtn.classList.toggle('active', currentView === 'constructors');

    driversBtn.onclick = () => {
      if (currentView === 'drivers') return;
      currentView = 'drivers';
      renderStandingsForCurrentState();
    };

    constructorsBtn.onclick = () => {
      if (currentView === 'constructors') return;
      currentView = 'constructors';
      renderStandingsForCurrentState();
    };
  }

  // Standings Table vs Heatmap View Switcher
  if (tableBtn && heatmapBtn) {
    tableBtn.onclick = () => {
      tableBtn.classList.add('active');
      heatmapBtn.classList.remove('active');
      const tableCard = $('#standings-content')?.closest('.glass-card');
      if (tableCard) {
        tableCard.style.display = 'block';
        tableCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      const heatmapCard = $('#standings-heatmap-content')?.closest('.glass-card');
      if (heatmapCard) heatmapCard.style.display = 'block';
    };

    heatmapBtn.onclick = () => {
      heatmapBtn.classList.add('active');
      tableBtn.classList.remove('active');
      const heatmapCard = $('#standings-heatmap-content')?.closest('.glass-card');
      if (heatmapCard) {
        heatmapCard.style.display = 'block';
        heatmapCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
  }

  setupSearchFilter();
}

function setupSearchFilter() {
  if (searchWired) return;
  const input = $('#standings-search-input');
  const clearBtn = $('#standings-search-clear');
  if (!input) return;

  searchWired = true;

  const applyFilter = (q) => {
    currentSearchQuery = q.trim().toLowerCase();
    if (clearBtn) {
      clearBtn.style.display = currentSearchQuery.length > 0 ? 'inline-flex' : 'none';
    }

    const container = $('#standings-content');
    const heatmapContainer = $('#standings-heatmap-content');

    const filterRows = (parentEl) => {
      if (!parentEl) return;
      const rows = parentEl.querySelectorAll('tbody tr');
      rows.forEach(tr => {
        if (!currentSearchQuery) {
          tr.style.display = '';
          return;
        }
        const text = tr.textContent.toLowerCase();
        tr.style.display = text.includes(currentSearchQuery) ? '' : 'none';
      });
    };

    filterRows(container);
    filterRows(heatmapContainer);
  };

  input.addEventListener('input', (e) => {
    applyFilter(e.target.value);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      applyFilter('');
      input.focus();
    });
  }
}

function setupRoundSelector(standings) {
  const roundControl = $('#standings-round-control');
  const select = $('#standings-round-select');
  const prevBtn = $('#standings-round-prev');
  const nextBtn = $('#standings-round-next');
  const resetBtn = $('#standings-round-reset');

  if (!roundControl || !select) return;

  const available = standings.availableRounds || [];
  if (available.length <= 1) {
    roundControl.style.display = 'none';
    return;
  }

  roundControl.style.display = 'flex';

  const totalRounds = standings.totalRounds;
  const currentRound = standings.selectedRound || totalRounds;
  const isHistorical = !!standings.isHistoricalRound;

  // Build select options
  const isSeasonCompleted = !!standings.isFinished && !standings.isPreliminary;
  const latestLabel = isSeasonCompleted
    ? `End of Season (Round ${totalRounds} • ${available[totalRounds - 1]?.circuit_short_name || 'Final'} GP)`
    : `Latest (Round ${totalRounds} • ${available[totalRounds - 1]?.circuit_short_name || 'Latest'} GP)`;

  let optionsHtml = `<option value="latest" ${!isHistorical ? 'selected' : ''}>${latestLabel}</option>`;
  for (let i = 0; i < available.length; i++) {
    const r = available[i];
    const isSelected = isHistorical && currentRound === r.round;
    const sprintBadge = r.hasSprint ? ' (+Sprint)' : '';
    optionsHtml += `<option value="${r.round}" ${isSelected ? 'selected' : ''}>Round ${r.round}: ${r.circuit_short_name} GP${sprintBadge}</option>`;
  }
  select.innerHTML = optionsHtml;

  if (prevBtn) {
    prevBtn.disabled = currentRound <= 1;
    prevBtn.onclick = () => {
      const target = Math.max(1, currentRound - 1);
      setStandingsRound(target);
    };
  }
  if (nextBtn) {
    nextBtn.disabled = !isHistorical || currentRound >= totalRounds;
    nextBtn.onclick = () => {
      const target = currentRound + 1;
      if (target >= totalRounds) {
        setStandingsRound(null);
      } else {
        setStandingsRound(target);
      }
    };
  }
  if (resetBtn) {
    resetBtn.style.display = isHistorical ? 'inline-flex' : 'none';
    resetBtn.onclick = () => setStandingsRound(null);
  }

  select.onchange = (e) => {
    const val = e.target.value;
    if (val === 'latest') {
      setStandingsRound(null);
    } else {
      setStandingsRound(parseInt(val, 10));
    }
  };
}

export function getStandingsData() {
  return cachedStandings;
}

/**
 * Switch the active standings table/heatmap view ('drivers' or 'constructors')
 */
export function setStandingsView(view) {
  if (view !== 'drivers' && view !== 'constructors') return;
  currentView = view;
  renderStandingsForCurrentState();
}

/**
 * Draw sparkline canvases for driver standings inside a given container.
 * Uses container-scoped querySelector to avoid duplicate ID collisions
 * between main standings and Alt History sandbox standings.
 * Can be called on tab switch to redraw canvases that were zero-width when hidden.
 */
export function drawStandingsSparklines(standings, container) {
  if (!standings || !standings.drivers || !container) return;
  standings.drivers.forEach(d => {
    const canvas = container.querySelector(`#sparkline-driver-${d.name_acronym}`);
    if (!canvas) return;
    // Skip if canvas has zero dimensions (still hidden)
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (d.pointsHistory && d.pointsHistory.length > 1) {
      drawSparkline(canvas, d.pointsHistory, getTeamColor(d.team_colour));
    } else if (d.raceResults && d.raceResults.length > 1) {
      let cumulative = [];
      let sum = 0;
      for (const res of d.raceResults) {
        sum += getPointsForPosition(res);
        cumulative.push(sum);
      }
      drawSparkline(canvas, cumulative, getTeamColor(d.team_colour));
    }
  });
}

/**
 * Render Finishing Position Heatmap Grid for Driver or Constructor Standings
 */
export function renderFinishingHeatmap(standings, container, type = 'drivers') {
  if (!standings || !container) return;

  const isDrivers = type === 'drivers';
  
  if (isDrivers && (!standings.drivers || standings.drivers.length === 0)) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">No data available for heatmap</div></div>';
    return;
  }
  if (!isDrivers && (!standings.constructors || standings.constructors.length === 0)) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">No data available for heatmap</div></div>';
    return;
  }

  let listData = [];
  let maxCount = 1;

  if (isDrivers) {
    listData = standings.drivers.map((d, idx) => {
      const counts = {
        p1: 0, p2: 0, p3: 0, p4: 0, p5: 0,
        p6: 0, p7: 0, p8: 0, p9: 0, p10: 0,
        p11Plus: 0,
        retired: 0
      };

      const gpResults = d.allResults ? d.allResults.filter(r => !r.isSprint) : [];
      gpResults.forEach(r => {
        const pos = r.position;
        const status = r.status;
        if (status === 'FINISHED') {
          if (pos === 1) counts.p1++;
          else if (pos === 2) counts.p2++;
          else if (pos === 3) counts.p3++;
          else if (pos === 4) counts.p4++;
          else if (pos === 5) counts.p5++;
          else if (pos === 6) counts.p6++;
          else if (pos === 7) counts.p7++;
          else if (pos === 8) counts.p8++;
          else if (pos === 9) counts.p9++;
          else if (pos === 10) counts.p10++;
          else if (pos >= 11) counts.p11Plus++;
        } else if (status === 'DNF' || status === 'DNS' || status === 'DSQ') {
          counts.retired++;
        }
      });

      return {
        rank: idx + 1,
        team_colour: d.team_colour,
        team_name: d.team_name,
        name: d.full_name || d.name_acronym,
        name_acronym: d.name_acronym,
        counts
      };
    });
  } else {
    // Constructors - Compile team results from all driver histories
    const teamDataMap = new Map();
    standings.constructors.forEach((team, idx) => {
      teamDataMap.set(team.team_name, {
        rank: idx + 1,
        team_name: team.team_name,
        team_colour: team.team_colour,
        counts: {
          p1: 0, p2: 0, p3: 0, p4: 0, p5: 0,
          p6: 0, p7: 0, p8: 0, p9: 0, p10: 0,
          p11Plus: 0,
          retired: 0
        }
      });
    });

    standings.drivers.forEach(d => {
      const gpResults = d.allResults ? d.allResults.filter(r => !r.isSprint) : [];
      gpResults.forEach(r => {
        if (r.status === 'ABSENT') return;
        const teamName = r.team_name || d.team_name;
        if (!teamDataMap.has(teamName)) return;
        const item = teamDataMap.get(teamName);
        const pos = r.position;
        const status = r.status;
        if (status === 'FINISHED') {
          if (pos === 1) item.counts.p1++;
          else if (pos === 2) item.counts.p2++;
          else if (pos === 3) item.counts.p3++;
          else if (pos === 4) item.counts.p4++;
          else if (pos === 5) item.counts.p5++;
          else if (pos === 6) item.counts.p6++;
          else if (pos === 7) item.counts.p7++;
          else if (pos === 8) item.counts.p8++;
          else if (pos === 9) item.counts.p9++;
          else if (pos === 10) item.counts.p10++;
          else if (pos >= 11) item.counts.p11Plus++;
        } else if (status === 'DNF' || status === 'DNS' || status === 'DSQ') {
          item.counts.retired++;
        }
      });
    });

    listData = Array.from(teamDataMap.values());
  }

  // Find max count to scale opacity
  listData.forEach(item => {
    Object.values(item.counts).forEach(val => {
      if (val > maxCount) maxCount = val;
    });
  });

  // Helper to parse hex colors
  const hexToRgb = (hex) => {
    const cleanHex = hex.replace('#', '');
    const num = parseInt(cleanHex, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  };

  // Generate Heatmap Table HTML
  let html = `
    <div style="overflow-x:auto; margin-top:4px;">
    <table class="standings-table heatmap-table" id="${isDrivers ? 'drivers' : 'constructors'}-heatmap-table" style="border-collapse:collapse; min-width:650px;">
      <thead>
        <tr>
          <th style="width:40px; text-align:center;">Pos</th>
          <th>${isDrivers ? 'Driver' : 'Constructor'}</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P1</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P2</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P3</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P4</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P5</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P6</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P7</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P8</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P9</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">P10</th>
          <th style="width:44px; text-align:center; padding: 10px 4px;">P11+</th>
          <th style="width:40px; text-align:center; padding: 10px 4px;">Ret</th>
        </tr>
      </thead>
      <tbody>
  `;

  listData.forEach(item => {
    const teamColorHex = getTeamColor(item.team_colour);
    const { r, g, b } = hexToRgb(teamColorHex);

    const makeCell = (count) => {
      if (count === 0) {
        return `<td style="text-align:center; font-family:'JetBrains Mono',monospace; font-size:0.8rem; color:rgba(255,255,255,0.06); padding: 8px 4px; border:1px solid rgba(255,255,255,0.02);">-</td>`;
      }
      const opacity = (count / maxCount) * 0.7 + 0.18;
      const bg = `rgba(${r}, ${g}, ${b}, ${opacity})`;
      const textCol = '#ffffff';

      return `<td style="text-align:center; font-family:'JetBrains Mono',monospace; font-size:0.8rem; font-weight:800; color:${textCol}; background:${bg}; padding: 8px 4px; border:1px solid rgba(255,255,255,0.04);" class="heatmap-cell" data-count="${count}">
        ${count}
      </td>`;
    };

    html += `
      <tr ${isDrivers ? `data-driver="${item.name_acronym}"` : `data-team="${item.team_name}"`}>
        <td style="text-align:center;">
          <span class="position-badge" style="width:22px; height:22px; font-size:0.7rem; border-radius:50%;">${item.rank}</span>
        </td>
        <td>
          <div class="driver-cell" style="padding:0;">
            <div class="team-color-bar" style="background:${teamColorHex}; height:16px;"></div>
            <div class="driver-info">
              <div class="driver-name" style="display:flex;align-items:center;gap:6px;font-size:0.85rem;font-weight:700;">
                ${isDrivers ? `
                  <span class="driver-name-full">${item.name}</span>
                  <span class="driver-name-acronym">${item.name_acronym}</span>
                ` : `
                  <span>${item.team_name}</span>
                `}
              </div>
              ${isDrivers ? `<div class="driver-team" style="font-size:0.68rem;opacity:0.75;">${item.team_name}</div>` : ''}
            </div>
          </div>
        </td>
        ${makeCell(item.counts.p1)}
        ${makeCell(item.counts.p2)}
        ${makeCell(item.counts.p3)}
        ${makeCell(item.counts.p4)}
        ${makeCell(item.counts.p5)}
        ${makeCell(item.counts.p6)}
        ${makeCell(item.counts.p7)}
        ${makeCell(item.counts.p8)}
        ${makeCell(item.counts.p9)}
        ${makeCell(item.counts.p10)}
        ${makeCell(item.counts.p11Plus)}
        ${makeCell(item.counts.retired)}
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  // Click row handlers
  if (isDrivers) {
    container.querySelectorAll('tr[data-driver]').forEach(row => {
      row.addEventListener('click', () => {
        const acronym = row.dataset.driver;
        const driver = standings.drivers.find(d => d.name_acronym === acronym);
        if (driver) {
          showDriverProfile(driver, standings, standings.raceSessions || []);
        }
      });
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255, 255, 255, 0.02)'; });
      row.style.cursor = 'pointer';
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
    });
  } else {
    container.querySelectorAll('tr[data-team]').forEach(row => {
      row.addEventListener('click', () => {
        const teamName = row.dataset.team;
        const team = standings.constructors.find(t => t.team_name === teamName);
        if (team) {
          showTeamProfile(team, standings);
        }
      });
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255, 255, 255, 0.02)'; });
      row.style.cursor = 'pointer';
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
    });
  }
}
