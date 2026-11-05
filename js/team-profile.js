// =============================================
// PITCORNER — Constructor / Team Profile Modal (v3.2 Telemetry Edition)
// High-density segmented constructor profile with Prev/Next navigation,
// Driver Share & Roster links, Intra-Team Duel & Weekend Results Matrix
// Uses cached standings data — zero extra API calls
// =============================================

import { getTeamColor, getDriverFlagImg, formatRoundRanges } from './utils.js';
import { drawSparkline } from './charts.js';
import { isFavoriteTeam, toggleFavoriteTeam } from './favorites.js';
import { showDriverProfile } from './driver-profile.js';

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
      if (!overlay.classList.contains('open')) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        closeModal();
      } else if (e.key === 'ArrowLeft' && typeof overlay._onKeyNav === 'function') {
        e.preventDefault();
        overlay._onKeyNav(-1);
      } else if (e.key === 'ArrowRight' && typeof overlay._onKeyNav === 'function') {
        e.preventDefault();
        overlay._onKeyNav(1);
      }
    });
  }
  return overlay;
}

function closeModal() {
  if (overlay) {
    overlay.classList.remove('open');
    overlay._onKeyNav = null;
    document.body.style.overflow = '';
    if (typeof overlay._onCloseCleanup === 'function') overlay._onCloseCleanup();
  }
}

/**
 * Show the team profile modal
 * @param {object} team - Constructor standings object
 * @param {object} standings - Full standings object
 */
