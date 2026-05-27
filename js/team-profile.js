// =============================================
// PITCORNER — Team Profile Modal
// Shows detailed constructor stats and driver contributions
// Uses cached standings data — zero extra API calls
// =============================================

import { getTeamColor, formatRoundRanges, $ } from './utils.js';
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

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
    });
  }
  return overlay;
}

function closeModal() {
  if (overlay) {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
}

/**
 * Show the team profile modal
 * @param {object} team - Constructor standings object
 * @param {object} standings - Full standings object
 */
export function showTeamProfile(team, standings) {
  const overlay = ensureOverlay();
  const modal = document.getElementById('driver-modal');
  const teamColor = getTeamColor(team.team_colour);

  // ── World Champion GP Clinch Banner ──
  const clinchInfo = standings.constructorClinchMeeting && standings.constructorClinchMeeting.team_name === team.team_name
    ? standings.constructorClinchMeeting
    : null;

  let championBannerHtml = '';
  if (clinchInfo) {
    championBannerHtml = `
      <div class="dm-champ-banner" style="background:linear-gradient(135deg, rgba(255, 215, 0, 0.12), rgba(255, 215, 0, 0.03)); border: 1px solid rgba(255, 215, 0, 0.35); border-radius: var(--radius-md); padding: var(--space-md); text-align: center; margin-bottom: var(--space-md); box-shadow: 0 0 15px rgba(255, 215, 0, 0.15); animation: pulse 2s infinite;">
        <div style="font-family:'Outfit',sans-serif; font-weight:800; font-size:1.1rem; color:#ffd700; display:flex; align-items:center; justify-content:center; gap:8px;">
          <i class="fa-solid fa-trophy"></i> ${standings.year} WORLD CONSTRUCTOR CHAMPION
        </div>
        <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:4px; line-height:1.4;">
          Secured the World Constructor Championship title at the <strong style="color:var(--text-primary);">${clinchInfo.circuit_short_name} Grand Prix</strong> (Round ${clinchInfo.round}).
        </div>
      </div>
    `;
  }

  // Find all drivers under this team
  const teamDrivers = standings.drivers.filter(d => d.team_name === team.team_name);
  const totalTeamPoints = team.points || 1;
  const teamPos = standings.constructors.findIndex(t => t.team_name === team.team_name) + 1;

  // Render driver contributions html
  let contributionHtml = '';
  if (teamDrivers.length > 0) {
    contributionHtml = `
      <div class="dm-section-title">Driver Lineup & Contributions</div>
      <div style="display:flex;flex-direction:column;gap:var(--space-md);margin-bottom:var(--space-xl);">
        ${teamDrivers.map((d, idx) => {
      const pct = Math.round((d.points / totalTeamPoints) * 100) || 0;
      return `
            <div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:var(--space-md);display:flex;align-items:center;gap:var(--space-md);position:relative;">
              <img src="${d.headshot_url || ''}" alt="${d.name_acronym}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;background:var(--bg-tertiary);border:2px solid ${teamColor};" onerror="this.style.display='none'">
              <div style="flex:1;min-width:0;">
                <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:0.95rem;">${d.full_name || d.name_acronym}</div>
                <div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">Points: <strong>${d.points}</strong> • Wins: <strong>${d.wins}</strong> • Podiums: <strong>${d.podiums}</strong></div>
                <div style="display:flex;align-items:center;gap:var(--space-sm);margin-top:var(--space-sm);">
                  <div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${teamColor};border-radius:3px;opacity:${idx === 0 ? 1 : 0.6}"></div>
                  </div>
                  <span style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-secondary);font-weight:600;">${pct}%</span>
                </div>
              </div>
            </div>
          `;
    }).join('')}
      </div>
    `;
  }

  // Best finish across all drivers
  let bestFinish = '—';
  const allFinishes = teamDrivers.flatMap(d => d.raceResults || []);
  if (allFinishes.length > 0) {
    bestFinish = `P${Math.min(...allFinishes)}`;
  }

  // DNFs & Reliability
  const totalStarts = teamDrivers.reduce((sum, d) => sum + (d.raceResults || []).length, 0);
  const totalDnfs = teamDrivers.reduce((sum, d) => sum + (d.dnfs || 0), 0);
  const reliabilityRate = totalStarts > 0 ? Math.round((1 - totalDnfs / totalStarts) * 100) : 100;

  // Double points and double podiums
  let doublePointsCount = 0;
  let doublePodiumCount = 0;
  if (teamDrivers.length >= 2) {
    const d1 = teamDrivers[0];
    const d2 = teamDrivers[1];
    (standings.raceSessions || []).forEach(r => {
      if (r.session_name !== 'Race') return;
      const r1 = (d1.allResults || []).find(res => res.session_key === r.session_key && !res.isSprint);
      const r2 = (d2.allResults || []).find(res => res.session_key === r.session_key && !res.isSprint);
      if (r1 && r2) {
        if (r1.position <= 10 && r2.position <= 10 && r1.status === 'FINISHED' && r2.status === 'FINISHED') doublePointsCount++;
        if (r1.position <= 3 && r2.position <= 3 && r1.status === 'FINISHED' && r2.status === 'FINISHED') doublePodiumCount++;
      }
    });
  }

  // Constructor Points Progression History
  const roundCount = (standings.raceSessions || []).filter(r => r.session_name === 'Race').length;
  const teamPointsHistory = [];
  if (roundCount > 0) {
    for (let rIdx = 0; rIdx < roundCount; rIdx++) {
      let cumulativeSum = 0;
      for (const d of teamDrivers) {
        const history = d.pointsHistory || [];
        if (history.length > rIdx) {
          cumulativeSum += history[rIdx];
        } else if (history.length > 0) {
          cumulativeSum += history[history.length - 1];
        }
      }
      teamPointsHistory.push(cumulativeSum);
    }
  }

  // Teammate Driver Duel (H2H finish battle)
  let duelHtml = '';
  if (teamDrivers.length >= 2) {
    const d1 = teamDrivers[0];
    const d2 = teamDrivers[1];

    let wins1 = 0, wins2 = 0;
    let sprintWins1 = 0, sprintWins2 = 0;

    // GP H2H count
    for (const result of d1.allResults || []) {
      if (result.isSprint) continue;
      const tmResult = (d2.allResults || []).find(
        r => r.session_key === result.session_key && !r.isSprint
      );
      if (tmResult) {
        if (result.position < tmResult.position) wins1++;
        else if (tmResult.position < result.position) wins2++;
      }
    }

    // Sprint H2H count
    for (const result of d1.allResults || []) {
      if (!result.isSprint) continue;
      const tmResult = (d2.allResults || []).find(
        r => r.session_key === result.session_key && r.isSprint
      );
      if (tmResult) {
        if (result.position < tmResult.position) sprintWins1++;
        else if (tmResult.position < result.position) sprintWins2++;
      }
    }

    const hasSprints = (d1.sprintResults || []).length > 0 || (d2.sprintResults || []).length > 0;
    const gpTotal = wins1 + wins2 || 1;
    const gpPct1 = Math.round((wins1 / gpTotal) * 100);
    const gpPct2 = 100 - gpPct1;

    const ptsTotal = (d1.points + d2.points) || 1;
    const ptsPct1 = Math.round((d1.points / ptsTotal) * 100);
    const ptsPct2 = 100 - ptsPct1;

    let sprintDuelBarHtml = '';
    if (hasSprints) {
      const sprintTotal = sprintWins1 + sprintWins2 || 1;
      const sprintPct1 = Math.round((sprintWins1 / sprintTotal) * 100);
      const sprintPct2 = 100 - sprintPct1;

      sprintDuelBarHtml = `
        <div class="dm-duel-row">
          <div class="dm-duel-label">Sprint H2H</div>
          <div class="dm-duel-values">
            <span style="color:${teamColor};font-weight:700;">${sprintWins1}</span>
            <span>vs</span>
            <span style="color:var(--text-secondary);font-weight:600;">${sprintWins2}</span>
          </div>
          <div class="dm-duel-bar-wrap">
            <div class="dm-duel-bar-left" style="width:${sprintPct1}%;background:${teamColor};"></div>
            <div class="dm-duel-bar-right" style="width:${sprintPct2}%;background:${teamColor};opacity:0.4;"></div>
          </div>
        </div>
      `;
    }

    duelHtml = `
      <div class="dm-section-title">Teammate Duel — Head-to-Head</div>
      <div class="dm-duel-card">
        <div class="dm-duel-header">
          <div class="dm-duel-driver">
            <img src="${d1.headshot_url || ''}" alt="${d1.name_acronym}" class="dm-duel-img" style="border-color:${teamColor};" onerror="this.style.display='none'">
            <div class="dm-duel-name" style="color:${teamColor};">${d1.name_acronym}</div>
          </div>
          <div class="dm-duel-vs">VS</div>
          <div class="dm-duel-driver">
            <img src="${d2.headshot_url || ''}" alt="${d2.name_acronym}" class="dm-duel-img" style="border-color:var(--text-muted);" onerror="this.style.display='none'">
            <div class="dm-duel-name" style="color:var(--text-secondary);">${d2.name_acronym}</div>
          </div>
        </div>
        
        <div class="dm-duel-body">
          <div class="dm-duel-row">
            <div class="dm-duel-label">Race H2H</div>
            <div class="dm-duel-values">
              <span style="color:${teamColor};font-weight:700;">${wins1}</span>
              <span>vs</span>
              <span style="color:var(--text-secondary);font-weight:600;">${wins2}</span>
            </div>
            <div class="dm-duel-bar-wrap">
              <div class="dm-duel-bar-left" style="width:${gpPct1}%;background:${teamColor};"></div>
              <div class="dm-duel-bar-right" style="width:${gpPct2}%;background:${teamColor};opacity:0.4;"></div>
            </div>
          </div>

          ${sprintDuelBarHtml}

          <div class="dm-duel-row">
            <div class="dm-duel-label">Points Share</div>
            <div class="dm-duel-values">
              <span style="color:${teamColor};font-weight:700;">${d1.points}</span>
              <span>vs</span>
              <span style="color:var(--text-secondary);font-weight:600;">${d2.points}</span>
            </div>
            <div class="dm-duel-bar-wrap">
              <div class="dm-duel-bar-left" style="width:${ptsPct1}%;background:${teamColor};"></div>
              <div class="dm-duel-bar-right" style="width:${ptsPct2}%;background:${teamColor};opacity:0.4;"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Constructor Achievements (Constructor Milestones)
  const milestones = [];

  // 1. Championship Leaders
  const leadRounds = standings.constructorLeadRounds && standings.constructorLeadRounds[team.team_name];
  if (leadRounds && leadRounds.length > 0) {
    const roundList = formatRoundRanges(leadRounds);
    milestones.push({
      icon: '<i class="fa-solid fa-crown" style="color: #ffd700;"></i>',
      title: 'Championship Leaders',
      desc: `Led the Constructors' World Championship standings for ${leadRounds.length} round${leadRounds.length > 1 ? 's' : ''} (${roundList.toLowerCase()}) this season.`
    });
  }

  // 2. Dominant Force (GP wins count)
  if (team.wins >= 5) {
    milestones.push({
      icon: '<i class="fa-solid fa-trophy" style="color: #ffd700;"></i>',
      title: 'Dominant Force',
      desc: `Secured ${team.wins} Grand Prix victories this season.`
    });
  } else if (team.wins > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-medal" style="color: #c0c0c0;"></i>',
      title: 'Race Winners',
      desc: `Claimed P1 finishing orders in ${team.wins} races this season.`
    });
  }

  // 3. Podium Hogs (Podium count)
  const totalPodiums = teamDrivers.reduce((sum, d) => sum + (d.podiums || 0), 0);
  if (totalPodiums >= 10) {
    milestones.push({
      icon: '<i class="fa-solid fa-award" style="color: #ffd000;"></i>',
      title: 'Podium Hogs',
      desc: `Stood on the podium ${totalPodiums} times this season across both drivers.`
    });
  } else if (totalPodiums > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-angles-up" style="color: #c0c0c0;"></i>',
      title: 'Podium Regulars',
      desc: `Stood on the podium ${totalPodiums} time${totalPodiums > 1 ? 's' : ''} this season.`
    });
  }

  // 4. Bulletproof Reliability
  if (reliabilityRate >= 90 && totalStarts >= 6) {
    milestones.push({
      icon: '<i class="fa-solid fa-shield-halved" style="color: #39b54a;"></i>',
      title: 'Bulletproof Reliability',
      desc: `High reliability score of ${reliabilityRate}%, finishing almost all race starts.`
    });
  }

  // 5. Double Points Machine
  if (doublePointsCount >= 5) {
    milestones.push({
      icon: '<i class="fa-solid fa-chart-line" style="color: #39b54a;"></i>',
      title: 'Double Points Machine',
      desc: `Brought home double points finishes in ${doublePointsCount} GP races.`
    });
  }

  let milestonesHtml = '';
  if (milestones.length > 0) {
    milestonesHtml = `
      <div class="dm-section-title">Constructor Achievements</div>
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

  // Points progression chart section
  let pointsChartHtml = '';
  if (teamPointsHistory.length > 1) {
    pointsChartHtml = `
      <div class="dm-section-title">Points Progression</div>
      <div class="dm-chart-wrap">
        <canvas class="dm-chart-canvas" id="dm-points-chart"></canvas>
      </div>
    `;
  }

  modal.innerHTML = `
    <button class="driver-modal-close" id="dm-close" aria-label="Close">✕</button>
    
    <div class="dm-header" style="color:${teamColor}">
      <div class="team-color-bar" style="background:${teamColor};width:6px;height:48px;border-radius:3px;margin-right:var(--space-md);"></div>
      <div class="dm-header-info">
        <div class="dm-driver-name">${team.team_name}</div>
        <div class="dm-driver-team" style="color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">F1 Constructor</div>
      </div>
      <div class="dm-driver-number" style="font-size:1.8rem;top:28px;">${team.team_name.substring(0, 3).toUpperCase()}</div>
    </div>

    <div class="dm-body">
      ${championBannerHtml}
      <div class="dm-stats-grid">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${teamPos <= 3 ? teamColor : 'var(--text-primary)'}">P${teamPos}</div>
          <div class="dm-stat-label">Standings</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${team.points}</div>
          <div class="dm-stat-label">Total Points</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${team.wins}</div>
          <div class="dm-stat-label">GP Wins</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${totalPodiums}</div>
          <div class="dm-stat-label">Podiums</div>
        </div>
      </div>

      <div class="dm-stats-grid" style="grid-template-columns: repeat(4, 1fr);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">${bestFinish}</div>
          <div class="dm-stat-label">Best Finish</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${reliabilityRate >= 90 ? '#39b54a' : reliabilityRate >= 65 ? '#ffd000' : '#ff3333'}">${reliabilityRate}%</div>
          <div class="dm-stat-label">Reliability</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${doublePointsCount}</div>
          <div class="dm-stat-label">Double Pts</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${doublePodiumCount}</div>
          <div class="dm-stat-label">Double Pod</div>
        </div>
      </div>

      ${pointsChartHtml}
      ${duelHtml}
      ${contributionHtml}
      ${milestonesHtml}
    </div>
  `;

  // Attach close handler
  document.getElementById('dm-close').addEventListener('click', closeModal);

  // Open modal
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    overlay.classList.add('open');
  });

  // Draw team points progression sparkline
  if (teamPointsHistory.length > 1) {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('dm-points-chart');
      if (canvas) {
        drawSparkline(canvas, teamPointsHistory, teamColor, true);
      }
    });
  }
}
