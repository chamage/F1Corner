// =============================================
// PITCORNER — Driver Profile Modal
// Shows detailed stats when clicking a driver
// Uses cached data only — zero extra API calls
// =============================================

import { getTeamColor, getPointsForPosition, getDriverFlagImg, DRIVER_NATIONALITY, formatRoundRanges, $ } from './utils.js';
import { drawSparkline } from './charts.js';

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

  // Close on Escape
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
 * Show the driver profile modal.
 * @param {object} driver - Driver standings data (from cachedStandings.drivers)
 * @param {object} standings - Full cachedStandings object
 * @param {Array} raceSessions - Completed race sessions with meeting info
 */
export function showDriverProfile(driver, standings, raceSessions) {
  ensureOverlay();
  const modal = document.getElementById('driver-modal');
  const teamColor = getTeamColor(driver.team_colour);

  // ── World Champion GP Clinch Banner ──
  const clinchInfo = standings.driverClinchMeeting && standings.driverClinchMeeting.driver_number === driver.driver_number
    ? standings.driverClinchMeeting
    : null;

  let championBannerHtml = '';
  if (clinchInfo) {
    championBannerHtml = `
      <div class="dm-champ-banner" style="background:linear-gradient(135deg, rgba(255, 215, 0, 0.12), rgba(255, 215, 0, 0.03)); border: 1px solid rgba(255, 215, 0, 0.35); border-radius: var(--radius-md); padding: var(--space-md); text-align: center; margin-bottom: var(--space-md); box-shadow: 0 0 15px rgba(255, 215, 0, 0.15); animation: pulse 2s infinite;">
        <div style="font-family:'Outfit',sans-serif; font-weight:800; font-size:1.1rem; color:#ffd700; display:flex; align-items:center; justify-content:center; gap:8px;">
          <i class="fa-solid fa-crown"></i> ${standings.year} WORLD CHAMPION
        </div>
        <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:4px; line-height:1.4;">
          Secured the World Championship title at the <strong style="color:var(--text-primary);">${clinchInfo.circuit_short_name} Grand Prix</strong> (Round ${clinchInfo.round}).
        </div>
      </div>
    `;
  }

  // ── Compute derived stats ──
  const rr = driver.raceResults || [];
  const avgFinish = rr.length > 0
    ? (rr.reduce((a, b) => a + b, 0) / rr.length).toFixed(1)
    : '—';
  const bestFinish = rr.length > 0 ? Math.min(...rr) : '—';
  const worstFinish = rr.length > 0 ? Math.max(...rr) : '—';
  const gpPoints = driver.points - (driver.sprintPoints || 0);
  const pointsPerRace = rr.length > 0
    ? (gpPoints / rr.length).toFixed(1)
    : '—';

  // Points finish rate (percentage of GP races scoring points)
  const pointsFinishes = rr.filter(p => p <= 10).length;
  const pointsRate = rr.length > 0 ? Math.round((pointsFinishes / rr.length) * 100) : 0;

  // Consistency score: based on standard deviation of GP finishes
  let consistencyScore = 0;
  let consistencyLabel = '';
  if (rr.length >= 2) {
    const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
    const variance = rr.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / rr.length;
    const stddev = Math.sqrt(variance);
    consistencyScore = Math.max(0, Math.min(100, Math.round((1 - stddev / 10) * 100)));
    if (consistencyScore >= 85) consistencyLabel = 'Machine-like';
    else if (consistencyScore >= 70) consistencyLabel = 'Very Consistent';
    else if (consistencyScore >= 50) consistencyLabel = 'Consistent';
    else if (consistencyScore >= 30) consistencyLabel = 'Unpredictable';
    else consistencyLabel = 'Wild Card';
  }

  // ── Compute Qualifying derived stats ──
  const q3Count = driver.q3Appearances || 0;
  const qr = driver.qualiResults || [];
  const totalQuali = qr.length;
  const q3Rate = totalQuali > 0 ? Math.round((q3Count / totalQuali) * 100) : 0;
  const avgQuali = totalQuali > 0 ? (qr.reduce((a, b) => a + b, 0) / totalQuali).toFixed(1) : '—';
  const bestQuali = totalQuali > 0 ? Math.min(...qr) : '—';

  // ── Compute Sprint Qualifying derived stats ──
  const sprintQ3Count = driver.sprintQ3Appearances || 0;
  const sqr = driver.sprintQualiResults || [];
  const totalSprintQuali = sqr.length;
  const sprintQ3Rate = totalSprintQuali > 0 ? Math.round((sprintQ3Count / totalSprintQuali) * 100) : 0;
  const avgSprintQuali = totalSprintQuali > 0 ? (sqr.reduce((a, b) => a + b, 0) / totalSprintQuali).toFixed(1) : '—';
  const bestSprintQuali = totalSprintQuali > 0 ? Math.min(...sqr) : '—';

  // ── Compute Sprint derived stats ──
  const sprintRr = driver.sprintResults || [];
  const hasSprints = sprintRr.length > 0;

  const avgSprintFinish = sprintRr.length > 0
    ? (sprintRr.reduce((a, b) => a + b, 0) / sprintRr.length).toFixed(1)
    : '—';
  const bestSprintFinish = sprintRr.length > 0 ? Math.min(...sprintRr) : '—';
  const worstSprintFinish = sprintRr.length > 0 ? Math.max(...sprintRr) : '—';
  const sprintPoints = driver.sprintPoints || 0;
  const pointsPerSprint = sprintRr.length > 0
    ? (sprintPoints / sprintRr.length).toFixed(1)
    : '—';
  const sprintPointsFinishes = sprintRr.filter(p => p <= 8).length;
  const sprintPointsRate = sprintRr.length > 0 ? Math.round((sprintPointsFinishes / sprintRr.length) * 100) : 0;

  let sprintConsistencyScore = 0;
  let sprintConsistencyLabel = '';
  if (sprintRr.length >= 2) {
    const mean = sprintRr.reduce((a, b) => a + b, 0) / sprintRr.length;
    const variance = sprintRr.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / sprintRr.length;
    const stddev = Math.sqrt(variance);
    sprintConsistencyScore = Math.max(0, Math.min(100, Math.round((1 - stddev / 10) * 100)));
    if (sprintConsistencyScore >= 85) sprintConsistencyLabel = 'Machine-like';
    else if (sprintConsistencyScore >= 70) sprintConsistencyLabel = 'Very Consistent';
    else if (sprintConsistencyScore >= 50) sprintConsistencyLabel = 'Consistent';
    else if (sprintConsistencyScore >= 30) sprintConsistencyLabel = 'Unpredictable';
    else sprintConsistencyLabel = 'Wild Card';
  }

  // ── Teammate comparison ──
  const teammate = standings.drivers.find(d =>
    d.team_name === driver.team_name && d.driver_number !== driver.driver_number
  );

  let teammateHtml = '';
  let driverWins = 0, tmWins = 0;
  let sprintDriverWins = 0, sprintTmWins = 0;
  if (teammate) {
    const tmRr = teammate.raceResults || [];

    // GP H2H count
    for (const result of driver.allResults || []) {
      if (result.isSprint) continue;
      const tmResult = (teammate.allResults || []).find(
        r => r.session_key === result.session_key && !r.isSprint
      );
      if (tmResult) {
        if (result.position < tmResult.position) driverWins++;
        else if (tmResult.position < result.position) tmWins++;
      }
    }

    // Sprint H2H count
    if (hasSprints) {
      for (const result of driver.allResults || []) {
        if (!result.isSprint) continue;
        const tmResult = (teammate.allResults || []).find(
          r => r.session_key === result.session_key && r.isSprint
        );
        if (tmResult) {
          if (result.position < tmResult.position) sprintDriverWins++;
          else if (tmResult.position < result.position) sprintTmWins++;
        }
      }
    }

    const rows = [
      { label: 'Race H2H', v1: driverWins, v2: tmWins },
    ];
    if (hasSprints) {
      rows.push({ label: 'Sprint H2H', v1: sprintDriverWins, v2: sprintTmWins });
    }
    rows.push(
      { label: 'Points', v1: driver.points, v2: teammate.points },
      { label: 'Wins', v1: driver.wins, v2: teammate.wins },
      { label: 'Podiums', v1: driver.podiums, v2: teammate.podiums },
      {
        label: 'Avg Finish',
        v1: rr.length > 0 ? (rr.reduce((a, b) => a + b, 0) / rr.length).toFixed(1) : '—',
        v2: tmRr.length > 0 ? (tmRr.reduce((a, b) => a + b, 0) / tmRr.length).toFixed(1) : '—'
      },
    );

    const tmColor = getTeamColor(teammate.team_colour);
    teammateHtml = `
      <div class="dm-section-title">vs Teammate — ${teammate.full_name || teammate.name_acronym}</div>
      ${rows.map(row => {
      const total = (parseFloat(row.v1) || 0) + (parseFloat(row.v2) || 0) || 1;
      const pct1 = ((parseFloat(row.v1) || 0) / total) * 100;
      return `
          <div class="dm-teammate-row">
            <div class="dm-tm-label">${row.label}</div>
            <div class="dm-tm-values">
              <span class="dm-tm-val" style="color:${teamColor}">${row.v1}</span>
            </div>
            <div class="dm-tm-bar">
              <div class="dm-tm-bar-left" style="width:${pct1}%;background:${teamColor}"></div>
              <div class="dm-tm-bar-right" style="width:${100 - pct1}%;background:${tmColor};opacity:0.4"></div>
            </div>
            <div class="dm-tm-values">
              <span class="dm-tm-val" style="color:var(--text-muted)">${row.v2}</span>
            </div>
          </div>
        `;
    }).join('')}
    `;
  }

  // ── Milestones & Achievements ──
  const milestones = [];

  // 0. Championship Leader History
  const leadRounds = standings.driverLeadRounds && standings.driverLeadRounds[driver.driver_number];
  if (leadRounds && leadRounds.length > 0) {
    const roundList = formatRoundRanges(leadRounds);
    milestones.push({
      icon: '<i class="fa-solid fa-crown" style="color: #ffd700;"></i>',
      title: 'Championship Leader',
      desc: `Led the Drivers' World Championship standings for ${leadRounds.length} round${leadRounds.length > 1 ? 's' : ''} (${roundList.toLowerCase()}) this season.`
    });
  }

  // 1. Winner's Circle
  if (driver.wins > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-trophy" style="color: #ffd700;"></i>',
      title: 'Winners Circle',
      desc: `Secured ${driver.wins} Grand Prix victory${driver.wins > 1 ? 'ies' : ''} this season.`
    });
  }

  // 2. Speed Demon (Fastest Laps)
  const fastestLapsCount = (standings.raceSessions || []).filter(r => r.fastest_lap_driver === driver.driver_number).length;
  if (fastestLapsCount > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-bolt" style="color: #ffd000;"></i>',
      title: 'Speed Demon',
      desc: `Set the official fastest lap in ${fastestLapsCount} race${fastestLapsCount > 1 ? 's' : ''} this season.`
    });
  }

  // 3. Teammate Dominator
  if (teammate && driverWins > tmWins) {
    milestones.push({
      icon: '<i class="fa-solid fa-chess-knight" style="color: var(--f1-red);"></i>',
      title: 'Teammate Dominator',
      desc: `Outperformed teammate in Grand Prix races (${driverWins} vs ${tmWins}).`
    });
  }

  // 3b. Sprint Master
  if (driver.sprintWins > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-gauge-high" style="color: var(--f1-red);"></i>',
      title: 'Sprint Master',
      desc: `Claimed P1 in ${driver.sprintWins} Sprint race${driver.sprintWins > 1 ? 's' : ''} this season.`
    });
  }

  // 3c. Sprint Podium Finisher / Regular
  if (driver.sprintPodiums >= 3) {
    milestones.push({
      icon: '<i class="fa-solid fa-angles-up" style="color: #ffd700;"></i>',
      title: 'Sprint Podium Regular',
      desc: `Finished on the podium in ${driver.sprintPodiums} Sprints this season.`
    });
  } else if (driver.sprintPodiums > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-award" style="color: #c0c0c0;"></i>',
      title: 'Sprint Podium Finisher',
      desc: `Finished in the top-3 of a Sprint race ${driver.sprintPodiums} time${driver.sprintPodiums > 1 ? 's' : ''}.`
    });
  }

  // 3d. Sprint Points Machine
  if (hasSprints && sprintPointsRate >= 85) {
    milestones.push({
      icon: '<i class="fa-solid fa-flag" style="color: #39b54a;"></i>',
      title: 'Sprint Points Machine',
      desc: `High-density sprint scorer, finishing in the points in ${sprintPointsRate}% of Sprints.`
    });
  } else if (hasSprints && sprintPointsRate >= 50) {
    milestones.push({
      icon: '<i class="fa-solid fa-flag" style="color: #ffd000;"></i>',
      title: 'Sprint Scorer',
      desc: `Consistently in the sprint points, finishing in the top 8 in ${sprintPointsRate}% of Sprints.`
    });
  }

  // 3e. Sprint Dominator
  if (hasSprints && teammate && sprintDriverWins > sprintTmWins) {
    milestones.push({
      icon: '<i class="fa-solid fa-crown" style="color: var(--f1-red);"></i>',
      title: 'Sprint Dominator',
      desc: `Outperformed teammate in Sprint H2H (${sprintDriverWins} vs ${sprintTmWins}).`
    });
  }

  // 4. Points Machine
  if (pointsRate >= 85) {
    milestones.push({
      icon: '<i class="fa-solid fa-chart-line" style="color: #39b54a;"></i>',
      title: 'Points Machine',
      desc: `High-density scorer, finishing in the points in ${pointsRate}% of GP races.`
    });
  } else if (pointsRate >= 50) {
    milestones.push({
      icon: '<i class="fa-solid fa-bullseye" style="color: #ffd000;"></i>',
      title: 'Regular Scorer',
      desc: `Consistently in the mix, bringing home points in ${pointsRate}% of Grand Prix.`
    });
  }

  // 5. Podium Regular
  if (driver.podiums >= 3) {
    milestones.push({
      icon: '<i class="fa-solid fa-award" style="color: #ffd700;"></i>',
      title: 'Podium Regular',
      desc: `Stood on the GP podium ${driver.podiums} times this season.`
    });
  } else if (driver.podiums > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-medal" style="color: #c0c0c0;"></i>',
      title: 'Podium Finisher',
      desc: `Claimed a GP top-3 podium finish ${driver.podiums} time${driver.podiums > 1 ? 's' : ''}.`
    });
  }

  // 6. Flawless Finisher (No DNFs / Always classified in GP races)
  const completedRacesCount = (standings.raceSessions || []).filter(r => r.session_name === 'Race').length;
  const dnfCount = driver.dnfs || 0;
  if (dnfCount === 0 && rr.length === completedRacesCount) {
    milestones.push({
      icon: '<i class="fa-solid fa-flag-checkered" style="color: #39b54a;"></i>',
      title: 'Iron Man',
      desc: `Finished 100% of all GP races this season (${rr.length}/${completedRacesCount}) with zero retirements.`
    });
  }

  let milestonesHtml = '';
  if (milestones.length > 0) {
    milestonesHtml = `
      <div class="dm-section-title">Season Achievements</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:var(--space-lg);">
        ${milestones.map(m => `
          <div class="dm-milestone-card">
            <div class="dm-milestone-icon">${m.icon}</div>
            <div style="flex:1;">
              <div class="dm-milestone-title">${m.title}</div>
              <div class="dm-milestone-desc">${m.desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // ── Race-by-race results bar chart ──
  // Build per-race labels from allResults
  let raceBarHtml = '';
  const raceOnlyResults = (driver.allResults || []).filter(r => !r.isSprint);

  // Sort chronologically using raceSessions dates to align DNS/ABSENT perfectly
  raceOnlyResults.sort((a, b) => {
    const sA = raceSessions.find(s => s.session_key === a.session_key);
    const sB = raceSessions.find(s => s.session_key === b.session_key);
    if (!sA || !sB) return 0;
    return new Date(sA.date_end) - new Date(sB.date_end);
  });

  if (raceOnlyResults.length > 0) {
    const maxPos = 20; // normalize bar heights against P20
    const barItems = raceOnlyResults.map((r, i) => {
      const session = raceSessions.find(s => s.session_key === r.session_key);
      const label = session ? session.circuit_short_name : `R${i + 1}`;
      const shortLabel = label.length > 4 ? label.substring(0, 3) : label;

      const status = r.status || 'FINISHED';
      if (status === 'ABSENT') return ''; // Skip rendering ABSENT rounds before joining
      const isDNF = status === 'DNF';
      const isDNS = status === 'DNS';
      const isDSQ = status === 'DSQ';

      const heightPct = (isDNS || isDSQ) ? 8
        : isDNF ? 8
          : Math.max(5, ((maxPos - r.position + 1) / maxPos) * 100);

      const barColor = isDNS ? 'rgba(156, 163, 175, 0.2)'
        : isDSQ ? 'rgba(239, 68, 68, 0.6)'
          : isDNF ? 'rgba(239, 68, 68, 0.4)'
            : r.position === 1 ? '#ffd700'
              : r.position <= 3 ? teamColor
                : r.position <= 10 ? teamColor + '99'
                  : 'var(--bg-tertiary)';

      const posText = isDNS ? 'DNS' : isDSQ ? 'DSQ' : isDNF ? 'DNF' : `P${r.position}`;
      const titleText = isDNS ? `${label}: Did Not Start (DNS)`
        : isDSQ ? `${label}: Disqualified (DSQ)`
          : isDNF ? `${label}: Retired (DNF)`
            : `${label}: P${r.position}`;

      const barStyle = isDNS ? 'border: 1px dashed var(--text-muted); border-bottom: none;'
        : isDSQ ? 'border: 1px solid var(--f1-red); background: repeating-linear-gradient(45deg, rgba(239, 68, 68, 0.3), rgba(239, 68, 68, 0.3) 5px, rgba(239, 68, 68, 0.05) 5px, rgba(239, 68, 68, 0.05) 10px); border-bottom: none;'
          : isDNF ? 'border: 1px dashed var(--f1-red); border-bottom: none;'
            : '';

      return `
        <div class="dm-race-bar-wrap" title="${titleText}">
          <div class="dm-race-pos" style="${(isDNF || isDNS || isDSQ) ? 'color: var(--f1-red); font-weight: 700; font-size: 0.65rem;' : ''}">${posText}</div>
          <div class="dm-race-bar" style="height:${heightPct}%;background:${barColor};border-radius:2px 2px 0 0;${barStyle}"></div>
          <div class="dm-race-bar-label">${shortLabel}</div>
        </div>
      `;
    }).join('');

    raceBarHtml = `
      <div class="dm-section-title">Race Results</div>
      <div class="dm-races-chart">${barItems}</div>
    `;
  }

  // ── Sprint-by-sprint results bar chart ──
  let sprintBarHtml = '';
  const sprintOnlyResults = (driver.allResults || []).filter(r => r.isSprint);

  sprintOnlyResults.sort((a, b) => {
    const sA = raceSessions.find(s => s.session_key === a.session_key);
    const sB = raceSessions.find(s => s.session_key === b.session_key);
    if (!sA || !sB) return 0;
    return new Date(sA.date_end) - new Date(sB.date_end);
  });

  if (sprintOnlyResults.length > 0) {
    const maxPos = 20; // normalize bar heights against P20
    const barItems = sprintOnlyResults.map((r, i) => {
      const session = raceSessions.find(s => s.session_key === r.session_key);
      const label = session ? session.circuit_short_name : `S${i + 1}`;
      const shortLabel = label.length > 4 ? label.substring(0, 3) : label;

      const status = r.status || 'FINISHED';
      if (status === 'ABSENT') return '';
      const isDNF = status === 'DNF';
      const isDNS = status === 'DNS';
      const isDSQ = status === 'DSQ';

      const heightPct = (isDNS || isDSQ) ? 8
        : isDNF ? 8
          : Math.max(5, ((maxPos - r.position + 1) / maxPos) * 100);

      const barColor = isDNS ? 'rgba(156, 163, 175, 0.2)'
        : isDSQ ? 'rgba(239, 68, 68, 0.6)'
          : isDNF ? 'rgba(239, 68, 68, 0.4)'
            : r.position === 1 ? '#ffd700'
              : r.position <= 3 ? teamColor
                : r.position <= 8 ? teamColor + '99'
                  : 'var(--bg-tertiary)';

      const posText = isDNS ? 'DNS' : isDSQ ? 'DSQ' : isDNF ? 'DNF' : `P${r.position}`;
      const titleText = isDNS ? `${label}: Did Not Start (DNS)`
        : isDSQ ? `${label}: Disqualified (DSQ)`
          : isDNF ? `${label}: Retired (DNF)`
            : `${label}: P${r.position}`;

      const barStyle = isDNS ? 'border: 1px dashed var(--text-muted); border-bottom: none;'
        : isDSQ ? 'border: 1px solid var(--f1-red); background: repeating-linear-gradient(45deg, rgba(239, 68, 68, 0.3), rgba(239, 68, 68, 0.3) 5px, rgba(239, 68, 68, 0.05) 5px, rgba(239, 68, 68, 0.05) 10px); border-bottom: none;'
          : isDNF ? 'border: 1px dashed var(--f1-red); border-bottom: none;'
            : '';

      return `
        <div class="dm-race-bar-wrap" title="${titleText}">
          <div class="dm-race-pos" style="${(isDNF || isDNS || isDSQ) ? 'color: var(--f1-red); font-weight: 700; font-size: 0.65rem;' : ''}">${posText}</div>
          <div class="dm-race-bar" style="height:${heightPct}%;background:${barColor};border-radius:2px 2px 0 0;${barStyle}"></div>
          <div class="dm-race-bar-label">${shortLabel}</div>
        </div>
      `;
    }).join('');

    sprintBarHtml = `
      <div class="dm-section-title">Sprint Results</div>
      <div class="dm-races-chart">${barItems}</div>
    `;
  }

  // ── Points progression chart ──
  let pointsChartHtml = '';
  if (rr.length > 1) {
    pointsChartHtml = `
      <div class="dm-section-title">Points Progression</div>
      <div class="dm-chart-wrap">
        <canvas class="dm-chart-canvas" id="dm-points-chart"></canvas>
      </div>
    `;
  }

  // ── Consistency gauge ──
  let consistencyHtml = '';
  if (rr.length >= 2) {
    const gaugeColor = consistencyScore >= 70 ? '#39b54a'
      : consistencyScore >= 40 ? '#ffd000'
        : '#ff3333';
    consistencyHtml = `
      <div class="dm-section-title">Consistency</div>
      <div class="dm-consistency-wrap">
        <div class="dm-consistency-label">${consistencyLabel}</div>
        <div class="dm-consistency-bar">
          <div class="dm-consistency-fill" style="width:${consistencyScore}%;background:${gaugeColor}"></div>
        </div>
        <div class="dm-consistency-score" style="color:${gaugeColor}">${consistencyScore}%</div>
      </div>
    `;
  }

  // ── Championship position ──
  const champPos = standings.drivers.findIndex(d => d.driver_number === driver.driver_number) + 1;
  const pointsGap = champPos > 1
    ? standings.drivers[0].points - driver.points
    : 0;

  const nat = DRIVER_NATIONALITY[driver.name_acronym] || { country: 'International' };
  const flagHtml = getDriverFlagImg(driver.name_acronym, 'width:18px;margin-right:2px;');

  // ── Segmented Control tabs HTML ──
  let tabSelectorHtml = '';
  if (hasSprints) {
    tabSelectorHtml = `
      <div class="dm-tabs">
        <button class="dm-tab active" data-tab="gp">Grand Prix</button>
        <button class="dm-tab" data-tab="sprint">Sprint</button>
      </div>
    `;
  }

  const gpContentHtml = `
    <div id="dm-content-gp" class="dm-tab-content active">
      <div class="dm-stats-grid">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${champPos <= 3 ? teamColor : 'var(--text-primary)'}">P${champPos}</div>
          <div class="dm-stat-label">Championship</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${gpPoints}</div>
          <div class="dm-stat-label">GP Points</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${driver.wins}</div>
          <div class="dm-stat-label">GP Wins</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${driver.podiums}</div>
          <div class="dm-stat-label">GP Podiums</div>
        </div>
      </div>

      <div class="dm-stats-grid">
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${avgFinish}</div>
          <div class="dm-stat-label">Avg Finish</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">P${bestFinish}</div>
          <div class="dm-stat-label">Best Finish</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${pointsPerRace}</div>
          <div class="dm-stat-label">Pts/Race</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${pointsRate}%</div>
          <div class="dm-stat-label">Points Rate</div>
        </div>
      </div>

      ${pointsGap > 0 ? `
        <div class="dm-stat-tile" style="margin-bottom:var(--space-md);text-align:center;">
          <div class="dm-stat-value" style="color:var(--f1-red);font-size:1rem;">−${pointsGap} pts</div>
          <div class="dm-stat-label">Gap to Leader</div>
        </div>
      ` : ''}

      <!-- Qualifying Performance stats row -->
      <div style="font-family:'Outfit',sans-serif; font-size:0.75rem; font-weight:800; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; margin: 20px 0 8px 0; display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-stopwatch" style="color:var(--text-muted); width: 12px;"></i> Qualifying Performance
      </div>
      <div class="dm-stats-grid" style="margin-bottom: var(--space-md);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#a855f7">${q3Count} <span style="font-size:0.75rem; font-weight:normal; color:var(--text-muted);">/${totalQuali}</span></div>
          <div class="dm-stat-label">Q3 Reached</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#38bdf8">${q3Rate}%</div>
          <div class="dm-stat-label">Q3 Rate</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${avgQuali}</div>
          <div class="dm-stat-label">Avg Grid Pos</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">P${bestQuali}</div>
          <div class="dm-stat-label">Best Quali</div>
        </div>
      </div>

      ${raceBarHtml}
      ${pointsChartHtml}
      ${consistencyHtml}
    </div>
  `;

  let sprintContentHtml = '';
  if (hasSprints) {
    const sprintGaugeColor = sprintConsistencyScore >= 70 ? '#39b54a'
      : sprintConsistencyScore >= 40 ? '#ffd000'
        : '#ff3333';
    sprintContentHtml = `
      <div id="dm-content-sprint" class="dm-tab-content">
        <div class="dm-stats-grid">
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:var(--text-primary)">${sprintPoints}</div>
            <div class="dm-stat-label">Sprint Points</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${driver.sprintWins || 0}</div>
            <div class="dm-stat-label">Sprint Wins</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${driver.sprintPodiums || 0}</div>
            <div class="dm-stat-label">Sprint Podiums</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:${(driver.sprintDnfs || 0) > 0 ? 'var(--f1-red)' : 'var(--text-primary)'}">${driver.sprintDnfs || 0}</div>
            <div class="dm-stat-label">Sprint DNFs</div>
          </div>
        </div>

        <div class="dm-stats-grid">
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${avgSprintFinish}</div>
            <div class="dm-stat-label">Avg Finish</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#ffd700">P${bestSprintFinish}</div>
            <div class="dm-stat-label">Best Finish</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${pointsPerSprint}</div>
            <div class="dm-stat-label">Pts/Sprint</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${sprintPointsRate}%</div>
            <div class="dm-stat-label">Points Rate</div>
          </div>
        </div>

        <!-- Sprint Qualifying Performance stats row -->
        <div style="font-family:'Outfit',sans-serif; font-size:0.75rem; font-weight:800; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; margin: 20px 0 8px 0; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-stopwatch" style="color:var(--text-muted); width: 12px;"></i> Sprint Qualifying Performance
        </div>
        <div class="dm-stats-grid" style="margin-bottom: var(--space-md);">
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#a855f7">${sprintQ3Count} <span style="font-size:0.75rem; font-weight:normal; color:var(--text-muted);">/${totalSprintQuali}</span></div>
            <div class="dm-stat-label">SQ3 Reached</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#38bdf8">${sprintQ3Rate}%</div>
            <div class="dm-stat-label">SQ3 Rate</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${avgSprintQuali}</div>
            <div class="dm-stat-label">Avg Grid Pos</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#ffd700">P${bestSprintQuali}</div>
            <div class="dm-stat-label">Best Quali</div>
          </div>
        </div>

        ${sprintBarHtml}

        ${sprintRr.length >= 2 ? `
          <div class="dm-section-title">Sprint Consistency</div>
          <div class="dm-consistency-wrap" style="margin-bottom:var(--space-md);">
            <div class="dm-consistency-label">${sprintConsistencyLabel}</div>
            <div class="dm-consistency-bar">
              <div class="dm-consistency-fill" style="width:${sprintConsistencyScore}%;background:${sprintGaugeColor}"></div>
            </div>
            <div class="dm-consistency-score" style="color:${sprintGaugeColor}">${sprintConsistencyScore}%</div>
          </div>
        ` : ''}
      </div>
    `;
  }

  modal.innerHTML = `
    <button class="driver-modal-close" id="dm-close" aria-label="Close">✕</button>
    <div class="dm-header" style="color:${teamColor}">
      <img class="dm-headshot" src="${driver.headshot_url || ''}" alt="${driver.name_acronym}"
           onerror="this.style.display='none'" style="border-color:${teamColor}">
      <div class="dm-header-info">
        <div class="dm-driver-name">${driver.full_name || driver.name_acronym}</div>
        <div class="dm-driver-team" style="color:${teamColor};font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${driver.team_name}</div>
        <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:4px;display:flex;align-items:center;gap:6px;">
          ${flagHtml}
          <span>${nat.country}</span>
        </div>
      </div>
      <div class="dm-driver-number">${driver.driver_number}</div>
    </div>

    <div class="dm-body">
      ${championBannerHtml}
      ${tabSelectorHtml}
      ${gpContentHtml}
      ${sprintContentHtml}
      ${milestonesHtml}
      ${teammateHtml}
    </div>
  `;

  // Attach close handler
  document.getElementById('dm-close').addEventListener('click', closeModal);

  // Attach tab switching handlers
  if (hasSprints) {
    const tabs = modal.querySelectorAll('.dm-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const activeTab = tab.getAttribute('data-tab');
        const gpContent = modal.querySelector('#dm-content-gp');
        const sprintContent = modal.querySelector('#dm-content-sprint');

        if (activeTab === 'gp') {
          gpContent.classList.add('active');
          sprintContent.classList.remove('active');
        } else {
          sprintContent.classList.add('active');
          gpContent.classList.remove('active');
        }
      });
    });
  }

  // Open modal
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    overlay.classList.add('open');
  });

  // Draw points progression sparkline
  if (rr.length > 1) {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('dm-points-chart');
      if (canvas) {
        // Cumulative points
        let cumulative = [];
        let sum = 0;
        for (const pos of rr) {
          sum += getPointsForPosition(pos);
          cumulative.push(sum);
        }
        drawSparkline(canvas, cumulative, teamColor, true);
      }
    });
  }
}