export function showTeamProfile(team, standings) {
  const activeOverlay = ensureOverlay();
  const modal = document.getElementById('driver-modal');
  const teamColor = getTeamColor(team.team_colour);
  const sessions = standings?.raceSessions || [];
  const constructorsList = standings?.constructors || [];
  const driversList = standings?.drivers || [];
  const roundPts = (val) => Math.round(((Number(val) || 0) + Number.EPSILON) * 100) / 100;

  // ── Prev / Next Constructor Navigation ──
  const teamIdx = constructorsList.findIndex(t => t.team_name === team.team_name);
  const teamPos = teamIdx >= 0 ? teamIdx + 1 : 1;
  const prevTeam = teamIdx > 0 ? constructorsList[teamIdx - 1] : null;
  const nextTeam = (teamIdx >= 0 && teamIdx < constructorsList.length - 1) ? constructorsList[teamIdx + 1] : null;

  activeOverlay._onKeyNav = (dir) => {
    if (dir < 0 && prevTeam) showTeamProfile(prevTeam, standings);
    else if (dir > 0 && nextTeam) showTeamProfile(nextTeam, standings);
  };

  // ── World Champion GP Clinch Banner ──
  const clinchInfo = standings.constructorClinchMeeting && standings.constructorClinchMeeting.team_name === team.team_name
    ? standings.constructorClinchMeeting
    : null;

  let championBannerHtml = '';
  if (clinchInfo) {
    championBannerHtml = `
      <div class="dm-champ-banner" style="background:linear-gradient(135deg, rgba(255, 215, 0, 0.14), rgba(255, 215, 0, 0.03)); border: 1px solid rgba(255, 215, 0, 0.38); border-radius: var(--radius-md); padding: var(--space-md); text-align: center; margin-bottom: var(--space-md); box-shadow: 0 0 18px rgba(255, 215, 0, 0.14);">
        <div style="font-family:'Outfit',sans-serif; font-weight:800; font-size:1.05rem; color:#ffd700; display:flex; align-items:center; justify-content:center; gap:8px;">
          <i class="fa-solid fa-trophy"></i> ${standings.year} WORLD CONSTRUCTOR CHAMPION
        </div>
        <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:4px; line-height:1.4;">
          Secured the World Constructors' Championship at the <strong style="color:var(--text-primary);">${clinchInfo.circuit_short_name} Grand Prix</strong> (Round ${clinchInfo.round}).
        </div>
      </div>
    `;
  }

  // ── Build Exact Per-Team Driver Roster (handles mid-season swaps accurately) ──
  const driverByAcronym = new Map(driversList.map(d => [d.name_acronym, d]));
  const rosterNames = (team.drivers && team.drivers.length > 0)
    ? team.drivers.map(td => td.name)
    : driversList.filter(d => d.team_name === team.team_name).map(d => d.name_acronym);

  const teamDrivers = rosterNames.map(acronym => {
    const fullDriver = driverByAcronym.get(acronym) || { name_acronym: acronym, full_name: acronym, headshot_url: '', allResults: [] };
    const tdEntry = (team.drivers || []).find(td => td.name === acronym);
    const teamResults = (fullDriver.allResults || []).filter(r => r.team_name === team.team_name && r.status !== 'ABSENT');
    const teamGpResults = teamResults.filter(r => !r.isSprint);
    const teamSprintResults = teamResults.filter(r => r.isSprint);

    const teamWins = teamGpResults.filter(r => r.position === 1 && r.status === 'FINISHED').length;
    const teamPodiums = teamGpResults.filter(r => r.position <= 3 && r.status === 'FINISHED').length;
    const teamDnfs = teamGpResults.filter(r => r.status === 'DNF').length;
    const teamSprintPts = roundPts(teamSprintResults.reduce((sum, r) => sum + (r.points || 0), 0));
    const teamClassifiedPositions = teamGpResults
      .filter(r => r.status === 'FINISHED' || r.status === 'DNF')
      .map(r => r.position);
    const teamPts = tdEntry ? tdEntry.points : fullDriver.points;
    const avgFin = teamClassifiedPositions.length > 0
      ? (teamClassifiedPositions.reduce((a, b) => a + b, 0) / teamClassifiedPositions.length).toFixed(1)
      : '—';
    const bestFin = teamClassifiedPositions.length > 0
      ? `P${Math.min(...teamClassifiedPositions)}`
      : '—';

    const isExclusiveToTeam = !(fullDriver.teams && fullDriver.teams.length > 1);
    const attributedPoles = isExclusiveToTeam ? (fullDriver.qualiResults || []).filter(q => q === 1).length : 0;
    const attributedQ3 = isExclusiveToTeam ? (fullDriver.q3Appearances || 0) : 0;

    return {
      ...fullDriver,
      teamPoints: roundPts(teamPts || 0),
      teamSprintPoints: teamSprintPts,
      teamWins,
      teamPodiums,
      teamDnfs,
      teamGpCount: teamGpResults.length,
      teamRaceResults: teamClassifiedPositions,
      teamSprintCount: teamSprintResults.length,
      teamAllResults: teamResults,
      teamAvgFinish: avgFin,
      teamBestFinish: bestFin,
      attributedPoles,
      attributedQ3
    };
  }).sort((a, b) => (b.teamPoints - a.teamPoints) || (b.teamGpCount - a.teamGpCount));

  const totalTeamPoints = team.points || 0;
  const denomTeamPoints = totalTeamPoints > 0 ? totalTeamPoints : 1;
  const totalSprintPts = roundPts(teamDrivers.reduce((sum, d) => sum + d.teamSprintPoints, 0));
  const totalGpPts = roundPts(totalTeamPoints - totalSprintPts);
  const hasTeamSprints = teamDrivers.some(d => d.teamSprintCount > 0);
  const teamPoles = teamDrivers.reduce((sum, d) => sum + d.attributedPoles, 0);
  const teamQ3s = teamDrivers.reduce((sum, d) => sum + d.attributedQ3, 0);

  // Best finish, Reliability, Podiums
  const allFinishes = teamDrivers.flatMap(d => d.teamRaceResults || []);
  const bestFinish = allFinishes.length > 0 ? `P${Math.min(...allFinishes)}` : '—';
  const totalStarts = teamDrivers.reduce((sum, d) => sum + (d.teamRaceResults || []).length, 0);
  const totalDnfs = teamDrivers.reduce((sum, d) => sum + (d.teamDnfs || 0), 0);
  const reliabilityRate = totalStarts > 0 ? Math.round((1 - totalDnfs / totalStarts) * 100) : 100;
  const totalPodiums = teamDrivers.reduce((sum, d) => sum + (d.teamPodiums || 0), 0);

  // ── Group Chronological Meetings for Weekend Analytics & Matrix ──
  const meetingsOrder = [];
  const meetingMap = new Map();
  const sortedSessions = [...sessions].sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
  for (const s of sortedSessions) {
    const mKey = s.meeting_key || s.session_key;
    if (!meetingMap.has(mKey)) {
      const mObj = {
        meeting_key: mKey,
        circuit: s.circuit_short_name || s.country_name || 'Grand Prix',
        date_end: s.date_end,
        raceSession: null,
        sprintSession: null
      };
      meetingMap.set(mKey, mObj);
      meetingsOrder.push(mObj);
    }
    const mObj = meetingMap.get(mKey);
    if (s.session_name === 'Sprint') mObj.sprintSession = s;
    else mObj.raceSession = s;
  }

  let doublePointsCount = 0;
  let doublePodiumCount = 0;
  let oneTwoCount = 0;
  let fastestLapsCount = 0;
  let bestWeekend = { pts: -1, circuit: '—', round: 0 };
  const weekendLogs = [];
  let runningCumPts = 0;

  meetingsOrder.forEach((m, idx) => {
    const gpEntries = m.raceSession
      ? teamDrivers
          .map(d => {
            const res = (d.teamAllResults || []).find(r => r.session_key === m.raceSession.session_key && !r.isSprint);
            return res ? { driver: d, res } : null;
          })
          .filter(Boolean)
          .sort((a, b) => (a.res.position || 99) - (b.res.position || 99))
      : [];

    const spEntries = m.sprintSession
      ? teamDrivers
          .map(d => {
            const res = (d.teamAllResults || []).find(r => r.session_key === m.sprintSession.session_key && r.isSprint);
            return res ? { driver: d, res } : null;
          })
          .filter(Boolean)
      : [];

    if (gpEntries.length === 0 && spEntries.length === 0) return;

    const ptsFinishers = gpEntries.filter(e => e.res.position <= 10 && e.res.status === 'FINISHED').length;
    const podFinishers = gpEntries.filter(e => e.res.position <= 3 && e.res.status === 'FINISHED').length;
    const hasP1 = gpEntries.some(e => e.res.position === 1 && e.res.status === 'FINISHED');
    const hasP2 = gpEntries.some(e => e.res.position === 2 && e.res.status === 'FINISHED');

    if (ptsFinishers >= 2) doublePointsCount++;
    if (podFinishers >= 2) doublePodiumCount++;
    if (hasP1 && hasP2) oneTwoCount++;

    // Fastest lap check
    let hasFL = false;
    if (m.raceSession && m.raceSession.fastest_lap_driver) {
      const flDrvObj = (m.raceSession.drivers || []).find(dd => dd.driver_number === m.raceSession.fastest_lap_driver);
      const flAcr = flDrvObj?.name_acronym;
      if (gpEntries.some(e => e.driver.name_acronym === flAcr || e.driver.driver_number === m.raceSession.fastest_lap_driver)) {
        fastestLapsCount++;
        hasFL = true;
      }
    }

    const gpPts = roundPts(gpEntries.reduce((sum, e) => sum + (e.res.points || 0), 0));
    const spPts = roundPts(spEntries.reduce((sum, e) => sum + (e.res.points || 0), 0));
    const wkPts = roundPts(gpPts + spPts);
    runningCumPts = roundPts(runningCumPts + wkPts);

    if (wkPts > bestWeekend.pts) {
      bestWeekend = { pts: wkPts, circuit: m.circuit, round: idx + 1 };
    }

    weekendLogs.push({
      round: idx + 1,
      circuit: m.circuit,
      gpEntries,
      spEntries,
      hasSprintSession: Boolean(m.sprintSession),
      gpPts,
      spPts,
      wkPts,
      cumPts: runningCumPts,
      hasWin: hasP1,
      hasOneTwo: hasP1 && hasP2,
      hasPodium: podFinishers > 0,
      hasFL
    });
  });

  const completedWeekends = weekendLogs.length;
  const ptsPerWeekend = completedWeekends > 0 ? (totalTeamPoints / completedWeekends).toFixed(1) : '—';
  const pointsGap = teamPos > 1 && constructorsList[0]
    ? roundPts(constructorsList[0].points - totalTeamPoints)
    : 0;

  // ── Mathematical Constructor Championship Outlook ──
  let championshipOutlookHtml = '';
  const maxRemConstPts = standings.maxRemainingConstructorPoints || 0;
  if (!standings.isFinished && !standings.isPreliminary && maxRemConstPts > 0 && teamPos > 0) {
    const bestPos = team.bestPos ?? teamPos;
    const worstPos = team.worstPos ?? teamPos;
    const maxPossiblePts = team.maxPossiblePoints ?? roundPts(team.points + maxRemConstPts);
    const canGain = Math.max(0, teamPos - bestPos);
    const canLose = Math.max(0, worstPos - teamPos);
    const totalTeams = Math.max(constructorsList.length, 2);

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
      const nextAhead = constructorsList[teamPos - 2];
      if (nextAhead) {
        const gapAhead = roundPts(nextAhead.points - team.points);
        rivalItems.push(`<div class="outlook-rival-row"><span class="outlook-rival-label"><i class="fa-solid fa-arrow-up" style="color:#2ecc71;"></i> Next ahead:</span> <span class="outlook-rival-val"><strong>P${teamPos - 1} ${nextAhead.team_name}</strong> (${gapAhead === 0 ? 'tied' : `+${gapAhead} pts`})</span></div>`);
      }
      if (bestPos < teamPos - 1) {
        const topTarget = constructorsList[bestPos - 1];
        if (topTarget) {
          const gapTop = roundPts(topTarget.points - team.points);
          rivalItems.push(`<div class="outlook-rival-row"><span class="outlook-rival-label"><i class="fa-solid fa-bullseye" style="color:#ffd700;"></i> Highest reach:</span> <span class="outlook-rival-val"><strong>P${bestPos} ${topTarget.team_name}</strong> (+${gapTop} pts)</span></div>`);
        }
      }
    }

    if (canLose > 0 && teamPos < constructorsList.length) {
      const threats = [];
      for (let k = teamPos; k < constructorsList.length; k++) {
        const ch = constructorsList[k];
        const chMax = ch.maxPossiblePoints ?? (ch.points + maxRemConstPts);
        if (chMax >= team.points) {
          const gapBehind = roundPts(team.points - ch.points);
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

  // ── Recent 5-Weekend Points Strip ──
  let recentFormHtml = '';
  if (weekendLogs.length > 0) {
    const recent5 = weekendLogs.slice(-5);
    const pills = recent5.map(w => {
      const code = (w.circuit || 'GP').substring(0, 3).toUpperCase();
      const cls = w.hasWin ? 'pm-form-win'
        : w.hasPodium ? 'pm-form-pod'
          : w.wkPts > 0 ? 'pm-form-pts'
            : 'pm-form-out';
      return `
        <div class="pm-form-pill ${cls}" title="R${w.round} ${w.circuit}: +${w.wkPts} pts">
          <span class="pm-form-circuit">${code}</span>
          <span class="pm-form-pos">+${w.wkPts}</span>
        </div>
      `;
    }).join('');
    recentFormHtml = `
      <div class="pm-form-strip">
        <span class="pm-form-title"><i class="fa-solid fa-bolt"></i> Last 5 Weekends</span>
        <div class="pm-form-pills">${pills}</div>
      </div>
    `;
  }

  // ── Stacked Driver Points Contribution Box ──
  let shareBoxHtml = '';
  if (teamDrivers.length > 0) {
    const segOpacities = [1, 0.58, 0.35, 0.22];
    shareBoxHtml = `
      <div class="pm-card-box">
        <div class="pm-card-box-hdr">
          <span><i class="fa-solid fa-chart-simple" style="color:${teamColor};margin-right:6px;"></i>Points Contribution Split</span>
          <span class="pm-subtle-tag">${teamDrivers.length} Driver${teamDrivers.length !== 1 ? 's' : ''} Entered</span>
        </div>
        <div class="pm-stacked-bar">
          ${teamDrivers.map((d, idx) => {
            const pct = totalTeamPoints > 0
              ? (d.teamPoints / denomTeamPoints) * 100
              : (100 / teamDrivers.length);
            const op = segOpacities[idx] || 0.2;
            return `<div class="pm-stacked-seg" style="width:${pct}%;background:${teamColor};opacity:${op};" title="${d.name_acronym}: ${d.teamPoints} pts (${Math.round(pct)}%)"></div>`;
          }).join('')}
        </div>
        <div class="pm-dist-legend">
          ${teamDrivers.map((d, idx) => {
            const pct = totalTeamPoints > 0 ? Math.round((d.teamPoints / denomTeamPoints) * 100) : 0;
            const op = segOpacities[idx] || 0.2;
            return `
              <button type="button" class="pm-dist-item pm-clickable-pill" data-open-driver="${d.name_acronym}" title="Open ${d.full_name || d.name_acronym} profile">
                <span class="pm-dist-dot" style="background:${teamColor};opacity:${op};"></span>
                <span class="pm-dist-lbl" style="font-weight:700;color:var(--text-primary);">${d.name_acronym}</span>
                <strong class="pm-dist-val">${d.teamPoints} pts (${pct}%)</strong>
              </button>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ── Weekend Points Haul Skyline Bar Chart ──
  let weekendSkylineHtml = '';
  if (weekendLogs.length > 0) {
    const maxWk = Math.max(25, ...weekendLogs.map(w => w.wkPts));
    const bars = weekendLogs.map(w => {
      const hPct = w.wkPts > 0 ? Math.max(8, (w.wkPts / maxWk) * 100) : 5;
      const barCol = w.hasOneTwo ? '#ffd700'
        : w.hasWin ? '#facc15'
          : w.hasPodium ? teamColor
            : w.wkPts > 0 ? `${teamColor}99`
              : 'var(--bg-tertiary)';
      const shortLbl = w.circuit.length > 4 ? w.circuit.substring(0, 3) : w.circuit;
      return `
        <div class="dm-race-bar-wrap" title="R${w.round} ${w.circuit}: +${w.wkPts} pts${w.hasOneTwo ? ' (1-2 Finish!)' : ''}">
          <div class="dm-race-pos" style="${w.hasWin ? 'color:#ffd700;font-weight:800;' : ''}">${w.wkPts}</div>
          <div class="dm-race-bar" style="height:${hPct}%;background:${barCol};border-radius:3px 3px 0 0;"></div>
          <div class="dm-race-bar-label">${shortLbl}</div>
        </div>
      `;
    }).join('');
    weekendSkylineHtml = `
      <div class="dm-section-title">Points Scored per Weekend</div>
      <div class="dm-races-chart">${bars}</div>
    `;
  }

  // ── Points Progression Chart ──
  const teamPointsHistory = (team.pointsHistory && team.pointsHistory.length > 0) ? team.pointsHistory : [];
  const pointsChartHtml = teamPointsHistory.length > 1 ? `
    <div class="dm-section-title">Cumulative Points Progression</div>
    <div class="dm-chart-wrap">
      <canvas class="dm-chart-canvas" id="dm-points-chart"></canvas>
    </div>
  ` : '';

  // ── Interactive Driver Lineup Cards ──
  let contributionHtml = '';
  if (teamDrivers.length > 0) {
    contributionHtml = `
      <div class="dm-section-title" style="margin-top:0;">Constructor Driver Roster (${teamDrivers.length})</div>
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:var(--space-lg);">
        ${teamDrivers.map((d, idx) => {
          const pct = totalTeamPoints > 0 ? Math.min(100, Math.round((d.teamPoints / denomTeamPoints) * 100)) : 0;
          const flagImg = getDriverFlagImg(d.name_acronym, 'width:15px;border-radius:2px;');
          return `
            <div class="pm-roster-card" data-open-driver="${d.name_acronym}" role="button" tabindex="0" title="Click to open ${d.full_name || d.name_acronym} profile">
              <img src="${d.headshot_url || ''}" alt="${d.name_acronym}" class="pm-roster-avatar" style="border-color:${teamColor};" onerror="this.style.display='none'">
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                  <div style="display:flex;align-items:center;gap:6px;font-family:'Outfit',sans-serif;font-weight:800;font-size:0.96rem;color:var(--text-primary);">
                    <span>${d.full_name || d.name_acronym}</span>
                    ${flagImg}
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="dm-stint-pill">${d.teamGpCount} GP${d.teamGpCount !== 1 ? 's' : ''}${d.teamSprintCount > 0 ? ` · ${d.teamSprintCount} Spr` : ''}</span>
                    <i class="fa-solid fa-chevron-right" style="font-size:0.7rem;color:var(--text-muted);"></i>
                  </div>
                </div>
                <div class="pm-roster-stats-row">
                  <span>Pts: <strong style="color:var(--text-primary);">${d.teamPoints}</strong></span>
                  <span>Wins: <strong>${d.teamWins}</strong></span>
                  <span>Podiums: <strong>${d.teamPodiums}</strong></span>
                  <span>Best: <strong style="color:#ffd700;">${d.teamBestFinish}</strong></span>
                  <span>Avg: <strong>${d.teamAvgFinish}</strong></span>
                  ${d.teamDnfs > 0 ? `<span style="color:#f87171;">DNFs: <strong>${d.teamDnfs}</strong></span>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
                  <div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${teamColor};border-radius:3px;opacity:${idx === 0 ? 1 : (idx === 1 ? 0.65 : 0.45)};"></div>
                  </div>
                  <span style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-secondary);font-weight:700;">${pct}%</span>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // ── Intra-Team Teammate Duel ──
  let duelHtml = '';
  if (teamDrivers.length >= 2) {
    const activePairings = [];
    for (let i = 0; i < teamDrivers.length; i++) {
      for (let j = i + 1; j < teamDrivers.length; j++) {
        const d1 = teamDrivers[i];
        const d2 = teamDrivers[j];
        let sharedGPs = 0, sharedSprints = 0;
        let wins1 = 0, wins2 = 0;
        let sprintWins1 = 0, sprintWins2 = 0;
        let sharedPts1 = 0, sharedPts2 = 0;
        let pod1 = 0, pod2 = 0;
        const fin1 = [], fin2 = [];

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
            if (result.position <= 3 && result.status === 'FINISHED') pod1++;
            if (tmResult.position <= 3 && tmResult.status === 'FINISHED') pod2++;
            if (result.status === 'FINISHED' || result.status === 'DNF') fin1.push(result.position);
            if (tmResult.status === 'FINISHED' || tmResult.status === 'DNF') fin2.push(tmResult.position);
          }
        }

        if (sharedGPs > 0 || sharedSprints > 0) {
          activePairings.push({
            d1, d2, sharedGPs, sharedSprints, wins1, wins2, sprintWins1, sprintWins2, sharedPts1, sharedPts2,
            pod1, pod2,
            avg1: fin1.length > 0 ? (fin1.reduce((a, b) => a + b, 0) / fin1.length).toFixed(1) : '—',
            avg2: fin2.length > 0 ? (fin2.reduce((a, b) => a + b, 0) / fin2.length).toFixed(1) : '—',
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

        const metricRows = [
          { label: 'Race H2H', v1: wins1, v2: wins2 },
        ];
        if ((sprintWins1 + sprintWins2) > 0) {
          metricRows.push({ label: 'Sprint H2H', v1: sprintWins1, v2: sprintWins2 });
        }
        metricRows.push(
          { label: ptsLabel, v1: pts1, v2: pts2 },
          { label: 'Podiums', v1: pair.pod1, v2: pair.pod2 },
          { label: 'Avg Finish', v1: pair.avg1, v2: pair.avg2, lowerBetter: true },
        );

        return `
          <div class="dm-duel-card" style="margin-bottom:var(--space-md);">
            <div class="dm-duel-header">
              <button type="button" class="dm-duel-driver pm-clickable-driver" data-open-driver="${d1.name_acronym}">
                <img src="${d1.headshot_url || ''}" alt="${d1.name_acronym}" class="dm-duel-img" style="border-color:${teamColor};" onerror="this.style.display='none'">
                <div class="dm-duel-name" style="color:${teamColor};">${d1.name_acronym}</div>
              </button>
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <div class="dm-duel-vs">VS</div>
                <span class="dm-stint-pill">${sharedGPs} Shared GP${sharedGPs !== 1 ? 's' : ''}</span>
              </div>
              <button type="button" class="dm-duel-driver pm-clickable-driver" data-open-driver="${d2.name_acronym}">
                <img src="${d2.headshot_url || ''}" alt="${d2.name_acronym}" class="dm-duel-img" style="border-color:#94a3b8;" onerror="this.style.display='none'">
                <div class="dm-duel-name" style="color:var(--text-primary);">${d2.name_acronym}</div>
              </button>
            </div>
            <div class="dm-duel-body">
              ${metricRows.map(row => {
                const n1 = parseFloat(row.v1);
                const n2 = parseFloat(row.v2);
                let pct1 = 50;
                if (!isNaN(n1) && !isNaN(n2) && (n1 + n2) > 0) {
                  pct1 = row.lowerBetter ? (n2 / (n1 + n2)) * 100 : (n1 / (n1 + n2)) * 100;
                }
                const lWin = !isNaN(n1) && !isNaN(n2) && (row.lowerBetter ? n1 < n2 : n1 > n2);
                const rWin = !isNaN(n1) && !isNaN(n2) && (row.lowerBetter ? n2 < n1 : n2 > n1);
                return `
                  <div class="dm-teammate-row" style="padding:8px 0;">
                    <div class="dm-tm-values" style="min-width:44px;justify-content:flex-start;">
                      <span class="dm-tm-val" style="color:${lWin ? teamColor : 'var(--text-secondary)'};font-weight:${lWin ? '800' : '600'};">${row.v1}</span>
                    </div>
                    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;">
                      <div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);text-align:center;font-weight:700;">${row.label}</div>
                      <div class="dm-tm-bar">
                        <div class="dm-tm-bar-left" style="width:${pct1}%;background:${teamColor};"></div>
                        <div class="dm-tm-bar-right" style="width:${100 - pct1}%;background:#64748b;opacity:0.55;"></div>
                      </div>
                    </div>
                    <div class="dm-tm-values" style="min-width:44px;justify-content:flex-end;">
                      <span class="dm-tm-val" style="color:${rWin ? '#e2e8f0' : 'var(--text-muted)'};font-weight:${rWin ? '800' : '600'};">${row.v2}</span>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }).join('');

      duelHtml = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:var(--space-md);">
          <div class="dm-section-title" style="margin:0;">Intra-Team Head-to-Head</div>
          <button type="button" class="pm-action-chip" id="tm-jump-h2h">
            <i class="fa-solid fa-people-arrows"></i> Full H2H Arena
          </button>
        </div>
        ${cardsHtml}
      `;
    }
  }

  // ── Constructor Achievements ──
  const milestones = [];
  const leadRounds = standings.constructorLeadRounds && standings.constructorLeadRounds[team.team_name];
  if (leadRounds && leadRounds.length > 0) {
    const roundList = formatRoundRanges(leadRounds);
    milestones.push({
      icon: '<i class="fa-solid fa-crown" style="color: #ffd700;"></i>',
      title: 'Championship Leaders',
      desc: `Led the Constructors' World Championship for ${leadRounds.length} round${leadRounds.length > 1 ? 's' : ''} (${roundList.toLowerCase()}).`
    });
  }
  if (oneTwoCount > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-medal" style="color: #ffd700;"></i>',
      title: '1-2 Formation Finish',
      desc: `Locked out P1 and P2 in ${oneTwoCount} Grand Prix race${oneTwoCount > 1 ? 's' : ''} this season.`
    });
  }
  if (team.wins >= 5) {
    milestones.push({
      icon: '<i class="fa-solid fa-trophy" style="color: #ffd700;"></i>',
      title: 'Dominant Force',
      desc: `Secured ${team.wins} Grand Prix victories across the season.`
    });
  } else if (team.wins > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-trophy" style="color: #c0c0c0;"></i>',
      title: 'Race Winners',
      desc: `Claimed P1 victory in ${team.wins} Grand Prix ${team.wins === 1 ? 'race' : 'races'}.`
    });
  }
  if (teamPoles > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-stopwatch" style="color: #a855f7;"></i>',
      title: 'One-Lap Qualifiers',
      desc: `Earned ${teamPoles} Pole Position${teamPoles > 1 ? 's' : ''} and ${teamQ3s} Q3 appearances.`
    });
  }
  if (totalPodiums >= 10) {
    milestones.push({
      icon: '<i class="fa-solid fa-award" style="color: #ffd000;"></i>',
      title: 'Podium Hogs',
      desc: `Stood on the podium ${totalPodiums} times across the lineup.`
    });
  } else if (totalPodiums > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-angles-up" style="color: #c0c0c0;"></i>',
      title: 'Podium Contenders',
      desc: `Collected ${totalPodiums} Grand Prix podium finish${totalPodiums > 1 ? 'es' : ''}.`
    });
  }
  if (reliabilityRate >= 90 && totalStarts >= 6) {
    milestones.push({
      icon: '<i class="fa-solid fa-shield-halved" style="color: #39b54a;"></i>',
      title: 'Bulletproof Reliability',
      desc: `${reliabilityRate}% classification reliability across ${totalStarts} GP car starts.`
    });
  }
  if (doublePointsCount >= 5) {
    milestones.push({
      icon: '<i class="fa-solid fa-chart-line" style="color: #39b54a;"></i>',
      title: 'Double Points Machine',
      desc: `Scored double-car top-10 points in ${doublePointsCount} Grand Prix weekends.`
    });
  }

  const milestonesHtml = milestones.length > 0 ? `
    <div class="dm-section-title">Constructor Achievements (${milestones.length})</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;">
      ${milestones.map(m => `
        <div class="dm-milestone-card">
          <div class="dm-milestone-icon">${m.icon}</div>
          <div style="flex:1;min-width:0;">
            <div class="dm-milestone-title">${m.title}</div>
            <div class="dm-milestone-desc">${m.desc}</div>
          </div>
        </div>
      `).join('')}
    </div>
  ` : '';

  // ── Weekend Log Matrix Table ──
  const formatDriverCell = (entry) => {
    if (!entry) return '<span style="color:var(--text-muted);">—</span>';
    const st = entry.res.status || 'FINISHED';
    const posTxt = st !== 'FINISHED' ? st : `P${entry.res.position}`;
    const cls = st !== 'FINISHED' ? 'pm-pos-dnf'
      : entry.res.position === 1 ? 'pm-pos-p1'
        : entry.res.position === 2 ? 'pm-pos-p2'
          : entry.res.position === 3 ? 'pm-pos-p3'
            : entry.res.position <= 10 ? 'pm-pos-pts'
              : 'pm-pos-out';
    return `
      <span style="display:inline-flex;align-items:center;gap:5px;">
        <span style="font-size:0.7rem;font-weight:700;color:var(--text-secondary);">${entry.driver.name_acronym}</span>
        <span class="pm-pos-pill ${cls}">${posTxt}</span>
      </span>
    `;
  };

  const weekendLogRowsHtml = weekendLogs.map(w => {
    const isBest = bestWeekend.pts > 0 && w.round === bestWeekend.round && w.wkPts === bestWeekend.pts;
    const carsHtml = w.gpEntries.length > 0
      ? w.gpEntries.map(formatDriverCell).join(' ')
      : '<span style="color:var(--text-muted);">—</span>';
    return `
      <tr style="${isBest ? 'background:rgba(255,215,0,0.05);' : ''}">
        <td class="pm-td-mono" style="color:var(--text-muted);">R${w.round}</td>
        <td>
          <span style="font-weight:700;color:var(--text-primary);">${w.circuit}</span>
          ${isBest ? ' <span class="pm-mini-gold-tag" title="Best Scoring Weekend">★ Best</span>' : ''}
          ${w.hasFL ? ' <i class="fa-solid fa-bolt" style="color:#c084fc;font-size:0.65rem;" title="Fastest Lap"></i>' : ''}
        </td>
        <td><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${carsHtml}</div></td>
        ${hasTeamSprints ? `<td class="pm-td-mono" style="text-align:right;color:${w.spPts > 0 ? '#38bdf8' : 'var(--text-muted)'};">${w.hasSprintSession ? (w.spPts > 0 ? `+${w.spPts}` : '0') : '·'}</td>` : ''}
        <td class="pm-td-mono" style="text-align:right;font-weight:800;color:${w.wkPts > 0 ? '#2ecc71' : 'var(--text-muted)'};">${w.wkPts > 0 ? `+${w.wkPts}` : '0'}</td>
        <td class="pm-td-mono" style="text-align:right;color:var(--text-secondary);font-weight:600;">${w.cumPts}</td>
      </tr>
    `;
  }).join('');

  const weekendLogTabHtml = weekendLogs.length > 0 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:var(--space-sm);">
      <div class="dm-section-title" style="margin:0;">${standings.year || ''} Constructor Weekend Matrix</div>
      ${bestWeekend.pts > 0 ? `<span class="pm-subtle-tag" style="color:#ffd700;border-color:rgba(255,215,0,0.25);">Peak Haul: +${bestWeekend.pts} pts (${bestWeekend.circuit})</span>` : ''}
    </div>
    <div class="pm-table-wrap custom-scrollbar">
      <table class="pm-data-table">
        <thead>
          <tr>
            <th>Rnd</th>
            <th>Grand Prix</th>
            <th>GP Classification</th>
            ${hasTeamSprints ? '<th style="text-align:right;">Spr</th>' : ''}
            <th style="text-align:right;">Wknd</th>
            <th style="text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${weekendLogRowsHtml}
        </tbody>
      </table>
    </div>
  ` : `<div class="pm-empty-note">No completed Grand Prix weekends recorded yet.</div>`;

  // ── Tabs & Header Assembly ──
  const isPinnedTeam = isFavoriteTeam(team.team_name);
  const rankBadgeClass = teamPos === 1 ? 'pm-rank-p1' : teamPos === 2 ? 'pm-rank-p2' : teamPos === 3 ? 'pm-rank-p3' : '';
  const monogram = team.team_name.replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase();

  const tabSelectorHtml = `
    <div class="dm-tabs pm-segmented-tabs" role="tablist">
      <button type="button" class="dm-tab active" data-tab="overview"><i class="fa-solid fa-chart-pie"></i> Overview</button>
      <button type="button" class="dm-tab" data-tab="drivers"><i class="fa-solid fa-users"></i> Drivers & Duel</button>
      <button type="button" class="dm-tab" data-tab="weekends"><i class="fa-solid fa-calendar-check"></i> Weekend Log (${weekendLogs.length})</button>
    </div>
  `;

  const overviewTabHtml = `
    <div id="tm-content-overview" class="dm-tab-content active">
      ${championBannerHtml}
      ${championshipOutlookHtml}
      ${recentFormHtml}

      <div class="dm-stats-grid" style="margin-bottom:var(--space-sm);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${teamPos <= 3 ? teamColor : 'var(--text-primary)'}">P${teamPos}</div>
          <div class="dm-stat-label">${pointsGap > 0 ? `−${pointsGap} to P1` : 'Leader'}</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${team.points}</div>
          <div class="dm-stat-label">${hasTeamSprints ? `${totalGpPts} GP + ${totalSprintPts} Spr` : 'Total Points'}</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${ptsPerWeekend}</div>
          <div class="dm-stat-label">Pts / Wknd</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${team.wins > 0 ? '#ffd700' : 'var(--text-primary)'}">${team.wins}</div>
          <div class="dm-stat-label">GP Wins</div>
        </div>
      </div>

      <div class="dm-stats-grid" style="margin-bottom:var(--space-sm);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${totalPodiums}</div>
          <div class="dm-stat-label">Podiums</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${oneTwoCount > 0 ? '#ffd700' : 'var(--text-primary)'}">${oneTwoCount}</div>
          <div class="dm-stat-label">1-2 Finishes</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${doublePodiumCount}</div>
          <div class="dm-stat-label">Double Pod</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${doublePointsCount}</div>
          <div class="dm-stat-label">Double Pts</div>
        </div>
      </div>

      <div class="dm-stats-grid" style="margin-bottom:var(--space-md);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">${bestFinish}</div>
          <div class="dm-stat-label">Best Finish</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#a855f7">${teamPoles}</div>
          <div class="dm-stat-label">Poles (${teamQ3s} Q3s)</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${reliabilityRate >= 90 ? '#39b54a' : reliabilityRate >= 65 ? '#ffd000' : '#ff3333'}">${reliabilityRate}%</div>
          <div class="dm-stat-label">Reliability (${totalDnfs} DNF)</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#c084fc">${fastestLapsCount}</div>
          <div class="dm-stat-label">Fastest Laps</div>
        </div>
      </div>

      ${shareBoxHtml}
      ${weekendSkylineHtml}
      ${pointsChartHtml}
      ${milestonesHtml}
    </div>
  `;

  const driversTabHtml = `
    <div id="tm-content-drivers" class="dm-tab-content">
      ${contributionHtml}
      ${duelHtml}
    </div>
  `;

  const weekendsTabHtml = `
    <div id="tm-content-weekends" class="dm-tab-content">
      ${weekendLogTabHtml}
    </div>
  `;

  modal.innerHTML = `
    <div class="pm-topbar">
      <div class="pm-nav-group">
        <button type="button" class="pm-nav-btn" id="tm-prev-team" ${!prevTeam ? 'disabled' : ''} title="${prevTeam ? `Previous: P${teamPos - 1} ${prevTeam.team_name} (←)` : 'First in standings'}">
          <i class="fa-solid fa-chevron-left"></i>
          <span>${prevTeam ? `P${teamPos - 1} ${prevTeam.team_name}` : 'Prev'}</span>
        </button>
        <span class="pm-nav-indicator">${standings.year || ''} · P${teamPos}/${constructorsList.length || 1}</span>
        <button type="button" class="pm-nav-btn" id="tm-next-team" ${!nextTeam ? 'disabled' : ''} title="${nextTeam ? `Next: P${teamPos + 1} ${nextTeam.team_name} (→)` : 'Last in standings'}">
          <span>${nextTeam ? `P${teamPos + 1} ${nextTeam.team_name}` : 'Next'}</span>
          <i class="fa-solid fa-chevron-right"></i>
        </button>
      </div>
      <button class="driver-modal-close pm-inline-close" id="dm-close" aria-label="Close">✕</button>
    </div>

    <div class="dm-header pm-hero-header" style="--dm-team-color:${teamColor};color:${teamColor}">
      <div class="pm-hero-accent" style="background:${teamColor};"></div>
      <div class="pm-avatar-wrap">
        <div class="pm-team-emblem" style="border-color:${teamColor};background:radial-gradient(circle at 30% 30%, ${teamColor}33, rgba(15,15,24,0.95));color:${teamColor};">
          ${monogram}
        </div>
        <span class="pm-avatar-rank ${rankBadgeClass}" style="${teamPos > 3 ? `border-color:${teamColor};color:${teamColor};` : ''}">P${teamPos}</span>
      </div>
      <div class="dm-header-info">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);font-weight:700;">
          Formula 1 Constructor · ${completedWeekends} GP${completedWeekends !== 1 ? 's' : ''} Entered
        </div>
        <div class="dm-driver-name" style="color:var(--text-primary);margin-top:2px;">${team.team_name}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;">
          ${teamDrivers.slice(0, 4).map(d => `
            <button type="button" class="pm-team-link-chip" data-open-driver="${d.name_acronym}" style="--chip-col:${teamColor};" title="Open ${d.full_name || d.name_acronym}">
              <span>${d.name_acronym}</span>
              <span style="opacity:0.7;font-family:'JetBrains Mono',monospace;font-size:0.66rem;">${d.teamPoints}p</span>
            </button>
          `).join('')}
          <button type="button" class="modal-fav-pin-btn ${isPinnedTeam ? 'active' : ''}" id="tm-fav-pin-btn">
            <i class="fa-${isPinnedTeam ? 'solid' : 'regular'} fa-star"></i>
            <span>${isPinnedTeam ? 'Pinned Team' : 'Pin Team'}</span>
          </button>
        </div>
      </div>
      <div class="dm-driver-number" style="font-size:2rem;opacity:0.22;" aria-hidden="true">${monogram}</div>
    </div>

    <div class="dm-body">
      ${tabSelectorHtml}
      ${overviewTabHtml}
      ${driversTabHtml}
      ${weekendsTabHtml}
    </div>
  `;

  // ── Event Bindings ──
  document.getElementById('dm-close')?.addEventListener('click', closeModal);

  document.getElementById('tm-prev-team')?.addEventListener('click', () => {
    if (prevTeam) showTeamProfile(prevTeam, standings);
  });
  document.getElementById('tm-next-team')?.addEventListener('click', () => {
    if (nextTeam) showTeamProfile(nextTeam, standings);
  });

  const tmFavBtn = document.getElementById('tm-fav-pin-btn');
  if (tmFavBtn) {
    tmFavBtn.addEventListener('click', () => {
      const nowPinned = toggleFavoriteTeam(team.team_name);
      tmFavBtn.classList.toggle('active', nowPinned);
      tmFavBtn.innerHTML = `<i class="fa-${nowPinned ? 'solid' : 'regular'} fa-star"></i><span>${nowPinned ? 'Pinned Team' : 'Pin Team'}</span>`;
    });
  }

  // Clickable Driver cards / chips -> open Driver Profile
  modal.querySelectorAll('[data-open-driver]').forEach(el => {
    const triggerOpen = () => {
      const acr = el.getAttribute('data-open-driver');
      const fullDrv = driverByAcronym.get(acr);
      if (fullDrv) {
        modal.scrollTop = 0;
        showDriverProfile(fullDrv, standings, sessions);
      }
    };
    el.addEventListener('click', triggerOpen);
    if (el.getAttribute('role') === 'button') {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerOpen();
        }
      });
    }
  });

  document.getElementById('tm-jump-h2h')?.addEventListener('click', () => {
    closeModal();
    window.location.hash = '#h2h';
  });

  const renderPointsChart = () => {
    if (teamPointsHistory.length <= 1) return;
    const canvas = document.getElementById('dm-points-chart');
    if (canvas) {
      drawSparkline(canvas, teamPointsHistory, teamColor, true);
    }
  };

  // Segmented Tab Switching
  const tabs = modal.querySelectorAll('.dm-tab');
  const contents = modal.querySelectorAll('.dm-tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      contents.forEach(c => c.classList.toggle('active', c.id === `tm-content-${target}`));
      if (target === 'overview') {
        requestAnimationFrame(renderPointsChart);
      }
    });
  });

  // Open modal & render chart
  document.body.style.overflow = 'hidden';
  modal.scrollTop = 0;
  requestAnimationFrame(() => {
    activeOverlay.classList.add('open');
    renderPointsChart();
  });
}
