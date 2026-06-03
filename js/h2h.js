// =============================================
// PITCORNER — Head-to-Head Comparison
// Uses compiled season data (shared)
// =============================================

import { getOvertakes, getPits } from './api.js';
import { getSeasonData, computeStandingsFromSeason } from './season-data.js';
import { getTeamColor, isPast, getPointsForPosition, $, $$ } from './utils.js';

let h2hDrivers = [];
let h2hYear = null;
let h2hCompletedRaces = []; // compiled race data with results
let h2hSeasonData = null;

let selectedDriver1 = null;
let selectedDriver2 = null;

// Global listener to close custom selects when clicking elsewhere
document.addEventListener('click', () => {
  $$('.custom-select-container').forEach(c => c.classList.remove('open'));
});

export async function initH2H(year) {
  h2hYear = year;
  h2hDrivers = [];
  h2hCompletedRaces = [];
  selectedDriver1 = null;
  selectedDriver2 = null;

  const container = $('#h2h-content');

  try {
    // Use shared compiled season data (already fetched by standings)
    const seasonData = await getSeasonData(year);
    h2hSeasonData = seasonData;

    // Get completed race results from compiled data
    h2hCompletedRaces = (seasonData.races || []).filter(r =>
      r.session_name === 'Race' && r.results.length > 0
    );

    if (h2hCompletedRaces.length === 0) {
      container.innerHTML = `
        <div class="no-data">
          <div class="no-data-icon"><i class="fa-solid fa-flag-checkered fa-2x" style="color: var(--border-subtle); margin-bottom: var(--space-xs);"></i></div>
          <div class="no-data-text">No completed races yet for ${year}</div>
        </div>
      `;
      return;
    }

    // Get drivers from compiled standings data (fully aggregated)
    const standings = computeStandingsFromSeason(seasonData);
    h2hDrivers = standings.drivers;

    if (h2hDrivers.length < 2) {
      container.innerHTML = '<div class="no-data"><div class="no-data-text">Not enough driver data available</div></div>';
      return;
    }

    // Rebuild the entire H2H content with custom glassmorphic select triggers
    const defaultImg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect fill='%231a1a25' width='80' height='80'/%3E%3C/svg%3E";
    container.innerHTML = `
      <div class="h2h-selectors">
        <div class="h2h-driver-select">
          <img class="h2h-headshot" id="h2h-headshot1" src="${defaultImg}" alt="Driver 1" onerror="this.src='${defaultImg}'">
          
          <div class="custom-select-container" id="h2h-select-container-1">
            <button class="custom-select-trigger" id="h2h-trigger-1" type="button">
              <span class="custom-select-team-line" id="h2h-trigger-line-1"></span>
              <span class="custom-select-text" id="h2h-trigger-text-1">Select Driver 1</span>
              <span class="custom-select-arrow">▼</span>
            </button>
            <div class="custom-select-options" id="h2h-options-1"></div>
          </div>
        </div>
        
        <div class="h2h-vs">VS</div>
        
        <div class="h2h-driver-select">
          <img class="h2h-headshot" id="h2h-headshot2" src="${defaultImg}" alt="Driver 2" onerror="this.src='${defaultImg}'">
          
          <div class="custom-select-container" id="h2h-select-container-2">
            <button class="custom-select-trigger" id="h2h-trigger-2" type="button">
              <span class="custom-select-team-line" id="h2h-trigger-line-2"></span>
              <span class="custom-select-text" id="h2h-trigger-text-2">Select Driver 2</span>
              <span class="custom-select-arrow">▼</span>
            </button>
            <div class="custom-select-options" id="h2h-options-2"></div>
          </div>
        </div>
      </div>
      
      <div style="text-align:center;margin-bottom:8px;font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">Quick Pick: Teammate Battles</div>
      <div class="teammates-grid" id="teammates-grid"></div>
      
      <div class="h2h-comparison" id="h2h-comparison">
        <div class="skeleton skeleton-row"></div>
        <div class="skeleton skeleton-row"></div>
        <div class="skeleton skeleton-row"></div>
      </div>
    `;

    // Initialize custom select event handlers and group lists
    setupCustomDropdown('#h2h-select-container-1', '#h2h-trigger-1', '#h2h-trigger-text-1', '#h2h-trigger-line-1', '#h2h-options-1', true);
    setupCustomDropdown('#h2h-select-container-2', '#h2h-trigger-2', '#h2h-trigger-text-2', '#h2h-trigger-line-2', '#h2h-options-2', false);

    // Initial driver selections (top 2 drivers on the grid)
    if (h2hDrivers.length >= 2) {
      selectDriver(h2hDrivers[0].name_acronym, true);
      selectDriver(h2hDrivers[1].name_acronym, false);
    }

    renderTeammatePicks();

  } catch (err) {
    console.error('H2H init failed:', err);
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to load H2H data</div></div>';
  }
}

