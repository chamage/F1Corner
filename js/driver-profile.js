// =============================================
// PITCORNER — Driver Profile Modal (v3.2 Telemetry Edition)
// High-density segmented profile with Prev/Next navigation,
// Qualifying analytics, Form & Distribution, Teammate Duel & Season Log
// Uses cached data only — zero extra API calls
// =============================================

import { getTeamColor, getPointsForPosition, getDriverFlagImg, DRIVER_NATIONALITY, formatRoundRanges } from './utils.js';
import { drawSparkline } from './charts.js';
import { isFavoriteDriver, toggleFavoriteDriver } from './favorites.js';
import { showTeamProfile } from './team-profile.js';

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
 * Show the driver profile modal.
 * @param {object} driver - Driver standings data (from cachedStandings.drivers)
 * @param {object} standings - Full cachedStandings object
 * @param {Array} raceSessions - Completed race sessions with meeting info
 */
export function showDriverProfile(driver, standings, raceSessions) {
  const activeOverlay = ensureOverlay();
  const modal = document.getElementById('driver-modal');
  const sessions = raceSessions || standings?.raceSessions || [];
  const teamColor = getTeamColor(driver.team_colour);
  const roundPts = (val) => Math.round(((Number(val) || 0) + Number.EPSILON) * 100) / 100;

  // ── Prev / Next Driver Navigation ──
  const driversList = standings?.drivers || [];
  const champIdx = driversList.findIndex(d => d.name_acronym === driver.name_acronym);
  const champPos = champIdx >= 0 ? champIdx + 1 : 1;
  const prevDriver = champIdx > 0 ? driversList[champIdx - 1] : null;
  const nextDriver = (champIdx >= 0 && champIdx < driversList.length - 1) ? driversList[champIdx + 1] : null;

  activeOverlay._onKeyNav = (dir) => {
    if (dir < 0 && prevDriver) showDriverProfile(prevDriver, standings, sessions);
    else if (dir > 0 && nextDriver) showDriverProfile(nextDriver, standings, sessions);
  };

  // ── World Champion GP Clinch Banner ──
  const clinchInfo = standings.driverClinchMeeting && (standings.driverClinchMeeting.name_acronym === driver.name_acronym || standings.driverClinchMeeting.driver_number === driver.driver_number)
    ? standings.driverClinchMeeting
    : null;

  let championBannerHtml = '';
  if (clinchInfo) {
    championBannerHtml = `
      <div class="dm-champ-banner" style="background:linear-gradient(135deg, rgba(255, 215, 0, 0.14), rgba(255, 215, 0, 0.03)); border: 1px solid rgba(255, 215, 0, 0.38); border-radius: var(--radius-md); padding: var(--space-md); text-align: center; margin-bottom: var(--space-md); box-shadow: 0 0 18px rgba(255, 215, 0, 0.14);">
        <div style="font-family:'Outfit',sans-serif; font-weight:800; font-size:1.05rem; color:#ffd700; display:flex; align-items:center; justify-content:center; gap:8px;">
          <i class="fa-solid fa-crown"></i> ${standings.year} WORLD CHAMPION
        </div>
        <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:4px; line-height:1.4;">
          Clinched the Drivers' World Championship at the <strong style="color:var(--text-primary);">${clinchInfo.circuit_short_name} Grand Prix</strong> (Round ${clinchInfo.round}).
        </div>
      </div>
    `;
  }

  // ── Compute GP & Career Season Derived Stats ──
  const rr = driver.raceResults || [];
  const avgFinishNum = rr.length > 0 ? (rr.reduce((a, b) => a + b, 0) / rr.length) : null;
  const avgFinish = avgFinishNum !== null ? avgFinishNum.toFixed(1) : '—';
  const bestFinish = rr.length > 0 ? Math.min(...rr) : '—';
  const worstFinish = rr.length > 0 ? Math.max(...rr) : '—';
  const gpPoints = roundPts(driver.points - (driver.sprintPoints || 0));
  const pointsPerRace = rr.length > 0 ? (gpPoints / rr.length).toFixed(1) : '—';
  const pointsFinishes = rr.filter(p => p <= 10).length;
  const pointsRate = rr.length > 0 ? Math.round((pointsFinishes / rr.length) * 100) : 0;

  // Fastest laps in GP sessions
  const fastestLapSessionKeys = new Set();
  sessions.forEach(r => {
    if (r.session_name === 'Sprint' || !r.fastest_lap_driver) return;
    const rd = r.drivers ? r.drivers.find(d => d.driver_number === r.fastest_lap_driver) : null;
    const acronym = rd ? rd.name_acronym : null;
    if (acronym === driver.name_acronym || r.fastest_lap_driver === driver.driver_number) {
      fastestLapSessionKeys.add(r.session_key);
    }
  });
  const fastestLapsCount = fastestLapSessionKeys.size;

  // Consistency score
  let consistencyScore = 0;
  let consistencyLabel = '';
  let finishStdDev = '—';
  if (rr.length >= 2) {
    const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
    const variance = rr.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / rr.length;
    const stddev = Math.sqrt(variance);
    finishStdDev = `±${stddev.toFixed(1)} pos`;
    consistencyScore = Math.max(0, Math.min(100, Math.round((1 - stddev / 10) * 100)));
    if (consistencyScore >= 85) consistencyLabel = 'Machine-like';
    else if (consistencyScore >= 70) consistencyLabel = 'Very Consistent';
    else if (consistencyScore >= 50) consistencyLabel = 'Consistent';
    else if (consistencyScore >= 30) consistencyLabel = 'Unpredictable';
    else consistencyLabel = 'Wild Card';
  }

  // ── Qualifying Derived Stats ──
  const q3Count = driver.q3Appearances || 0;
  const qr = driver.qualiResults || [];
  const totalQuali = qr.length;
  const q3Rate = totalQuali > 0 ? Math.round((q3Count / totalQuali) * 100) : 0;
  const avgQualiNum = totalQuali > 0 ? (qr.reduce((a, b) => a + b, 0) / totalQuali) : null;
  const avgQuali = avgQualiNum !== null ? avgQualiNum.toFixed(1) : '—';
  const bestQuali = totalQuali > 0 ? Math.min(...qr) : '—';
  const worstQuali = totalQuali > 0 ? Math.max(...qr) : '—';
  const polesCount = qr.filter(q => q === 1).length;
  const frontRowCount = qr.filter(q => q <= 2).length;
  const top3QualiCount = qr.filter(q => q <= 3).length;
  const seasonQ2Cutoff = ((standings?.constructors?.length || 0) >= 12 || driversList.length >= 23) ? 17 : (((standings?.constructors?.length || 0) >= 11 || driversList.length >= 21 || Number(standings?.year) >= 2026) ? 16 : 15);
  const q2OutCount = qr.filter(q => q > 10 && q <= seasonQ2Cutoff).length;
  const q1OutCount = qr.filter(q => q > seasonQ2Cutoff).length;

  // Net Racecraft indicator (Avg Grid vs Avg Finish)
  let racecraftVal = '—';
  let racecraftColor = 'var(--text-secondary)';
  let racecraftSub = 'Grid vs Finish';
  if (avgQualiNum !== null && avgFinishNum !== null) {
    const netDelta = avgQualiNum - avgFinishNum;
    if (Math.abs(netDelta) < 0.15) {
      racecraftVal = '0.0';
      racecraftSub = 'Holds Grid Avg';
    } else if (netDelta > 0) {
      racecraftVal = `+${netDelta.toFixed(1)}`;
      racecraftColor = '#2ecc71';
      racecraftSub = 'Avg Pos Gained';
    } else {
      racecraftVal = `${netDelta.toFixed(1)}`;
      racecraftColor = '#f87171';
      racecraftSub = 'Avg Pos Lost';
    }
  }

  // ── Sprint & Sprint Qualifying Derived Stats ──
  const sprintQ3Count = driver.sprintQ3Appearances || 0;
  const sqr = driver.sprintQualiResults || [];
  const totalSprintQuali = sqr.length;
  const sprintQ3Rate = totalSprintQuali > 0 ? Math.round((sprintQ3Count / totalSprintQuali) * 100) : 0;
  const avgSprintQuali = totalSprintQuali > 0 ? (sqr.reduce((a, b) => a + b, 0) / totalSprintQuali).toFixed(1) : '—';
  const bestSprintQuali = totalSprintQuali > 0 ? Math.min(...sqr) : '—';
  const sprintPolesCount = sqr.filter(q => q === 1).length;

  const sprintRr = driver.sprintResults || [];
  const hasSprints = sprintRr.length > 0;
  const avgSprintFinish = sprintRr.length > 0 ? (sprintRr.reduce((a, b) => a + b, 0) / sprintRr.length).toFixed(1) : '—';
  const bestSprintFinish = sprintRr.length > 0 ? Math.min(...sprintRr) : '—';
  const sprintPoints = roundPts(driver.sprintPoints || 0);
  const pointsPerSprint = sprintRr.length > 0 ? (sprintPoints / sprintRr.length).toFixed(1) : '—';
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

  // ── Team Stints & Constructor Share ──
  const driverTeams = (driver.teams && driver.teams.length > 0)
    ? driver.teams
    : (driver.team_name && driver.team_name !== 'Unknown'
      ? [{ team_name: driver.team_name, team_colour: driver.team_colour }]
      : []);
  const hasMultipleTeams = driverTeams.length > 1;
  const linkedConstructor = (standings?.constructors || []).find(t => t.team_name === driver.team_name);
  let teamPtsSharePct = null;
  if (!hasMultipleTeams && linkedConstructor && linkedConstructor.points > 0) {
    teamPtsSharePct = Math.min(100, Math.round((driver.points / linkedConstructor.points) * 100));
  } else if (hasMultipleTeams) {
    // Sum points across constructors the driver drove for
    let totalConstPts = 0;
    for (const dt of driverTeams) {
      const ct = (standings?.constructors || []).find(c => c.team_name === dt.team_name);
      if (ct) totalConstPts += ct.points;
    }
    if (totalConstPts > 0) {
      teamPtsSharePct = Math.min(100, Math.round((driver.points / totalConstPts) * 100));
    }
  }

  // ── Chronological GP & Sprint Results ──
  const sessionMap = new Map(sessions.map(s => [s.session_key, s]));
  const raceOnlyResults = (driver.allResults || []).filter(r => !r.isSprint).slice();
  raceOnlyResults.sort((a, b) => {
    const sA = sessionMap.get(a.session_key);
    const sB = sessionMap.get(b.session_key);
    if (!sA || !sB) return 0;
    return new Date(sA.date_end) - new Date(sB.date_end);
  });
  const visibleRaceResults = raceOnlyResults.filter(r => (r.status || 'FINISHED') !== 'ABSENT');

  const sprintOnlyResults = (driver.allResults || []).filter(r => r.isSprint).slice();
  sprintOnlyResults.sort((a, b) => {
    const sA = sessionMap.get(a.session_key);
    const sB = sessionMap.get(b.session_key);
    if (!sA || !sB) return 0;
    return new Date(sA.date_end) - new Date(sB.date_end);
  });
  const visibleSprintResults = sprintOnlyResults.filter(r => (r.status || 'FINISHED') !== 'ABSENT');

  // ── Finishing Distribution & Streaks ──
  let distWins = 0, distPodOther = 0, distPtsOther = 0, distOutPts = 0, distNonFin = 0;
  let curPtsStreak = 0, maxPtsStreak = 0, curPodStreak = 0, maxPodStreak = 0;
  for (const r of visibleRaceResults) {
    const st = r.status || 'FINISHED';
    if (st !== 'FINISHED') {
      distNonFin++;
      curPtsStreak = 0;
      curPodStreak = 0;
    } else {
      if (r.position === 1) distWins++;
      else if (r.position <= 3) distPodOther++;
      else if (r.position <= 10) distPtsOther++;
      else distOutPts++;

      if (r.position <= 10) {
        curPtsStreak++;
        if (curPtsStreak > maxPtsStreak) maxPtsStreak = curPtsStreak;
      } else {
        curPtsStreak = 0;
      }
      if (r.position <= 3) {
        curPodStreak++;
        if (curPodStreak > maxPodStreak) maxPodStreak = curPodStreak;
      } else {
        curPodStreak = 0;
      }
    }
  }

  // Recent 5-Race Form Pills
  let recentFormHtml = '';
  if (visibleRaceResults.length > 0) {
    const recent5 = visibleRaceResults.slice(-5);
    const pills = recent5.map(r => {
      const s = sessionMap.get(r.session_key);
      const code = (s?.circuit_short_name || 'GP').substring(0, 3).toUpperCase();
      const st = r.status || 'FINISHED';
      let posTxt = `P${r.position}`;
      let cls = 'pm-form-out';
      if (st !== 'FINISHED') {
        posTxt = st;
        cls = 'pm-form-dnf';
      } else if (r.position === 1) {
        cls = 'pm-form-win';
      } else if (r.position <= 3) {
        cls = 'pm-form-pod';
      } else if (r.position <= 10) {
        cls = 'pm-form-pts';
      }
      return `
        <div class="pm-form-pill ${cls}" title="${s?.circuit_short_name || 'GP'}: ${posTxt} (+${r.points || 0} pts)">
          <span class="pm-form-circuit">${code}</span>
          <span class="pm-form-pos">${posTxt}</span>
        </div>
      `;
    }).join('');
    recentFormHtml = `
      <div class="pm-form-strip">
        <span class="pm-form-title"><i class="fa-solid fa-bolt"></i> Recent Form</span>
        <div class="pm-form-pills">${pills}</div>
      </div>
    `;
  }

  // Finishing Position Distribution Bar
  let distributionHtml = '';
  if (visibleRaceResults.length > 0) {
    const totalStarts = visibleRaceResults.length;
    const segs = [
      { label: 'Wins', count: distWins, color: '#ffd700' },
      { label: 'P2–P3', count: distPodOther, color: teamColor },
      { label: 'P4–P10', count: distPtsOther, color: '#38bdf8' },
      { label: 'P11+', count: distOutPts, color: 'rgba(148,163,184,0.45)' },
      { label: 'DNF/DNS', count: distNonFin, color: '#ef4444' },
    ];
    const completionRate = totalStarts > 0 ? Math.round(((totalStarts - distNonFin) / totalStarts) * 100) : 100;

    distributionHtml = `
      <div class="pm-card-box">
        <div class="pm-card-box-hdr">
          <span><i class="fa-solid fa-chart-pie" style="color:${teamColor};margin-right:6px;"></i>GP Finish Distribution (${totalStarts} Starts)</span>
          <span class="pm-subtle-tag">${completionRate}% Classified</span>
        </div>
        <div class="pm-stacked-bar">
          ${segs.filter(s => s.count > 0).map(s => `
            <div class="pm-stacked-seg" style="width:${(s.count / totalStarts) * 100}%;background:${s.color};" title="${s.label}: ${s.count} (${Math.round((s.count / totalStarts) * 100)}%)"></div>
          `).join('')}
        </div>
        <div class="pm-dist-legend">
          ${segs.map(s => `
            <div class="pm-dist-item">
              <span class="pm-dist-dot" style="background:${s.color};"></span>
              <span class="pm-dist-lbl">${s.label}</span>
              <strong class="pm-dist-val">${s.count}</strong>
            </div>
          `).join('')}
        </div>
        <div class="pm-micro-kpis">
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">Points Streak</span>
            <strong class="pm-micro-val">${maxPtsStreak} GP${maxPtsStreak !== 1 ? 's' : ''}${curPtsStreak > 0 && curPtsStreak === maxPtsStreak ? ' 🔥' : ''}</strong>
          </div>
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">Podium Streak</span>
            <strong class="pm-micro-val">${maxPodStreak} GP${maxPodStreak !== 1 ? 's' : ''}</strong>
          </div>
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">Fastest Laps</span>
            <strong class="pm-micro-val" style="color:#c084fc;">${fastestLapsCount}</strong>
          </div>
          <div class="pm-micro-kpi">
            <span class="pm-micro-lbl">Team Pts Share</span>
            <strong class="pm-micro-val">${teamPtsSharePct !== null ? `${teamPtsSharePct}%` : '—'}</strong>
          </div>
        </div>
      </div>
    `;
  }

  // ── Teammate Comparison ──
  const teammateStints = [];
  for (const other of driversList) {
    if (other.name_acronym === driver.name_acronym) continue;

    let sharedGPs = 0, sharedSprints = 0;
    let gpWins1 = 0, gpWins2 = 0;
    let sprWins1 = 0, sprWins2 = 0;
    let pts1 = 0, pts2 = 0;
    let raceWins1 = 0, raceWins2 = 0;
    let podiums1 = 0, podiums2 = 0;
    let dnfs1 = 0, dnfs2 = 0;
    const finishes1 = [], finishes2 = [];
    const sharedTeamsSet = new Set();
    let stintTeamColour = other.team_colour || driver.team_colour;

    for (const r1 of (driver.allResults || [])) {
      if (r1.status === 'ABSENT' || !r1.team_name || r1.team_name === 'Unknown') continue;
      const r2 = (other.allResults || []).find(
        cand => cand.session_key === r1.session_key && cand.isSprint === r1.isSprint && cand.status !== 'ABSENT'
      );
      if (!r2 || r2.team_name !== r1.team_name) continue;

      sharedTeamsSet.add(r1.team_name);
      if (r1.team_colour && r1.team_colour !== '666666') {
        stintTeamColour = r1.team_colour;
      }

      pts1 = roundPts(pts1 + (r1.points || 0));
      pts2 = roundPts(pts2 + (r2.points || 0));

      if (r1.isSprint) {
        sharedSprints++;
        if (!(r1.status === 'DNS' && r2.status === 'DNS')) {
          if (r1.position < r2.position) sprWins1++;
          else if (r2.position < r1.position) sprWins2++;
        }
      } else {
        sharedGPs++;
        if (!(r1.status === 'DNS' && r2.status === 'DNS')) {
          if (r1.position < r2.position) gpWins1++;
          else if (r2.position < r1.position) gpWins2++;
        }
        if (r1.position === 1 && r1.status === 'FINISHED') raceWins1++;
        if (r2.position === 1 && r2.status === 'FINISHED') raceWins2++;
        if (r1.position <= 3 && r1.status === 'FINISHED') podiums1++;
        if (r2.position <= 3 && r2.status === 'FINISHED') podiums2++;
        if (r1.status === 'DNF') dnfs1++;
        if (r2.status === 'DNF') dnfs2++;
        if (r1.status === 'FINISHED' || r1.status === 'DNF') finishes1.push(r1.position);
        if (r2.status === 'FINISHED' || r2.status === 'DNF') finishes2.push(r2.position);
      }
    }

    if (sharedGPs > 0 || sharedSprints > 0) {
      teammateStints.push({
        teammate: other,
        sharedGPs,
        sharedSprints,
        gpWins1,
        gpWins2,
        sprWins1,
        sprWins2,
        pts1,
        pts2,
        raceWins1,
        raceWins2,
        podiums1,
        podiums2,
        dnfs1,
        dnfs2,
        best1: finishes1.length > 0 ? `P${Math.min(...finishes1)}` : '—',
        best2: finishes2.length > 0 ? `P${Math.min(...finishes2)}` : '—',
        avg1: finishes1.length > 0 ? (finishes1.reduce((a, b) => a + b, 0) / finishes1.length).toFixed(1) : '—',
        avg2: finishes2.length > 0 ? (finishes2.reduce((a, b) => a + b, 0) / finishes2.length).toFixed(1) : '—',
        sharedTeams: Array.from(sharedTeamsSet),
        stintColor: getTeamColor(stintTeamColour)
      });
    }
  }

  teammateStints.sort((a, b) => (b.sharedGPs - a.sharedGPs) || (b.sharedSprints - a.sharedSprints) || (b.pts2 - a.pts2));

  const teammate = teammateStints.length > 0 ? teammateStints[0].teammate : null;
  const driverWins = teammateStints.reduce((sum, s) => sum + s.gpWins1, 0);
  const tmWins = teammateStints.reduce((sum, s) => sum + s.gpWins2, 0);
  const sprintDriverWins = teammateStints.reduce((sum, s) => sum + s.sprWins1, 0);
  const sprintTmWins = teammateStints.reduce((sum, s) => sum + s.sprWins2, 0);

  let teammateHtml = '';
  if (teammateStints.length === 0) {
    teammateHtml = `<div class="pm-empty-note">No shared teammate sessions recorded yet this season.</div>`;
  } else {
    const completedSeasonGPs = sessions.filter(r => r.session_name === 'Race').length;
    teammateHtml = teammateStints.map(stint => {
      const isPartialStint = teammateStints.length > 1 || stint.sharedGPs < completedSeasonGPs || hasMultipleTeams;
      const rows = [
        { label: 'Race H2H', v1: stint.gpWins1, v2: stint.gpWins2 },
      ];
      if (stint.sharedSprints > 0) {
        rows.push({ label: 'Sprint H2H', v1: stint.sprWins1, v2: stint.sprWins2 });
      }
      rows.push(
        { label: isPartialStint ? 'Shared Pts' : 'Points', v1: stint.pts1, v2: stint.pts2 },
        { label: 'GP Wins', v1: stint.raceWins1, v2: stint.raceWins2 },
        { label: 'Podiums', v1: stint.podiums1, v2: stint.podiums2 },
        { label: 'Avg Finish', v1: stint.avg1, v2: stint.avg2, lowerBetter: true },
        { label: 'Retirements', v1: stint.dnfs1, v2: stint.dnfs2, lowerBetter: true },
      );

      const badgeParts = [];
      if (hasMultipleTeams || (stint.sharedTeams.length > 0 && teammateStints.length > 1)) {
        badgeParts.push(stint.sharedTeams.join(' / '));
      }
      badgeParts.push(`${stint.sharedGPs} Shared GP${stint.sharedGPs !== 1 ? 's' : ''}`);
      const cLeft = stint.stintColor || teamColor;

      return `
        <div class="dm-duel-card" style="margin-bottom:var(--space-md);">
          <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <span>vs Teammate — <strong style="color:var(--text-primary);">${stint.teammate.full_name || stint.teammate.name_acronym}</strong></span>
            <span class="dm-stint-pill">${badgeParts.join(' · ')}</span>
          </div>
          <div class="dm-duel-header">
            <div class="dm-duel-driver">
              <img src="${driver.headshot_url || ''}" alt="${driver.name_acronym}" class="dm-duel-img" style="border-color:${cLeft};" onerror="this.style.display='none'">
              <div class="dm-duel-name" style="color:${cLeft};">${driver.name_acronym}</div>
              <span style="font-size:0.65rem;color:var(--text-muted);">Best: ${stint.best1}</span>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:5px;">
              <div class="dm-duel-vs">VS</div>
            </div>
            <button type="button" class="dm-duel-driver pm-clickable-driver" data-open-driver="${stint.teammate.name_acronym}" title="Open ${stint.teammate.name_acronym} profile">
              <img src="${stint.teammate.headshot_url || ''}" alt="${stint.teammate.name_acronym}" class="dm-duel-img" style="border-color:#94a3b8;" onerror="this.style.display='none'">
              <div class="dm-duel-name" style="color:var(--text-primary);display:inline-flex;align-items:center;gap:4px;">${stint.teammate.name_acronym} <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.58rem;opacity:0.65;"></i></div>
              <span style="font-size:0.65rem;color:var(--text-muted);">Best: ${stint.best2}</span>
            </button>
          </div>
          <div class="dm-duel-body">
            ${rows.map(row => {
              const n1 = parseFloat(row.v1);
              const n2 = parseFloat(row.v2);
              let pct1 = 50;
              if (!isNaN(n1) && !isNaN(n2) && (n1 + n2) > 0) {
                pct1 = row.lowerBetter ? (n2 / (n1 + n2)) * 100 : (n1 / (n1 + n2)) * 100;
              } else if (!isNaN(n1) && isNaN(n2)) {
                pct1 = 100;
              } else if (isNaN(n1) && !isNaN(n2)) {
                pct1 = 0;
              }
              const leftBetter = !isNaN(n1) && !isNaN(n2) && (row.lowerBetter ? n1 < n2 : n1 > n2);
              const rightBetter = !isNaN(n1) && !isNaN(n2) && (row.lowerBetter ? n2 < n1 : n2 > n1);
              return `
                <div class="dm-teammate-row" style="padding:8px 0;">
                  <div class="dm-tm-values" style="min-width:44px;justify-content:flex-start;">
                    <span class="dm-tm-val" style="color:${leftBetter ? cLeft : 'var(--text-secondary)'};font-weight:${leftBetter ? '800' : '600'};">${row.v1}</span>
                  </div>
                  <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;">
                    <div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);text-align:center;font-weight:700;">${row.label}</div>
                    <div class="dm-tm-bar">
                      <div class="dm-tm-bar-left" style="width:${pct1}%;background:${cLeft};"></div>
                      <div class="dm-tm-bar-right" style="width:${100 - pct1}%;background:#64748b;opacity:0.55;"></div>
                    </div>
                  </div>
                  <div class="dm-tm-values" style="min-width:44px;justify-content:flex-end;">
                    <span class="dm-tm-val" style="color:${rightBetter ? '#e2e8f0' : 'var(--text-muted)'};font-weight:${rightBetter ? '800' : '600'};">${row.v2}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  // ── Milestones & Achievements ──
  const milestones = [];
  const leadRounds = standings.driverLeadRounds && (standings.driverLeadRounds[driver.name_acronym] || standings.driverLeadRounds[driver.driver_number]);
  if (leadRounds && leadRounds.length > 0) {
    const roundList = formatRoundRanges(leadRounds);
    milestones.push({
      icon: '<i class="fa-solid fa-crown" style="color: #ffd700;"></i>',
      title: 'Championship Leader',
      desc: `Led the Drivers' World Championship standings for ${leadRounds.length} round${leadRounds.length > 1 ? 's' : ''} (${roundList.toLowerCase()}) this season.`
    });
  }
  if (driver.wins > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-trophy" style="color: #ffd700;"></i>',
      title: 'Winners Circle',
      desc: `Secured ${driver.wins} Grand Prix ${driver.wins === 1 ? 'victory' : 'victories'} this season.`
    });
  }
  if (polesCount > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-stopwatch" style="color: #a855f7;"></i>',
      title: polesCount >= 3 ? 'Qualifying Maestro' : 'Pole Sitter',
      desc: `Claimed ${polesCount} Grand Prix Pole Position${polesCount > 1 ? 's' : ''}${frontRowCount > polesCount ? ` and ${frontRowCount} front-row starts` : ''}.`
    });
  }
  if (fastestLapsCount > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-bolt" style="color: #ffd000;"></i>',
      title: 'Speed Demon',
      desc: `Set the official fastest lap in ${fastestLapsCount} Grand Prix race${fastestLapsCount > 1 ? 's' : ''}.`
    });
  }
  if (teammate && driverWins > tmWins) {
    milestones.push({
      icon: '<i class="fa-solid fa-chess-knight" style="color: var(--f1-red);"></i>',
      title: 'Teammate Dominator',
      desc: `Outperformed primary teammate in Grand Prix H2H (${driverWins}–${tmWins}).`
    });
  }
  if (driver.sprintWins > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-gauge-high" style="color: var(--f1-red);"></i>',
      title: 'Sprint Master',
      desc: `Claimed P1 in ${driver.sprintWins} Sprint race${driver.sprintWins > 1 ? 's' : ''} this season.`
    });
  }
  if (driver.sprintPodiums >= 3) {
    milestones.push({
      icon: '<i class="fa-solid fa-angles-up" style="color: #ffd700;"></i>',
      title: 'Sprint Podium Regular',
      desc: `Finished on the Sprint podium ${driver.sprintPodiums} times this season.`
    });
  } else if (driver.sprintPodiums > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-award" style="color: #c0c0c0;"></i>',
      title: 'Sprint Podium Finisher',
      desc: `Finished in the top 3 of a Sprint race ${driver.sprintPodiums} time${driver.sprintPodiums > 1 ? 's' : ''}.`
    });
  }
  if (hasSprints && teammate && sprintDriverWins > sprintTmWins) {
    milestones.push({
      icon: '<i class="fa-solid fa-crown" style="color: var(--f1-red);"></i>',
      title: 'Sprint Dominator',
      desc: `Outperformed teammate in Sprint H2H (${sprintDriverWins}–${sprintTmWins}).`
    });
  }
  if (pointsRate >= 85) {
    milestones.push({
      icon: '<i class="fa-solid fa-chart-line" style="color: #39b54a;"></i>',
      title: 'Points Machine',
      desc: `High-density scorer, finishing in the points in ${pointsRate}% of GP starts${maxPtsStreak >= 5 ? ` (${maxPtsStreak}-race streak)` : ''}.`
    });
  } else if (pointsRate >= 50) {
    milestones.push({
      icon: '<i class="fa-solid fa-bullseye" style="color: #ffd000;"></i>',
      title: 'Regular Scorer',
      desc: `Consistently in the mix, scoring points in ${pointsRate}% of Grand Prix starts.`
    });
  }
  if (driver.podiums >= 3) {
    milestones.push({
      icon: '<i class="fa-solid fa-award" style="color: #ffd700;"></i>',
      title: 'Podium Regular',
      desc: `Stood on the Grand Prix podium ${driver.podiums} times this season.`
    });
  } else if (driver.podiums > 0) {
    milestones.push({
      icon: '<i class="fa-solid fa-medal" style="color: #c0c0c0;"></i>',
      title: 'Podium Finisher',
      desc: `Claimed a GP top-3 podium finish ${driver.podiums} time${driver.podiums > 1 ? 's' : ''}.`
    });
  }
  const completedRacesCount = sessions.filter(r => r.session_name === 'Race').length;
  const dnfCount = driver.dnfs || 0;
  if (completedRacesCount > 0 && dnfCount === 0 && rr.length === completedRacesCount) {
    milestones.push({
      icon: '<i class="fa-solid fa-flag-checkered" style="color: #39b54a;"></i>',
      title: 'Iron Man',
      desc: `Classified in 100% of all GP races this season (${rr.length}/${completedRacesCount}) with zero retirements.`
    });
  }

  const milestonesHtml = milestones.length > 0 ? `
    <div class="dm-section-title" style="margin-top:var(--space-lg);">Season Achievements (${milestones.length})</div>
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

  // ── Helper to build Skyline Bar Charts ──
  const buildResultsSkyline = (resultsArr, isSprintMode = false) => {
    if (!resultsArr || resultsArr.length === 0) return '';
    const maxPos = Math.max(20, ...resultsArr.map(r => r.position || 20));
    const ptsCutoff = isSprintMode ? 8 : 10;
    const bars = resultsArr.map((r, i) => {
      const s = sessionMap.get(r.session_key);
      const label = s ? s.circuit_short_name : `${isSprintMode ? 'S' : 'R'}${i + 1}`;
      const shortLabel = label.length > 4 ? label.substring(0, 3) : label;
      const status = r.status || 'FINISHED';
      const isDNF = status === 'DNF';
      const isDNS = status === 'DNS';
      const isDSQ = status === 'DSQ';
      const heightPct = (isDNS || isDSQ || isDNF) ? 8 : Math.max(6, ((maxPos - r.position + 1) / maxPos) * 100);
      const entryColor = (r.team_colour && r.team_colour !== '666666') ? getTeamColor(r.team_colour) : teamColor;
      const barColor = isDNS ? 'rgba(156, 163, 175, 0.2)'
        : isDSQ ? 'rgba(239, 68, 68, 0.6)'
          : isDNF ? 'rgba(239, 68, 68, 0.4)'
            : r.position === 1 ? '#ffd700'
              : r.position <= 3 ? entryColor
                : r.position <= ptsCutoff ? entryColor + '99'
                  : 'var(--bg-tertiary)';
      const posText = isDNS ? 'DNS' : isDSQ ? 'DSQ' : isDNF ? 'DNF' : `P${r.position}`;
      const teamSuffix = (hasMultipleTeams && r.team_name && r.team_name !== 'Unknown') ? ` (${r.team_name})` : '';
      const titleText = `${label}${teamSuffix}: ${posText}${r.points ? ` (+${r.points} pts)` : ''}`;
      const barStyle = isDNS ? 'border: 1px dashed var(--text-muted); border-bottom: none;'
        : isDSQ ? 'border: 1px solid var(--f1-red); border-bottom: none;'
          : isDNF ? 'border: 1px dashed var(--f1-red); border-bottom: none;'
            : '';

      return `
        <div class="dm-race-bar-wrap" title="${titleText}">
          <div class="dm-race-pos" style="${(isDNF || isDNS || isDSQ) ? 'color: var(--f1-red); font-weight: 700; font-size: 0.62rem;' : ''}">${posText}</div>
          <div class="dm-race-bar" style="height:${heightPct}%;background:${barColor};border-radius:3px 3px 0 0;${barStyle}"></div>
          <div class="dm-race-bar-label">${shortLabel}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="dm-section-title">${isSprintMode ? 'Sprint Finishes Skyline' : 'Grand Prix Finishes Skyline'}</div>
      <div class="dm-races-chart">${bars}</div>
    `;
  };

  const raceBarHtml = buildResultsSkyline(visibleRaceResults, false);
  const sprintBarHtml = buildResultsSkyline(visibleSprintResults, true);

  // Qualifying Skyline Bar Chart
  let qualiBarHtml = '';
  if (totalQuali > 0) {
    const maxQ = Math.max(20, ...qr);
    const qBars = qr.map((pos, idx) => {
      const heightPct = Math.max(8, ((maxQ - pos + 1) / maxQ) * 100);
      const barColor = pos === 1 ? '#ffd700'
        : pos <= 3 ? '#a855f7'
          : pos <= 10 ? 'rgba(168, 85, 247, 0.65)'
            : pos <= seasonQ2Cutoff ? 'rgba(56, 189, 248, 0.55)'
              : 'var(--bg-tertiary)';
      return `
        <div class="dm-race-bar-wrap" title="Qualifying #${idx + 1}: P${pos}">
          <div class="dm-race-pos" style="${pos === 1 ? 'color:#ffd700;font-weight:800;' : ''}">P${pos}</div>
          <div class="dm-race-bar" style="height:${heightPct}%;background:${barColor};border-radius:3px 3px 0 0;"></div>
          <div class="dm-race-bar-label">Q${idx + 1}</div>
        </div>
      `;
    }).join('');
    qualiBarHtml = `
      <div class="dm-section-title">Qualifying Grid Positions (${totalQuali} Sessions)</div>
      <div class="dm-races-chart">${qBars}</div>
    `;
  }

  // Qualifying Tier Breakdown
  let qualiTierHtml = '';
  if (totalQuali > 0) {
    const qSegs = [
      { label: 'Pole (P1)', count: polesCount, color: '#ffd700' },
      { label: 'P2–P3', count: top3QualiCount - polesCount, color: '#c084fc' },
      { label: 'Q3 (P4–P10)', count: Math.max(0, q3Count - top3QualiCount), color: '#8b5cf6' },
      { label: `Q2 (P11–P${seasonQ2Cutoff})`, count: q2OutCount, color: '#38bdf8' },
      { label: `Q1 (P${seasonQ2Cutoff + 1}+)`, count: q1OutCount, color: 'rgba(148,163,184,0.45)' },
    ];
    qualiTierHtml = `
      <div class="pm-card-box" style="margin-top:var(--space-md);">
        <div class="pm-card-box-hdr">
          <span><i class="fa-solid fa-layer-group" style="color:#a855f7;margin-right:6px;"></i>Qualifying Session Elimination Breakdown</span>
          <span class="pm-subtle-tag">Front Rows: ${frontRowCount}</span>
        </div>
        <div class="pm-stacked-bar">
          ${qSegs.filter(s => s.count > 0).map(s => `
            <div class="pm-stacked-seg" style="width:${(s.count / totalQuali) * 100}%;background:${s.color};" title="${s.label}: ${s.count}"></div>
          `).join('')}
        </div>
        <div class="pm-dist-legend">
          ${qSegs.map(s => `
            <div class="pm-dist-item">
              <span class="pm-dist-dot" style="background:${s.color};"></span>
              <span class="pm-dist-lbl">${s.label}</span>
              <strong class="pm-dist-val">${s.count}</strong>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Points Progression Sparkline
  const pointsChartHtml = rr.length > 1 ? `
    <div class="dm-section-title">Cumulative Points Progression</div>
    <div class="dm-chart-wrap">
      <canvas class="dm-chart-canvas" id="dm-points-chart"></canvas>
    </div>
  ` : '';

  // Consistency Gauge
  let consistencyHtml = '';
  if (rr.length >= 2) {
    const gaugeColor = consistencyScore >= 70 ? '#39b54a' : consistencyScore >= 40 ? '#ffd000' : '#ff3333';
    consistencyHtml = `
      <div class="dm-section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Finish Consistency</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:var(--text-muted);text-transform:none;">Spread: ${finishStdDev}</span>
      </div>
      <div class="dm-consistency-wrap">
        <div class="dm-consistency-label">${consistencyLabel}</div>
        <div class="dm-consistency-bar">
          <div class="dm-consistency-fill" style="width:${consistencyScore}%;background:${gaugeColor}"></div>
        </div>
        <div class="dm-consistency-score" style="color:${gaugeColor}">${consistencyScore}%</div>
      </div>
    `;
  }

  // ── Mathematical Championship Outlook ──
  const pointsGap = champPos > 1 && driversList[0]
    ? roundPts(driversList[0].points - driver.points)
    : 0;

  let championshipOutlookHtml = '';
  const maxRemDriverPts = standings.maxRemainingDriverPoints || 0;
  if (!standings.isFinished && !standings.isPreliminary && maxRemDriverPts > 0 && champPos > 0) {
    const bestPos = driver.bestPos ?? champPos;
    const worstPos = driver.worstPos ?? champPos;
    const maxPossiblePts = driver.maxPossiblePoints ?? roundPts(driver.points + maxRemDriverPts);
    const canGain = Math.max(0, champPos - bestPos);
    const canLose = Math.max(0, worstPos - champPos);
    const totalGrid = Math.max(driversList.length, 2);

    const startPct = ((bestPos - 1) / (totalGrid - 1)) * 100;
    const endPct = ((worstPos - 1) / (totalGrid - 1)) * 100;
    const currPct = ((champPos - 1) / (totalGrid - 1)) * 100;
    const spanWidthPct = Math.max(2, endPct - startPct);

    const remGPs = standings.remainingGPs || 0;
    const remSprints = standings.remainingSprints || 0;
    const evParts = [];
    if (remGPs > 0) evParts.push(`${remGPs} GP${remGPs !== 1 ? 's' : ''}`);
    if (remSprints > 0) evParts.push(`${remSprints} Sprint${remSprints !== 1 ? 's' : ''}`);
    const sc = standings.scoringInfo || {};
    const ruleNotes = [];
    if (remGPs > 0) ruleNotes.push(`${sc.maxPointsPerGP || 25}/GP${sc.awardFastestLap ? ' incl. FL' : ''}`);
    if (remSprints > 0 && (sc.maxSprintPoints || 0) > 0) ruleNotes.push(`${sc.maxSprintPoints}/Sprint`);
    if (sc.doublePointsFinal) ruleNotes.push('2× Finale');

    let statusTagHtml = '';
    if (bestPos === 1 && worstPos === 1) {
      statusTagHtml = `<span class="outlook-status-tag clinched"><i class="fa-solid fa-crown"></i> Title Clinched</span>`;
    } else if (bestPos === worstPos) {
      statusTagHtml = `<span class="outlook-status-tag locked"><i class="fa-solid fa-lock"></i> Locked at P${bestPos}</span>`;
    } else if (bestPos === 1) {
      statusTagHtml = `<span class="outlook-status-tag contender"><i class="fa-solid fa-trophy"></i> In Title Contention</span>`;
    } else {
      statusTagHtml = `<span class="outlook-status-tag neutral">Ceiling: P${bestPos}</span>`;
    }

    const rivalItems = [];
    if (canGain > 0 && champPos > 1) {
      const nextAhead = driversList[champPos - 2];
      if (nextAhead) {
        const gapAhead = roundPts(nextAhead.points - driver.points);
        rivalItems.push(`<div class="outlook-rival-row"><span class="outlook-rival-label"><i class="fa-solid fa-arrow-up" style="color:#2ecc71;"></i> Next ahead:</span> <span class="outlook-rival-val"><strong>P${champPos - 1} ${nextAhead.name_acronym}</strong> (${gapAhead === 0 ? 'tied' : `+${gapAhead} pts`})</span></div>`);
      }
      if (bestPos < champPos - 1) {
        const topTarget = driversList[bestPos - 1];
        if (topTarget) {
          const gapTop = roundPts(topTarget.points - driver.points);
          rivalItems.push(`<div class="outlook-rival-row"><span class="outlook-rival-label"><i class="fa-solid fa-bullseye" style="color:#ffd700;"></i> Highest reach:</span> <span class="outlook-rival-val"><strong>P${bestPos} ${topTarget.name_acronym}</strong> (+${gapTop} pts)</span></div>`);
        }
      }
    }

    if (canLose > 0 && champPos < driversList.length) {
      const threats = [];
      for (let k = champPos; k < driversList.length; k++) {
        const ch = driversList[k];
        const chMax = ch.maxPossiblePoints ?? (ch.points + maxRemDriverPts);
        if (chMax >= driver.points) {
          const gapBehind = roundPts(driver.points - ch.points);
          threats.push({ pos: k + 1, acronym: ch.name_acronym, gap: gapBehind });
        }
      }
      if (threats.length > 0) {
        const preview = threats.slice(0, 3)
          .map(t => `<strong>P${t.pos} ${t.acronym}</strong> (${t.gap === 0 ? 'tied' : `−${t.gap} pts`})`)
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
            <div class="champ-outlook-pts-ceil">${driver.points} <span style="color:var(--text-muted);font-weight:500;">→</span> <strong>${maxPossiblePts}</strong> <span style="font-size:0.72rem;color:var(--text-muted);">pts max</span></div>
            <div class="champ-outlook-pts-meta">${evParts.join(' + ')} left · +${maxRemDriverPts} max (${ruleNotes.join(' · ')})</div>
          </div>
        </div>
        <div class="champ-outlook-spectrum">
          <span class="spectrum-bound">P1</span>
          <div class="spectrum-track">
            <div class="spectrum-fill" style="left:${startPct}%;width:${spanWidthPct}%;background:${rangeAccent};"></div>
            <div class="spectrum-marker" style="left:${currPct}%;border-color:${rangeAccent};" title="Current Position: P${champPos}"></div>
          </div>
          <span class="spectrum-bound">P${totalGrid}</span>
        </div>
        ${rivalItems.length > 0 ? `<div class="champ-outlook-rivals">${rivalItems.join('')}</div>` : ''}
      </div>
    `;
  }

  // ── Build Round-by-Round Race Log Table ──
  const meetingsOrder = [];
  const meetingMap = new Map();
  const sortedSessions = [...sessions].sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
  for (const s of sortedSessions) {
    const mKey = s.meeting_key || s.session_key;
    if (!meetingMap.has(mKey)) {
      const mObj = {
        meeting_key: mKey,
        circuit: s.circuit_short_name || s.country_name || 'Grand Prix',
        country: s.country_name || '',
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

  let runningCumPts = 0;
  const logRows = [];
  meetingsOrder.forEach((m, idx) => {
    const gpRes = m.raceSession
      ? (driver.allResults || []).find(r => r.session_key === m.raceSession.session_key && !r.isSprint)
      : null;
    const spRes = m.sprintSession
      ? (driver.allResults || []).find(r => r.session_key === m.sprintSession.session_key && r.isSprint)
      : null;

    const gpAbsent = !gpRes || gpRes.status === 'ABSENT';
    const spAbsent = !spRes || spRes.status === 'ABSENT';
    if (gpAbsent && spAbsent) return;

    const wkPts = roundPts((!gpAbsent ? (gpRes.points || 0) : 0) + (!spAbsent ? (spRes.points || 0) : 0));
    runningCumPts = roundPts(runningCumPts + wkPts);

    const rowTeamName = (!gpAbsent && gpRes.team_name && gpRes.team_name !== 'Unknown')
      ? gpRes.team_name
      : (!spAbsent && spRes.team_name && spRes.team_name !== 'Unknown' ? spRes.team_name : driver.team_name);
    const rowTeamCol = (!gpAbsent && gpRes.team_colour && gpRes.team_colour !== '666666')
      ? getTeamColor(gpRes.team_colour)
      : teamColor;

    const formatResBadge = (res, isSpr = false) => {
      if (!res || res.status === 'ABSENT') return '<span style="color:var(--text-muted);">—</span>';
      const st = res.status || 'FINISHED';
      if (st !== 'FINISHED') return `<span class="pm-pos-pill pm-pos-dnf">${st}</span>`;
      const flIcon = (!isSpr && m.raceSession && fastestLapSessionKeys.has(m.raceSession.session_key))
        ? ' <i class="fa-solid fa-bolt" style="color:#c084fc;font-size:0.65rem;" title="Fastest Lap"></i>'
        : '';
      const cls = res.position === 1 ? 'pm-pos-p1'
        : res.position === 2 ? 'pm-pos-p2'
          : res.position === 3 ? 'pm-pos-p3'
            : res.position <= (isSpr ? 8 : 10) ? 'pm-pos-pts'
              : 'pm-pos-out';
      return `<span class="pm-pos-pill ${cls}">P${res.position}</span>${flIcon}`;
    };

    logRows.push(`
      <tr>
        <td class="pm-td-mono" style="color:var(--text-muted);">R${idx + 1}</td>
        <td>
          <div style="font-weight:700;color:var(--text-primary);">${m.circuit}</div>
          ${hasMultipleTeams ? `<div style="font-size:0.65rem;color:${rowTeamCol};font-weight:600;">${rowTeamName}</div>` : ''}
        </td>
        ${hasSprints ? `<td style="text-align:center;">${m.sprintSession ? formatResBadge(spRes, true) : '<span style="color:var(--text-muted);opacity:0.4;">·</span>'}</td>` : ''}
        <td style="text-align:center;">${formatResBadge(gpRes, false)}</td>
        <td class="pm-td-mono" style="text-align:right;font-weight:700;color:${wkPts > 0 ? '#2ecc71' : 'var(--text-muted)'};">${wkPts > 0 ? `+${wkPts}` : '0'}</td>
        <td class="pm-td-mono" style="text-align:right;color:var(--text-secondary);font-weight:600;">${runningCumPts}</td>
      </tr>
    `);
  });

  const raceLogTabHtml = logRows.length > 0 ? `
    <div class="pm-table-wrap custom-scrollbar">
      <table class="pm-data-table">
        <thead>
          <tr>
            <th>Rnd</th>
            <th>Grand Prix</th>
            ${hasSprints ? '<th style="text-align:center;">Sprint</th>' : ''}
            <th style="text-align:center;">GP Finish</th>
            <th style="text-align:right;">Pts</th>
            <th style="text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${logRows.join('')}
        </tbody>
      </table>
    </div>
  ` : `<div class="pm-empty-note">No completed race entries recorded for this driver yet.</div>`;

  // ── Header & Tabs Assembly ──
  const nat = DRIVER_NATIONALITY[driver.name_acronym] || { country: 'International' };
  const flagInfo = DRIVER_NATIONALITY[driver.name_acronym?.toUpperCase()];
  const flagBgUrl = flagInfo?.code ? `https://flagcdn.com/w320/${flagInfo.code}.png` : '';
  const flagHtml = getDriverFlagImg(driver.name_acronym, 'width:18px;border-radius:2px;');
  const isPinnedFav = isFavoriteDriver(driver.name_acronym);

  const teamChipsHtml = hasMultipleTeams
    ? driverTeams.map(t => {
        const tc = getTeamColor(t.team_colour);
        const canOpen = (standings?.constructors || []).some(c => c.team_name === t.team_name);
        return canOpen
          ? `<button type="button" class="pm-team-link-chip" data-open-team="${t.team_name}" style="--chip-col:${tc};">${t.team_name}</button>`
          : `<span style="color:${tc};font-weight:700;">${t.team_name}</span>`;
      }).join(' <span style="color:var(--text-muted);font-size:0.72rem;">→</span> ')
    : (linkedConstructor
        ? `<button type="button" class="pm-team-link-chip" data-open-team="${driver.team_name}" style="--chip-col:${teamColor};" title="Open ${driver.team_name} Constructor Profile">
            <span class="pm-team-dot" style="background:${teamColor};"></span>
            <span>${driver.team_name}</span>
            <i class="fa-solid fa-chevron-right" style="font-size:0.58rem;opacity:0.7;"></i>
          </button>`
        : `<span style="color:${teamColor};font-weight:700;text-transform:uppercase;font-size:0.8rem;">${driver.team_name}</span>`);

  // Tab navigation
  const tabSelectorHtml = `
    <div class="dm-tabs pm-segmented-tabs" role="tablist">
      <button type="button" class="dm-tab active" data-tab="overview"><i class="fa-solid fa-gauge-high"></i> Overview</button>
      <button type="button" class="dm-tab" data-tab="qualifying"><i class="fa-solid fa-stopwatch"></i> Qualifying</button>
      ${hasSprints ? `<button type="button" class="dm-tab" data-tab="sprint"><i class="fa-solid fa-bolt"></i> Sprint</button>` : ''}
      <button type="button" class="dm-tab" data-tab="duel"><i class="fa-solid fa-people-arrows"></i> H2H & Badges</button>
      <button type="button" class="dm-tab" data-tab="racelog"><i class="fa-solid fa-table-list"></i> Race Log (${logRows.length})</button>
    </div>
  `;

  // Overview Tab
  const overviewContentHtml = `
    <div id="dm-content-overview" class="dm-tab-content active">
      ${championBannerHtml}
      ${championshipOutlookHtml}
      ${recentFormHtml}

      <div class="dm-stats-grid" style="margin-bottom:var(--space-sm);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${champPos <= 3 ? teamColor : 'var(--text-primary)'}">P${champPos}</div>
          <div class="dm-stat-label">${pointsGap > 0 ? `−${pointsGap} to P1` : 'Leader'}</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${driver.points}</div>
          <div class="dm-stat-label">${hasSprints ? `${gpPoints} GP + ${sprintPoints} Spr` : 'Total Points'}</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${driver.wins > 0 ? '#ffd700' : 'var(--text-primary)'}">${driver.wins}</div>
          <div class="dm-stat-label">GP Wins</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${driver.podiums}</div>
          <div class="dm-stat-label">GP Podiums</div>
        </div>
      </div>

      <div class="dm-stats-grid" style="margin-bottom:var(--space-md);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${avgFinish}</div>
          <div class="dm-stat-label">Avg Finish</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">${bestFinish !== '—' ? `P${bestFinish}` : '—'}</div>
          <div class="dm-stat-label">Best${worstFinish !== '—' ? ` (Low P${worstFinish})` : ' Finish'}</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${pointsPerRace}</div>
          <div class="dm-stat-label">Pts / GP</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${pointsRate}%</div>
          <div class="dm-stat-label">Top-10 Rate</div>
        </div>
      </div>

      ${distributionHtml}
      ${raceBarHtml}
      ${pointsChartHtml}
      ${consistencyHtml}
    </div>
  `;

  // Qualifying Tab
  const qualifyingContentHtml = `
    <div id="dm-content-qualifying" class="dm-tab-content">
      <div class="dm-stats-grid" style="margin-bottom:var(--space-sm);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">${polesCount}</div>
          <div class="dm-stat-label">Poles (P1)</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#c084fc">${frontRowCount}</div>
          <div class="dm-stat-label">Front Rows</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#a855f7">${q3Count}<span style="font-size:0.75rem;font-weight:500;color:var(--text-muted);">/${totalQuali}</span></div>
          <div class="dm-stat-label">Q3 Reached</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#38bdf8">${q3Rate}%</div>
          <div class="dm-stat-label">Q3 Rate</div>
        </div>
      </div>

      <div class="dm-stats-grid" style="margin-bottom:var(--space-md);">
        <div class="dm-stat-tile">
          <div class="dm-stat-value">${avgQuali}</div>
          <div class="dm-stat-label">Avg Grid Pos</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:#ffd700">${bestQuali !== '—' ? `P${bestQuali}` : '—'}</div>
          <div class="dm-stat-label">Best Quali</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:var(--text-secondary)">${worstQuali !== '—' ? `P${worstQuali}` : '—'}</div>
          <div class="dm-stat-label">Lowest Grid</div>
        </div>
        <div class="dm-stat-tile">
          <div class="dm-stat-value" style="color:${racecraftColor}">${racecraftVal}</div>
          <div class="dm-stat-label">${racecraftSub}</div>
        </div>
      </div>

      ${qualiTierHtml}
      ${qualiBarHtml || '<div class="pm-empty-note">No qualifying telemetry compiled for this season yet.</div>'}
    </div>
  `;

  // Sprint Tab
  let sprintContentHtml = '';
  if (hasSprints) {
    const sprintGaugeColor = sprintConsistencyScore >= 70 ? '#39b54a' : sprintConsistencyScore >= 40 ? '#ffd000' : '#ff3333';
    sprintContentHtml = `
      <div id="dm-content-sprint" class="dm-tab-content">
        <div class="dm-stats-grid" style="margin-bottom:var(--space-sm);">
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${sprintPoints}</div>
            <div class="dm-stat-label">Sprint Points</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#ffd700">${driver.sprintWins || 0}</div>
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

        <div class="dm-stats-grid" style="margin-bottom:var(--space-md);">
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${avgSprintFinish}</div>
            <div class="dm-stat-label">Avg Finish</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#ffd700">${bestSprintFinish !== '—' ? `P${bestSprintFinish}` : '—'}</div>
            <div class="dm-stat-label">Best Finish</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${pointsPerSprint}</div>
            <div class="dm-stat-label">Pts / Sprint</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${sprintPointsRate}%</div>
            <div class="dm-stat-label">Top-8 Rate</div>
          </div>
        </div>

        <div class="dm-section-title" style="margin-top:var(--space-md);">Sprint Qualifying (Shootout)</div>
        <div class="dm-stats-grid" style="margin-bottom:var(--space-md);">
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#ffd700">${sprintPolesCount}</div>
            <div class="dm-stat-label">SQ Poles</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#a855f7">${sprintQ3Count}<span style="font-size:0.75rem;color:var(--text-muted);">/${totalSprintQuali}</span></div>
            <div class="dm-stat-label">SQ3 Reached</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value" style="color:#38bdf8">${sprintQ3Rate}%</div>
            <div class="dm-stat-label">SQ3 Rate</div>
          </div>
          <div class="dm-stat-tile">
            <div class="dm-stat-value">${avgSprintQuali}${bestSprintQuali !== '—' ? ` <span style="font-size:0.68rem;color:var(--text-muted);">(P${bestSprintQuali})</span>` : ''}</div>
            <div class="dm-stat-label">Avg Grid (Best)</div>
          </div>
        </div>

        ${sprintBarHtml}

        ${sprintRr.length >= 2 ? `
          <div class="dm-section-title">Sprint Consistency</div>
          <div class="dm-consistency-wrap">
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

  // Duel & Badges Tab
  const duelContentHtml = `
    <div id="dm-content-duel" class="dm-tab-content">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:var(--space-md);">
        <div class="dm-section-title" style="margin:0;">Intra-Team Teammate Comparison</div>
        <button type="button" class="pm-action-chip" id="dm-jump-h2h">
          <i class="fa-solid fa-people-arrows"></i> Open Full H2H Arena
        </button>
      </div>
      ${teammateHtml}
      ${milestonesHtml}
    </div>
  `;

  // Race Log Tab
  const raceLogContentHtml = `
    <div id="dm-content-racelog" class="dm-tab-content">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:var(--space-sm);">
        <div class="dm-section-title" style="margin:0;">${standings.year || ''} Season Weekend Log</div>
        <span class="pm-subtle-tag">${visibleRaceResults.length} GP Starts${hasSprints ? ` · ${visibleSprintResults.length} Sprints` : ''}</span>
      </div>
      ${raceLogTabHtml}
    </div>
  `;

  const rankBadgeClass = champPos === 1 ? 'pm-rank-p1' : champPos === 2 ? 'pm-rank-p2' : champPos === 3 ? 'pm-rank-p3' : '';

  modal.innerHTML = `
    <div class="pm-topbar">
      <div class="pm-nav-group">
        <button type="button" class="pm-nav-btn" id="dm-prev-driver" ${!prevDriver ? 'disabled' : ''} title="${prevDriver ? `Previous: P${champPos - 1} ${prevDriver.name_acronym} (←)` : 'First in standings'}">
          <i class="fa-solid fa-chevron-left"></i>
          <span>${prevDriver ? `P${champPos - 1} ${prevDriver.name_acronym}` : 'Prev'}</span>
        </button>
        <span class="pm-nav-indicator">${standings.year || ''} · P${champPos}/${driversList.length || 1}</span>
        <button type="button" class="pm-nav-btn" id="dm-next-driver" ${!nextDriver ? 'disabled' : ''} title="${nextDriver ? `Next: P${champPos + 1} ${nextDriver.name_acronym} (→)` : 'Last in standings'}">
          <span>${nextDriver ? `P${champPos + 1} ${nextDriver.name_acronym}` : 'Next'}</span>
          <i class="fa-solid fa-chevron-right"></i>
        </button>
      </div>
      <button class="driver-modal-close pm-inline-close" id="dm-close" aria-label="Close">✕</button>
    </div>

    <div class="dm-header pm-hero-header" style="--dm-team-color:${teamColor};color:${teamColor}">
      <div class="pm-hero-accent" style="background:${teamColor};"></div>
      ${flagBgUrl ? `<img class="dm-header-flag-bg" src="${flagBgUrl}" alt="" aria-hidden="true">` : ''}
      <div class="pm-avatar-wrap">
        <img class="dm-headshot" src="${driver.headshot_url || ''}" alt="${driver.name_acronym}"
             onerror="this.style.display='none'" style="border-color:${teamColor}">
        <span class="pm-avatar-rank ${rankBadgeClass}" style="${champPos > 3 ? `border-color:${teamColor};color:${teamColor};` : ''}">P${champPos}</span>
      </div>
      <div class="dm-header-info">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="pm-num-pill" style="color:${teamColor};border-color:${teamColor}44;">#${driver.driver_number || '—'}</span>
          <span style="display:inline-flex;align-items:center;gap:5px;font-size:0.75rem;color:var(--text-secondary);font-weight:600;">${flagHtml}<span>${nat.country}</span></span>
        </div>
        <div class="dm-driver-name" style="color:var(--text-primary);margin-top:4px;">${driver.full_name || driver.name_acronym}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;">
          ${teamChipsHtml}
          <button type="button" class="modal-fav-pin-btn ${isPinnedFav ? 'active' : ''}" id="dm-fav-pin-btn">
            <i class="fa-${isPinnedFav ? 'solid' : 'regular'} fa-star"></i>
            <span>${isPinnedFav ? 'Pinned' : 'Pin Driver'}</span>
          </button>
        </div>
      </div>
      <div class="dm-driver-number" aria-hidden="true">${driver.driver_number || ''}</div>
    </div>

    <div class="dm-body">
      ${tabSelectorHtml}
      ${overviewContentHtml}
      ${qualifyingContentHtml}
      ${sprintContentHtml}
      ${duelContentHtml}
      ${raceLogContentHtml}
    </div>
  `;

  // ── Event Bindings ──
  document.getElementById('dm-close')?.addEventListener('click', closeModal);

  document.getElementById('dm-prev-driver')?.addEventListener('click', () => {
    if (prevDriver) showDriverProfile(prevDriver, standings, sessions);
  });
  document.getElementById('dm-next-driver')?.addEventListener('click', () => {
    if (nextDriver) showDriverProfile(nextDriver, standings, sessions);
  });

  const favPinBtn = document.getElementById('dm-fav-pin-btn');
  if (favPinBtn) {
    favPinBtn.addEventListener('click', () => {
      const nowPinned = toggleFavoriteDriver(driver.name_acronym);
      favPinBtn.classList.toggle('active', nowPinned);
      favPinBtn.innerHTML = `<i class="fa-${nowPinned ? 'solid' : 'regular'} fa-star"></i><span>${nowPinned ? 'Pinned' : 'Pin Driver'}</span>`;
    });
  }

  // Clickable Constructor Team chip(s) -> open Team Profile
  modal.querySelectorAll('[data-open-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tName = btn.getAttribute('data-open-team');
      const targetTeam = (standings?.constructors || []).find(c => c.team_name === tName);
      if (targetTeam) {
        modal.scrollTop = 0;
        showTeamProfile(targetTeam, standings);
      }
    });
  });

  // Clickable Teammate card -> open Teammate's Driver Profile
  modal.querySelectorAll('[data-open-driver]').forEach(btn => {
    btn.addEventListener('click', () => {
      const acr = btn.getAttribute('data-open-driver');
      const targetDriver = driversList.find(d => d.name_acronym === acr);
      if (targetDriver) {
        modal.scrollTop = 0;
        showDriverProfile(targetDriver, standings, sessions);
      }
    });
  });

  // Jump to H2H Arena
  document.getElementById('dm-jump-h2h')?.addEventListener('click', () => {
    closeModal();
    window.location.hash = '#h2h';
  });

  // Helper to draw sparkline safely
  const renderPointsChart = () => {
    if (rr.length <= 1) return;
    const canvas = document.getElementById('dm-points-chart');
    if (!canvas) return;
    let cumulative = [];
    if (driver.pointsHistory && driver.pointsHistory.length > 0) {
      cumulative = driver.pointsHistory;
    } else {
      let sum = 0;
      for (const pos of rr) {
        sum += getPointsForPosition(pos);
        cumulative.push(sum);
      }
    }
    drawSparkline(canvas, cumulative, teamColor, true);
  };

  // Segmented Tab Switching
  const tabs = modal.querySelectorAll('.dm-tab');
  const contents = modal.querySelectorAll('.dm-tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      contents.forEach(c => c.classList.toggle('active', c.id === `dm-content-${target}`));
      if (target === 'overview') {
        requestAnimationFrame(renderPointsChart);
      }
    });
  });

  // Open modal & draw initial sparkline
  document.body.style.overflow = 'hidden';
  modal.scrollTop = 0;
  requestAnimationFrame(() => {
    activeOverlay.classList.add('open');
    renderPointsChart();
  });
}
