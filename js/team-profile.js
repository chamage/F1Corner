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
  }

  if (!overlay.dataset.boundClose) {
    overlay.dataset.boundClose = 'true';
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

  // Build exact per-team driver entries (handles mid-season driver swaps accurately)
  const driverByAcronym = new Map((standings.drivers || []).map(d => [d.name_acronym, d]));
  const rosterNames = (team.drivers && team.drivers.length > 0)
    ? team.drivers.map(td => td.name)
    : (standings.drivers || []).filter(d => d.team_name === team.team_name).map(d => d.name_acronym);

  const teamDrivers = rosterNames.map(acronym => {
    const fullDriver = driverByAcronym.get(acronym) || { name_acronym: acronym, full_name: acronym, headshot_url: '', allResults: [] };
    const tdEntry = (team.drivers || []).find(td => td.name === acronym);
    const teamResults = (fullDriver.allResults || []).filter(r => r.team_name === team.team_name && r.status !== 'ABSENT');
    const teamGpResults = teamResults.filter(r => !r.isSprint);
    const teamSprintResults = teamResults.filter(r => r.isSprint);

    const teamWins = teamGpResults.filter(r => r.position === 1 && r.status === 'FINISHED').length;
    const teamPodiums = teamGpResults.filter(r => r.position <= 3 && r.status === 'FINISHED').length;
    const teamDnfs = teamGpResults.filter(r => r.status === 'DNF').length;
    const teamClassifiedPositions = teamGpResults
      .filter(r => r.status === 'FINISHED' || r.status === 'DNF')
      .map(r => r.position);
    const teamPts = tdEntry ? tdEntry.points : fullDriver.points;

    return {
      ...fullDriver,
      teamPoints: Math.round(((teamPts || 0) + Number.EPSILON) * 100) / 100,
      teamWins,
      teamPodiums,
      teamDnfs,
      teamGpCount: teamGpResults.length,
      teamRaceResults: teamClassifiedPositions,
      teamSprintCount: teamSprintResults.length,
      teamAllResults: teamResults
    };
  }).sort((a, b) => (b.teamPoints - a.teamPoints) || (b.teamGpCount - a.teamGpCount));

  const totalTeamPoints = team.points || 1;
  const teamPos = standings.constructors.findIndex(t => t.team_name === team.team_name) + 1;

  // ── Mathematical Constructor Championship Outlook ──
  let championshipOutlookHtml = '';
  const maxRemConstPts = standings.maxRemainingConstructorPoints || 0;
  if (!standings.isFinished && !standings.isPreliminary && maxRemConstPts > 0 && teamPos > 0) {
    const bestPos = team.bestPos ?? teamPos;
    const worstPos = team.worstPos ?? teamPos;
    const maxPossiblePts = team.maxPossiblePoints ?? Math.round(((team.points + maxRemConstPts) + Number.EPSILON) * 100) / 100;
    const canGain = Math.max(0, teamPos - bestPos);
    const canLose = Math.max(0, worstPos - teamPos);
    const totalTeams = Math.max(standings.constructors.length, 2);

    const startPct = ((bestPos - 1) / (totalTeams - 1)) * 100;
    const endPct = ((worstPos - 1) / (totalTeams - 1)) * 100;
    const currPct = ((teamPos - 1) / (totalTeams - 1)) * 100;
    const spanWidthPct = Math.max(3, endPct - startPct);

    const remGPs = standings.remainingGPs || 0;
    const remSprints = standings.remainingSprints || 0;
    const evParts = [];
    if (remGPs > 0) evParts.push(`${remGPs} GP${remGPs !== 1 ? 's' : ''}`);
    if (remSprints > 0) evParts.push(`${remSprints} Sprint${remSprints !== 1 ? 's' : ''}`);
    const sc = standings.scoringInfo || {};
    const ruleNotes = [];
    if (remGPs > 0) ruleNotes.push(`${sc.maxConstructorPointsPerGP || 43}/GP 1-2${sc.awardFastestLap ? ' incl. FL' : ''}`);
    if (remSprints > 0 && (sc.maxConstructorSprintPoints || 0) > 0) ruleNotes.push(`${sc.maxConstructorSprintPoints}/Sprint`);
    if (sc.doublePointsFinal) ruleNotes.push('2× Finale');

    let statusTagHtml = '';
    if (bestPos === 1 && worstPos === 1) {
      statusTagHtml = `<span class="outlook-status-tag clinched"><i class="fa-solid fa-trophy"></i> Title Clinched</span>`;
    } else if (bestPos === worstPos) {
      statusTagHtml = `<span class="outlook-status-tag locked"><i class="fa-solid fa-lock"></i> Locked at P${bestPos}</span>`;
    } else if (bestPos === 1) {
      statusTagHtml = `<span class="outlook-status-tag contender"><i class="fa-solid fa-trophy"></i> In Title Contention</span>`;
    } else {
      statusTagHtml = `<span class="outlook-status-tag neutral">Ceiling: P${bestPos}</span>`;
    }

    const rivalItems = [];
    if (canGain > 0 && teamPos > 1) {
      const nextAhead = standings.constructors[teamPos - 2];
      if (nextAhead) {
        const gapAhead = Math.round(((nextAhead.points - team.points) + Number.EPSILON) * 100) / 100;
        rivalItems.push(`<div class="outlook-rival-row"><span class="outlook-rival-label"><i class="fa-solid fa-arrow-up" style="color:#2ecc71;"></i> Next ahead:</span> <span class="outlook-rival-val"><strong>P${teamPos - 1} ${nextAhead.team_name}</strong> (${gapAhead === 0 ? 'tied' : `+${gapAhead} pts`})</span></div>`);
      }
      if (bestPos < teamPos - 1) {
        const topTarget = standings.constructors[bestPos - 1];
        if (topTarget) {
          const gapTop = Math.round(((topTarget.points - team.points) + Number.EPSILON) * 100) / 100;
          rivalItems.push(`<div class="outlook-rival-row"><span class="outlook-rival-label"><i class="fa-solid fa-bullseye" style="color:#ffd700;"></i> Highest reach:</span> <span class="outlook-rival-val"><strong>P${bestPos} ${topTarget.team_name}</strong> (+${gapTop} pts)</span></div>`);
        }
      }
    }

    if (canLose > 0 && teamPos < standings.constructors.length) {
      const threats = [];
      for (let k = teamPos; k < standings.constructors.length; k++) {
        const ch = standings.constructors[k];
        const chMax = ch.maxPossiblePoints ?? (ch.points + maxRemConstPts);
        if (chMax >= team.points) {
          const gapBehind = Math.round(((team.points - ch.points) + Number.EPSILON) * 100) / 100;
          threats.push({ pos: k + 1, name: ch.team_name, gap: gapBehind });
        }
      }
      if (threats.length > 0) {
        const preview = threats.slice(0, 3)
          .map(t => `<strong>P${t.pos} ${t.name}</strong> (${t.gap === 0 ? 'tied' : `−${t.gap} pts`})`)
          .join(', ');
        const more = threats.length > 3 ? ` +${threats.length - 3} more` : '';
        rivalItems.push(`<div class="outlook-rival-row"><span class="outlook-rival-label"><i class="fa-solid fa-triangle-exclamation" style="color:#f87171;"></i> Chasers in range:</span> <span class="outlook-rival-val">${preview}${more}</span></div>`);
      }
    }

    const rangeLabel = bestPos === worstPos ? `P${bestPos}` : `P${bestPos} – P${worstPos}`;
    const rangeAccent = bestPos === 1 ? '#ffd700' : teamColor;

    championshipOutlookHtml = `
      <div class="champ-outlook-card">
        <div class="champ-outlook-header">
          <div class="champ-outlook-title">
            <i class="fa-solid fa-calculator" style="color:${rangeAccent};"></i>
            <span>Possible Championship Finish</span>
          </div>
          ${statusTagHtml}
        </div>

        <div class="champ-outlook-main">
          <div class="champ-outlook-kpi">
            <div class="champ-outlook-range" style="color:${rangeAccent};">${rangeLabel}</div>
            <div class="champ-outlook-sub">
              ${bestPos === worstPos
                ? 'Position mathematically locked'
                : `${canGain > 0 ? `<span class="delta-up">↑ Gain up to ${canGain}</span>` : '<span class="delta-muted">No gain ahead</span>'} · ${canLose > 0 ? `<span class="delta-down">↓ Lose up to ${canLose}</span>` : '<span class="delta-muted">Safe from behind</span>'}`
              }
            </div>
          </div>
          <div class="champ-outlook-pts-box">
            <div class="champ-outlook-pts-ceil">${team.points} <span style="color:var(--text-muted);font-weight:500;">→</span> <strong>${maxPossiblePts}</strong> <span style="font-size:0.72rem;color:var(--text-muted);">pts max</span></div>
            <div class="champ-outlook-pts-meta">${evParts.join(' + ')} left · +${maxRemConstPts} max (${ruleNotes.join(' · ')})</div>
          </div>
        </div>

        <div class="champ-outlook-spectrum">
          <span class="spectrum-bound">P1</span>
          <div class="spectrum-track">
            <div class="spectrum-fill" style="left:${startPct}%;width:${spanWidthPct}%;background:${rangeAccent};"></div>
            <div class="spectrum-marker" style="left:${currPct}%;border-color:${rangeAccent};" title="Current Position: P${teamPos}"></div>
          </div>
          <span class="spectrum-bound">P${totalTeams}</span>
        </div>

        ${rivalItems.length > 0 ? `<div class="champ-outlook-rivals">${rivalItems.join('')}</div>` : ''}
      </div>
    `;
  }

  // Render driver contributions html
  let contributionHtml = '';
  if (teamDrivers.length > 0) {
    contributionHtml = `
      <div class="dm-section-title">Driver Lineup & Contributions</div>
      <div style="display:flex;flex-direction:column;gap:var(--space-md);margin-bottom:var(--space-xl);">
        ${teamDrivers.map((d, idx) => {
      const pct = team.points > 0 ? Math.min(100, Math.round((d.teamPoints / totalTeamPoints) * 100)) : 0;
      return `
            <div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:var(--space-md);display:flex;align-items:center;gap:var(--space-md);position:relative;">
              <img src="${d.headshot_url || ''}" alt="${d.name_acronym}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;background:var(--bg-tertiary);border:2px solid ${teamColor};" onerror="this.style.display='none'">
              <div style="flex:1;min-width:0;">
                <div style="font-family:'Outfit',sans-serif;font-weight:700;font-size:0.95rem;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                  <span>${d.full_name || d.name_acronym}</span>
                  <span class="dm-stint-pill">${d.teamGpCount} GP${d.teamGpCount !== 1 ? 's' : ''}${d.teamSprintCount > 0 ? ` · ${d.teamSprintCount} Spr` : ''}</span>
                </div>
                <div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">Points: <strong>${d.teamPoints}</strong> • Wins: <strong>${d.teamWins}</strong> • Podiums: <strong>${d.teamPodiums}</strong></div>
                <div style="display:flex;align-items:center;gap:var(--space-sm);margin-top:var(--space-sm);">
                  <div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${teamColor};border-radius:3px;opacity:${idx === 0 ? 1 : (idx === 1 ? 0.65 : 0.45)}"></div>
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

  // Best finish across all drivers for this team
  let bestFinish = '—';
  const allFinishes = teamDrivers.flatMap(d => d.teamRaceResults || []);
  if (allFinishes.length > 0) {
    bestFinish = `P${Math.min(...allFinishes)}`;
  }

  // DNFs & Reliability for this team
  const totalStarts = teamDrivers.reduce((sum, d) => sum + (d.teamRaceResults || []).length, 0);
  const totalDnfs = teamDrivers.reduce((sum, d) => sum + (d.teamDnfs || 0), 0);
  const reliabilityRate = totalStarts > 0 ? Math.round((1 - totalDnfs / totalStarts) * 100) : 100;

  // Double points and double podiums across any cars entered by this constructor in each GP
  let doublePointsCount = 0;
  let doublePodiumCount = 0;
  (standings.raceSessions || []).forEach(r => {
    if (r.session_name !== 'Race') return;
    const teamResultsInRace = teamDrivers
      .map(d => (d.teamAllResults || []).find(res => res.session_key === r.session_key && !res.isSprint))
      .filter(Boolean);
    const pointsFinishers = teamResultsInRace.filter(res => res.position <= 10 && res.status === 'FINISHED').length;
    const podiumFinishers = teamResultsInRace.filter(res => res.position <= 3 && res.status === 'FINISHED').length;
    if (pointsFinishers >= 2) doublePointsCount++;
    if (podiumFinishers >= 2) doublePodiumCount++;
  });

  // Constructor Points Progression History (uses exact per-meeting team history)
  const teamPointsHistory = (team.pointsHistory && team.pointsHistory.length > 0)
    ? team.pointsHistory
    : [];

  // Teammate Driver Duel — pair drivers who actually competed together for this constructor
  // (prevents 0-0 H2H bugs when a team had 3+ drivers due to mid-season swaps or stand-ins)
  let duelHtml = '';
  if (teamDrivers.length >= 2) {
    const roundPts = (val) => Math.round(((Number(val) || 0) + Number.EPSILON) * 100) / 100;
    const activePairings = [];

    for (let i = 0; i < teamDrivers.length; i++) {
      for (let j = i + 1; j < teamDrivers.length; j++) {
        const d1 = teamDrivers[i];
        const d2 = teamDrivers[j];
        let sharedGPs = 0;
        let sharedSprints = 0;
        let wins1 = 0, wins2 = 0;
        let sprintWins1 = 0, sprintWins2 = 0;
        let sharedPts1 = 0, sharedPts2 = 0;

        for (const result of (d1.teamAllResults || [])) {
          const tmResult = (d2.teamAllResults || []).find(
            r => r.session_key === result.session_key && r.isSprint === result.isSprint
          );
          if (!tmResult) continue;

          sharedPts1 = roundPts(sharedPts1 + (result.points || 0));
          sharedPts2 = roundPts(sharedPts2 + (tmResult.points || 0));

          if (result.isSprint) {
            sharedSprints++;
            if (!(result.status === 'DNS' && tmResult.status === 'DNS')) {
              if (result.position < tmResult.position) sprintWins1++;
              else if (tmResult.position < result.position) sprintWins2++;
            }
          } else {
            sharedGPs++;
            if (!(result.status === 'DNS' && tmResult.status === 'DNS')) {
              if (result.position < tmResult.position) wins1++;
              else if (tmResult.position < result.position) wins2++;
            }
          }
        }

        if (sharedGPs > 0 || sharedSprints > 0) {
          activePairings.push({
            d1,
            d2,
            sharedGPs,
            sharedSprints,
            wins1,
            wins2,
            sprintWins1,
            sprintWins2,
            sharedPts1,
            sharedPts2
          });
        }
      }
    }

    activePairings.sort((a, b) => (b.sharedGPs - a.sharedGPs) || (b.sharedSprints - a.sharedSprints) || ((b.sharedPts1 + b.sharedPts2) - (a.sharedPts1 + a.sharedPts2)));

    if (activePairings.length > 0) {
      const hasMultiPairings = activePairings.length > 1 || teamDrivers.length > 2;
      const cardsHtml = activePairings.map(pair => {
        const { d1, d2, sharedGPs, wins1, wins2, sprintWins1, sprintWins2 } = pair;
        const pts1 = hasMultiPairings ? pair.sharedPts1 : d1.teamPoints;
        const pts2 = hasMultiPairings ? pair.sharedPts2 : d2.teamPoints;
        const ptsLabel = hasMultiPairings ? 'Shared Pts' : 'Points Share';

        const hasSprints = (sprintWins1 + sprintWins2) > 0;
        const gpTotal = wins1 + wins2 || 1;
        const gpPct1 = (wins1 + wins2) > 0 ? Math.round((wins1 / gpTotal) * 100) : 50;
        const gpPct2 = 100 - gpPct1;

        const ptsTotal = (pts1 + pts2) || 1;
        const ptsPct1 = (pts1 + pts2) > 0 ? Math.round((pts1 / ptsTotal) * 100) : 50;
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

        return `
          <div class="dm-duel-card">
            <div class="dm-duel-header">
              <div class="dm-duel-driver">
                <img src="${d1.headshot_url || ''}" alt="${d1.name_acronym}" class="dm-duel-img" style="border-color:${teamColor};" onerror="this.style.display='none'">
                <div class="dm-duel-name" style="color:${teamColor};">${d1.name_acronym}</div>
              </div>
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <div class="dm-duel-vs">VS</div>
                <span class="dm-stint-pill">${sharedGPs} Shared GP${sharedGPs !== 1 ? 's' : ''}</span>
              </div>
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
                <div class="dm-duel-label">${ptsLabel}</div>
                <div class="dm-duel-values">
                  <span style="color:${teamColor};font-weight:700;">${pts1}</span>
                  <span>vs</span>
                  <span style="color:var(--text-secondary);font-weight:600;">${pts2}</span>
                </div>
                <div class="dm-duel-bar-wrap">
                  <div class="dm-duel-bar-left" style="width:${ptsPct1}%;background:${teamColor};"></div>
                  <div class="dm-duel-bar-right" style="width:${ptsPct2}%;background:${teamColor};opacity:0.4;"></div>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join('');

      duelHtml = `
        <div class="dm-section-title">Teammate Duel — Head-to-Head</div>
        ${cardsHtml}
      `;
    }
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
      desc: `Claimed P1 finishing orders in ${team.wins} ${team.wins === 1 ? 'race' : 'races'} this season.`
    });
  }

  // 3. Podium Hogs (Podium count)
  const totalPodiums = teamDrivers.reduce((sum, d) => sum + (d.teamPodiums || 0), 0);
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
      ${championshipOutlookHtml}
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