function setupCustomDropdown(containerSel, triggerSel, textSel, lineSel, optionsSel, isFirstDriver) {
  const container = $(containerSel);
  const trigger = $(triggerSel);
  const optionsEl = $(optionsSel);

  // Toggle trigger on click
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close other custom select containers first
    $$('.custom-select-container').forEach(c => {
      if (c !== container) c.classList.remove('open');
    });
    container.classList.toggle('open');
  });

  // Group drivers by team
  const teams = new Map();
  for (const d of h2hDrivers) {
    const team = d.team_name || 'Unknown';
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(d);
  }

  optionsEl.innerHTML = '';
  for (const [team, teamDrivers] of teams) {
    const groupTitle = document.createElement('div');
    groupTitle.className = 'custom-option-group-title';
    const tColor = getTeamColor(teamDrivers[0].team_colour);
    groupTitle.innerHTML = `
      <span class="custom-option-group-color-dot" style="background:${tColor}"></span>
      ${team}
    `;
    optionsEl.appendChild(groupTitle);

    for (const d of teamDrivers) {
      const opt = document.createElement('div');
      opt.className = 'custom-option';
      opt.dataset.value = d.name_acronym;
      opt.innerHTML = `${d.name_acronym} — ${d.full_name}`;
      
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        container.classList.remove('open');
        selectDriver(d.name_acronym, isFirstDriver);
      });
      
      optionsEl.appendChild(opt);
    }
  }
}

function selectDriver(driverAcronym, isFirstDriver) {
  const d = h2hDrivers.find(drv => drv.name_acronym === driverAcronym);
  if (!d) return;

  if (isFirstDriver) {
    selectedDriver1 = driverAcronym;
    $('#h2h-trigger-text-1').textContent = `${d.name_acronym} — ${d.full_name}`;
    $('#h2h-trigger-line-1').style.background = getTeamColor(d.team_colour);
    
    // Update selected class in options
    $$('#h2h-options-1 .custom-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === driverAcronym);
    });
  } else {
    selectedDriver2 = driverAcronym;
    $('#h2h-trigger-text-2').textContent = `${d.name_acronym} — ${d.full_name}`;
    $('#h2h-trigger-line-2').style.background = getTeamColor(d.team_colour);
    
    // Update selected class in options
    $$('#h2h-options-2 .custom-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === driverAcronym);
    });
  }

  updateHeadshots();
  runComparison();
}

function updateHeadshots() {
  const d1 = h2hDrivers.find(d => d.name_acronym === selectedDriver1);
  const d2 = h2hDrivers.find(d => d.name_acronym === selectedDriver2);

  const img1 = $('#h2h-headshot1');
  const img2 = $('#h2h-headshot2');

  const defaultImg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect fill='%231a1a25' width='80' height='80'/%3E%3C/svg%3E";

  if (d1) {
    if (d1.headshot_url) img1.src = d1.headshot_url;
    img1.style.borderColor = getTeamColor(d1.team_colour);
  } else {
    img1.src = defaultImg;
    img1.style.borderColor = 'var(--border-subtle)';
  }

  if (d2) {
    if (d2.headshot_url) img2.src = d2.headshot_url;
    img2.style.borderColor = getTeamColor(d2.team_colour);
  } else {
    img2.src = defaultImg;
    img2.style.borderColor = 'var(--border-subtle)';
  }
}

