// =============================================
// PITCORNER — Team Profile Modal
// Shows detailed constructor stats and driver contributions
// Uses cached standings data — zero extra API calls
// =============================================

import { getTeamColor, $ } from './utils.js';

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

  // Find all drivers under this team
  const teamDrivers = standings.drivers.filter(d => d.team_name === team.team_name);
  const totalTeamPoints = team.points || 1;
  const teamPos = standings.constructors.findIndex(t => t.team_name === team.team_name) + 1;
  const posClass = teamPos <= 3 ? `p${teamPos}` : '';

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

  // Best result across both drivers
  let bestFinish = '—';
  const allFinishes = teamDrivers.flatMap(d => d.raceResults || []);
  if (allFinishes.length > 0) {
    bestFinish = `P${Math.min(...allFinishes)}`;
  }

  // Double points and podiums
  let doublePointsCount = 0;
  let doublePodiumCount = 0;
  if (teamDrivers.length === 2) {
    const d1 = teamDrivers[0];
    const d2 = teamDrivers[1];
    (standings.raceSessions || []).forEach(r => {
      if (r.session_name !== 'Race') return;
      const r1 = (d1.allResults || []).find(res => res.session_key === r.session_key && !res.isSprint);
      const r2 = (d2.allResults || []).find(res => res.session_key === r.session_key && !res.isSprint);
      if (r1 && r2) {
        if (r1.position <= 10 && r2.position <= 10) doublePointsCount++;
        if (r1.position <= 3 && r2.position <= 3) doublePodiumCount++;
      }
    });
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
          <div class="dm-stat-value">${teamDrivers.reduce((sum, d) => sum + (d.podiums || 0), 0)}</div>
          <div class="dm-stat-label">Podiums</div>
        </div>
      </div>

      <div class="dm-stats-grid" style="grid-template-columns: repeat(4, 1fr);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">${bestFinish}</div>
          <div class="dm-stat-label">Best Finish</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${doublePointsCount}</div>
          <div class="dm-stat-label">Double Pts</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${doublePodiumCount}</div>
          <div class="dm-stat-label">Double Pod</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${teamDrivers.length}</div>
          <div class="dm-stat-label">Drivers</div>
        </div>
      </div>

      ${contributionHtml}
    </div>
  `;

  // Attach close handler
  document.getElementById('dm-close').addEventListener('click', closeModal);

  // Open modal
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    overlay.classList.add('open');
  });
}