function renderTeammatePicks() {
  const container = $('#teammates-grid');
  if (!container) return;

  const teams = new Map();
  for (const d of h2hDrivers) {
    const team = d.team_name || 'Unknown';
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(d);
  }

  container.innerHTML = '';
  for (const [, drivers] of teams) {
    if (drivers.length >= 2) {
      const btn = document.createElement('button');
      btn.className = 'teammate-btn';
      btn.textContent = `${drivers[0].name_acronym} vs ${drivers[1].name_acronym}`;
      btn.addEventListener('click', () => {
        selectDriver(drivers[0].name_acronym, true);
        selectDriver(drivers[1].name_acronym, false);
        container.querySelectorAll('.teammate-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      container.appendChild(btn);
    }
  }
}

async function runComparison() {
  const dn1 = selectedDriver1;
  const dn2 = selectedDriver2;
  const container = $('#h2h-comparison');

  if (!dn1 || !dn2 || dn1 === dn2) {
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Select two different drivers to compare</div></div>';
    return;
  }

  container.innerHTML = Array(6).fill('<div class="skeleton skeleton-row"></div>').join('');

  const d1 = h2hDrivers.find(d => d.name_acronym === dn1);
  const d2 = h2hDrivers.find(d => d.name_acronym === dn2);
  const c1 = getTeamColor(d1?.team_colour);
  const c2 = getTeamColor(d2?.team_colour);

  try {
    // Use compiled race results (zero API calls for this part)
    let raceH2H_1 = 0, raceH2H_2 = 0;

    for (const race of h2hCompletedRaces) {
      const rd1 = race.drivers ? race.drivers.find(d => d.name_acronym === dn1) : null;
      const rd2 = race.drivers ? race.drivers.find(d => d.name_acronym === dn2) : null;
      
      const num1 = rd1 ? rd1.driver_number : null;
      const num2 = rd2 ? rd2.driver_number : null;

      const pos1 = num1 ? race.results.find(o => o.driver_number === num1) : null;
      const pos2 = num2 ? race.results.find(o => o.driver_number === num2) : null;

      if (pos1 && pos2) {
        if (pos1.position < pos2.position) raceH2H_1++;
        else if (pos2.position < pos1.position) raceH2H_2++;
      }
    }

    const totalPts1 = d1 ? d1.points : 0;
    const totalPts2 = d2 ? d2.points : 0;
    const wins1 = d1 ? d1.wins : 0;
    const wins2 = d2 ? d2.wins : 0;
    const podiums1 = d1 ? d1.podiums : 0;
    const podiums2 = d2 ? d2.podiums : 0;
    const finishes1 = d1 ? d1.raceResults : [];
    const finishes2 = d2 ? d2.raceResults : [];
    const bestFinish1 = finishes1.length > 0 ? Math.min(...finishes1) : 99;
    const bestFinish2 = finishes2.length > 0 ? Math.min(...finishes2) : 99;

    const avgFinish1 = finishes1.length > 0 ? (finishes1.reduce((a, b) => a + b, 0) / finishes1.length).toFixed(1) : '—';
    const avgFinish2 = finishes2.length > 0 ? (finishes2.reduce((a, b) => a + b, 0) / finishes2.length).toFixed(1) : '—';

    // Overtake & pit stats from recent races (small API calls, cached)
    let overtakesMade1 = 0, overtakesMade2 = 0;
    let pitTotal1 = 0, pitCount1 = 0, pitTotal2 = 0, pitCount2 = 0;

    const recentRaces = h2hCompletedRaces.slice(-5);
    const recentDataPromises = recentRaces.map(async (race) => {
      try {
        const [overtakes, pits] = await Promise.all([
          getOvertakes({ session_key: race.session_key }).catch(() => []),
          getPits({ session_key: race.session_key }).catch(() => []),
        ]);
        return { race, overtakes, pits };
      } catch {
        return { race, overtakes: [], pits: [] };
      }
    });

    const recentResults = await Promise.all(recentDataPromises);

    for (const { race, overtakes, pits } of recentResults) {
      const rd1 = race.drivers ? race.drivers.find(d => d.name_acronym === dn1) : null;
      const rd2 = race.drivers ? race.drivers.find(d => d.name_acronym === dn2) : null;
      const num1 = rd1 ? rd1.driver_number : null;
      const num2 = rd2 ? rd2.driver_number : null;

      if (num1) {
        overtakesMade1 += overtakes.filter(o => o.overtaking_driver_number === num1).length;
        for (const p of pits.filter(p => p.driver_number === num1)) {
          if (p.pit_duration) { pitTotal1 += p.pit_duration; pitCount1++; }
        }
      }
      if (num2) {
        overtakesMade2 += overtakes.filter(o => o.overtaking_driver_number === num2).length;
        for (const p of pits.filter(p => p.driver_number === num2)) {
          if (p.pit_duration) { pitTotal2 += p.pit_duration; pitCount2++; }
        }
      }
    }

    const avgPit1 = pitCount1 > 0 ? (pitTotal1 / pitCount1).toFixed(1) + 's' : '—';
    const avgPit2 = pitCount2 > 0 ? (pitTotal2 / pitCount2).toFixed(1) + 's' : '—';

    const stats = [
      { label: 'Race H2H', v1: raceH2H_1, v2: raceH2H_2 },
      { label: 'Total Points', v1: totalPts1, v2: totalPts2 },
      { label: 'Wins', v1: wins1, v2: wins2 },
      { label: 'Podiums', v1: podiums1, v2: podiums2 },
      { label: 'Avg Finish', v1: avgFinish1, v2: avgFinish2, lowerBetter: true },
      { label: 'Best Finish', v1: bestFinish1 < 99 ? `P${bestFinish1}` : '—', v2: bestFinish2 < 99 ? `P${bestFinish2}` : '—', lowerBetter: true, rawV1: bestFinish1, rawV2: bestFinish2 },
      { label: `Overtakes (last ${recentRaces.length})`, v1: overtakesMade1, v2: overtakesMade2 },
      { label: 'Avg Pit Time', v1: avgPit1, v2: avgPit2, lowerBetter: true, rawV1: pitCount1 > 0 ? pitTotal1 / pitCount1 : 999, rawV2: pitCount2 > 0 ? pitTotal2 / pitCount2 : 999 },
    ];

    let html = '';
    for (const stat of stats) {
      const val1 = stat.rawV1 ?? (parseFloat(stat.v1) || 0);
      const val2 = stat.rawV2 ?? (parseFloat(stat.v2) || 0);
      const total = val1 + val2 || 1;
      const pct1 = (val1 / total) * 100;
      const pct2 = (val2 / total) * 100;

      let highlight1 = '', highlight2 = '';
      if (stat.lowerBetter) {
        if (val1 < val2 && val1 > 0 && val1 < 99) highlight1 = 'color:var(--text-primary);font-weight:700;';
        else if (val2 < val1 && val2 > 0 && val2 < 99) highlight2 = 'color:var(--text-primary);font-weight:700;';
      } else {
        if (val1 > val2) highlight1 = 'color:var(--text-primary);font-weight:700;';
        else if (val2 > val1) highlight2 = 'color:var(--text-primary);font-weight:700;';
      }

      let barPct1 = pct1, barPct2 = pct2;
      if (stat.lowerBetter && val1 > 0 && val2 > 0) {
        barPct1 = (val2 / total) * 100;
        barPct2 = (val1 / total) * 100;
      }

      html += `
        <div class="h2h-stat">
          <div class="h2h-stat-header">
            <span class="h2h-stat-values" style="${highlight1}">${stat.v1}</span>
            <span class="h2h-stat-label">${stat.label}</span>
            <span class="h2h-stat-values" style="${highlight2}">${stat.v2}</span>
          </div>
          <div class="h2h-bar-container">
            <div class="h2h-bar-left" style="width:${barPct1}%;background:${c1}"></div>
            <div class="h2h-bar-right" style="width:${barPct2}%;background:${c2}"></div>
          </div>
        </div>
      `;
    }

    container.innerHTML = html;

  } catch (err) {
    console.error('H2H comparison failed:', err);
    container.innerHTML = '<div class="no-data"><div class="no-data-text">Failed to compute comparison</div></div>';
  }
}
