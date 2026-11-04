// =============================================
// PITCORNER — Season Command Center Dashboard
// Uses compiled season data (shared)
// =============================================

import { getMeetings, getOvertakes } from './api.js';
import { getSeasonData, computeStandingsFromSeason } from './season-data.js';
import { isPast, isThisWeek, formatDateRange, formatLapTime, getTeamColor, $ } from './utils.js';
import { drawLineChart } from './charts.js';
import { showFutureRaceSchedule } from './race-detail.js';
import { showDriverProfile } from './driver-profile.js';
import { showTeamProfile } from './team-profile.js';
import { setStandingsView } from './standings.js';
import { selectCalendarMeeting } from './calendar.js';
import { getFavorites, isFavoriteDriver, isFavoriteTeam, openFavoritesModal } from './favorites.js';

let dashboardCountdownInterval = null;
let quickLinksWired = false;
let favoritesListenerWired = false;
let lastDashboardRenderCtx = null;

function renderCommandFavorites(ctx) {
  const strip = document.getElementById('cmd-favorites-strip');
  if (!strip || !ctx || !ctx.standings) return;

  const { standings, lastCompiledRace, gps, year } = ctx;
  const fav = getFavorites();
  const hasFav = Boolean(fav.driver || fav.team);

  strip.style.display = 'block';

  if (!hasFav) {
    strip.innerHTML = `
      <div class="cmd-fav-prompt">
        <div class="cmd-fav-prompt-left">
          <span class="cmd-fav-prompt-icon"><i class="fa-regular fa-star"></i></span>
          <span><strong>Personalize PitCorner:</strong> Pin your Favorite Driver &amp; Constructor for live spotlight telemetry across all tabs.</span>
        </div>
        <button type="button" class="cmd-fav-manage-btn" id="cmd-open-fav-picker">
          <i class="fa-solid fa-thumbtack"></i> Pin Favorites
        </button>
      </div>
    `;
    document.getElementById('cmd-open-fav-picker')?.addEventListener('click', () => openFavoritesModal(year));
    return;
  }

  const cards = [];

  if (fav.driver) {
    const dIdx = (standings.drivers || []).findIndex(d => isFavoriteDriver(d.name_acronym));
    if (dIdx !== -1) {
      const d = standings.drivers[dIdx];
      const pos = dIdx + 1;
      const leaderPts = standings.drivers[0]?.points || 0;
      const color = getTeamColor(d.team_colour);
      const gapStr = pos === 1 ? 'Championship Leader' : formatPointsDiff(leaderPts, d.points);

      let lastResText = 'No GP yet';
      if (lastCompiledRace && lastCompiledRace.results) {
        const lastMeeting = (gps || []).find(m => m.meeting_key === lastCompiledRace.meeting_key);
        const gpShort = lastMeeting?.circuit_short_name || lastCompiledRace.circuit_short_name || 'Last GP';
        const rEntry = (d.allResults || []).find(ar => !ar.isSprint && ar.meeting_key === lastCompiledRace.meeting_key);
        if (rEntry && rEntry.status !== 'ABSENT') {
          const st = rEntry.status === 'FINISHED' ? `P${rEntry.position}` : rEntry.status;
          lastResText = `${st} • ${gpShort}`;
        }
      }

      const avatar = d.headshot_url
        ? `<img class="cmd-fav-avatar" src="${d.headshot_url}" alt="${d.name_acronym}" loading="lazy" onerror="this.style.display='none'">`
        : `<span class="cmd-driver-monogram" style="border-color:${color};color:${color};">${d.name_acronym}</span>`;

      cards.push(`
        <div class="cmd-fav-card" data-fav-open-driver="${d.name_acronym}" style="--fav-accent:${color}" title="Click to open ${d.full_name} profile">
          <div class="cmd-fav-card-glow" style="background:${color}"></div>
          ${avatar}
          <div class="cmd-fav-card-main">
            <div class="cmd-fav-tag"><i class="fa-solid fa-star"></i> Favorite Driver</div>
            <div class="cmd-fav-name">${d.full_name} <span class="cmd-fav-team-sub">• ${d.team_name}</span></div>
            <div class="cmd-fav-metrics">
              <span><strong>${d.wins || 0}</strong> Wins</span>
              <span><strong>${d.podiums || 0}</strong> Podiums</span>
              <span>Last: <strong>${lastResText}</strong></span>
            </div>
          </div>
          <div class="cmd-fav-card-right">
            <div class="cmd-fav-rank" style="color:${pos <= 3 ? color : 'var(--text-primary)'}">P${pos}</div>
            <div class="cmd-fav-pts">${d.points} <span>pts</span></div>
            <div class="cmd-fav-gap">${gapStr}</div>
          </div>
        </div>
      `);
    } else {
      cards.push(`
        <div class="cmd-fav-card inactive" data-fav-edit="drivers">
          <div class="cmd-fav-card-main">
            <div class="cmd-fav-tag"><i class="fa-solid fa-star"></i> Favorite Driver</div>
            <div class="cmd-fav-name">${fav.driver} <span class="cmd-fav-team-sub">not on ${year} grid</span></div>
          </div>
          <span class="cmd-fav-change-pill">Change</span>
        </div>
      `);
    }
  }

  if (fav.team) {
    const tIdx = (standings.constructors || []).findIndex(t => isFavoriteTeam(t.team_name));
    if (tIdx !== -1) {
      const t = standings.constructors[tIdx];
      const pos = tIdx + 1;
      const leaderPts = standings.constructors[0]?.points || 0;
      const color = getTeamColor(t.team_colour);
      const gapStr = pos === 1 ? 'Constructors Leader' : formatPointsDiff(leaderPts, t.points);
      const driversLine = (t.drivers || []).map(dr => `${dr.name} (${dr.points})`).join(' · ');

      cards.push(`
        <div class="cmd-fav-card" data-fav-open-team="${t.team_name}" style="--fav-accent:${color}" title="Click to open ${t.team_name} profile">
          <div class="cmd-fav-card-glow" style="background:${color}"></div>
          <span class="cmd-fav-team-emblem" style="background:${color}20;border-color:${color}66;color:${color}">
            <i class="fa-solid fa-shield-halved"></i>
          </span>
          <div class="cmd-fav-card-main">
            <div class="cmd-fav-tag"><i class="fa-solid fa-star"></i> Favorite Team</div>
            <div class="cmd-fav-name">${t.team_name}</div>
            <div class="cmd-fav-metrics">
              <span><strong>${t.wins || 0}</strong> Wins</span>
              ${driversLine ? `<span>${driversLine}</span>` : ''}
            </div>
          </div>
          <div class="cmd-fav-card-right">
            <div class="cmd-fav-rank" style="color:${pos <= 3 ? color : 'var(--text-primary)'}">P${pos}</div>
            <div class="cmd-fav-pts">${t.points} <span>pts</span></div>
            <div class="cmd-fav-gap">${gapStr}</div>
          </div>
        </div>
      `);
    } else {
      cards.push(`
        <div class="cmd-fav-card inactive" data-fav-edit="teams">
          <div class="cmd-fav-card-main">
            <div class="cmd-fav-tag"><i class="fa-solid fa-star"></i> Favorite Team</div>
            <div class="cmd-fav-name">${fav.team} <span class="cmd-fav-team-sub">not in ${year} constructors</span></div>
          </div>
          <span class="cmd-fav-change-pill">Change</span>
        </div>
      `);
    }
  }

  strip.innerHTML = `
    <div class="cmd-fav-Spotlight-wrap">
      <div class="cmd-fav-cards-grid ${cards.length === 1 ? 'single' : ''}">
        ${cards.join('')}
      </div>
      <button type="button" class="cmd-fav-edit-icon-btn" id="cmd-edit-favorites-btn" title="Manage Pinned Driver &amp; Team" aria-label="Manage Pinned Favorites">
        <i class="fa-solid fa-sliders"></i>
      </button>
    </div>
  `;

  document.getElementById('cmd-edit-favorites-btn')?.addEventListener('click', () => openFavoritesModal(year));

  strip.querySelectorAll('[data-fav-open-driver]').forEach(el => {
    el.addEventListener('click', () => {
      const acr = el.dataset.favOpenDriver;
      const driver = standings.drivers.find(d => d.name_acronym === acr);
      if (driver) showDriverProfile(driver, standings, standings.raceSessions || []);
    });
  });

  strip.querySelectorAll('[data-fav-open-team]').forEach(el => {
    el.addEventListener('click', () => {
      const tName = el.dataset.favOpenTeam;
      const team = standings.constructors.find(c => c.team_name === tName);
      if (team) showTeamProfile(team, standings);
    });
  });

  strip.querySelectorAll('[data-fav-edit]').forEach(el => {
    el.addEventListener('click', () => openFavoritesModal(year, el.dataset.favEdit));
  });
}

function wireCommandQuickLinks() {
  if (quickLinksWired) return;
  const gotoDrivers = document.getElementById('cmd-goto-drivers');
  const gotoConstructors = document.getElementById('cmd-goto-constructors');
  if (!gotoDrivers && !gotoConstructors) return;

  quickLinksWired = true;

  gotoDrivers?.addEventListener('click', () => {
    setStandingsView('drivers');
    window.location.hash = '#standings';
  });

  gotoConstructors?.addEventListener('click', () => {
    setStandingsView('constructors');
    window.location.hash = '#standings';
  });
}

function formatPointsDiff(leaderPts, pts) {
  const diff = Math.round(((leaderPts - pts) + Number.EPSILON) * 100) / 100;
  return diff === 0 ? 'Equal' : `-${diff} pts`;
}

function getPosDeltaBadge(change) {
  if (!change) return '';
  if (change > 0) {
    return `<span class="cmd-pos-delta up" title="Up ${change} since previous round"><i class="fa-solid fa-caret-up"></i>${change}</span>`;
  }
  const abs = Math.abs(change);
  return `<span class="cmd-pos-delta down" title="Down ${abs} since previous round"><i class="fa-solid fa-caret-down"></i>${abs}</span>`;
}

function renderCommandStandings(standings, year) {
  const wdcEl = document.getElementById('cmd-wdc-list');
  const wccEl = document.getElementById('cmd-wcc-list');

  // 1. Drivers Top 3
  if (wdcEl) {
    const topDrivers = (standings.drivers || []).slice(0, 3);
    if (topDrivers.length === 0) {
      wdcEl.innerHTML = `
        <div class="cmd-empty-state">
          <i class="fa-solid fa-flag-checkered"></i>
          <span>Standings open after Round 1</span>
        </div>
      `;
    } else {
      const leaderPts = topDrivers[0].points || 0;
      wdcEl.innerHTML = topDrivers.map((d, idx) => {
        const pos = idx + 1;
        const teamColor = getTeamColor(d.team_colour);
        const isChamp = idx === 0 && (standings.isFinished || standings.driverClinched);
        const gapHtml = idx === 0
          ? (isChamp ? '<span class="cmd-gap-pill champ"><i class="fa-solid fa-crown"></i> Champion</span>' : '<span class="cmd-gap-pill leader">Leader</span>')
          : `<span class="cmd-gap-pill">${formatPointsDiff(leaderPts, d.points)}</span>`;

        const avatarHtml = d.headshot_url
          ? `<img class="cmd-driver-avatar" src="${d.headshot_url}" alt="${d.name_acronym}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';"><span class="cmd-driver-monogram" style="display:none;border-color:${teamColor};color:${teamColor};">${d.name_acronym}</span>`
          : `<span class="cmd-driver-monogram" style="border-color:${teamColor};color:${teamColor};">${d.name_acronym}</span>`;

        const isFavD = isFavoriteDriver(d.name_acronym) || isFavoriteTeam(d.team_name);
        const favStarD = isFavoriteDriver(d.name_acronym) ? ' <i class="fa-solid fa-star fav-inline-star" title="Pinned Favorite Driver"></i>' : '';
        return `
          <button type="button" class="cmd-leader-row ${isFavD ? 'fav-pinned-bento-row' : ''}" data-driver="${d.name_acronym}" title="Inspect ${d.full_name} season telemetry">
            <div class="cmd-leader-rank-wrap">
              <span class="cmd-leader-rank p${pos}">${pos}</span>
              ${getPosDeltaBadge(d.positionChange)}
            </div>
            <span class="cmd-team-bar" style="background:${teamColor};"></span>
            ${avatarHtml}
            <div class="cmd-leader-info">
              <div class="cmd-leader-name">${d.full_name}${favStarD}</div>
              <div class="cmd-leader-sub">${d.team_name || 'Formula 1'} • ${d.wins || 0}W ${d.podiums || 0}P</div>
            </div>
            <div class="cmd-leader-pts-col">
              <div class="cmd-leader-pts">${d.points}<span> pts</span></div>
              ${gapHtml}
            </div>
          </button>
        `;
      }).join('');

      wdcEl.querySelectorAll('.cmd-leader-row[data-driver]').forEach(btn => {
        btn.addEventListener('click', () => {
          const acronym = btn.dataset.driver;
          const driver = standings.drivers.find(d => d.name_acronym === acronym);
          if (driver) {
            showDriverProfile(driver, standings, standings.raceSessions || []);
          }
        });
      });
    }
  }

  // 2. Constructors Top 3
  if (wccEl) {
    const topTeams = (standings.constructors || []).slice(0, 3);
    if (topTeams.length === 0) {
      const pre1958 = Number(year) < 1958;
      wccEl.innerHTML = `
        <div class="cmd-empty-state">
          <i class="fa-solid fa-shield-halved"></i>
          <span>${pre1958 ? "Constructors' title began in 1958" : 'Standings open after Round 1'}</span>
        </div>
      `;
    } else {
      const leaderPts = topTeams[0].points || 0;
      wccEl.innerHTML = topTeams.map((t, idx) => {
        const pos = idx + 1;
        const teamColor = getTeamColor(t.team_colour);
        const isChamp = idx === 0 && (standings.isFinished || standings.constructorClinched);
        const gapHtml = idx === 0
          ? (isChamp ? '<span class="cmd-gap-pill champ"><i class="fa-solid fa-trophy"></i> Champion</span>' : '<span class="cmd-gap-pill leader">Leader</span>')
          : `<span class="cmd-gap-pill">${formatPointsDiff(leaderPts, t.points)}</span>`;

        const driverCodes = (t.drivers || []).map(dr => dr.name).join(' · ');

        const isFavT = isFavoriteTeam(t.team_name);
        const favStarT = isFavT ? ' <i class="fa-solid fa-star fav-inline-star" title="Pinned Favorite Team"></i>' : '';
        return `
          <button type="button" class="cmd-leader-row ${isFavT ? 'fav-pinned-bento-row' : ''}" data-team="${t.team_name}" title="Inspect ${t.team_name} constructor profile">
            <div class="cmd-leader-rank-wrap">
              <span class="cmd-leader-rank p${pos}">${pos}</span>
              ${getPosDeltaBadge(t.positionChange)}
            </div>
            <span class="cmd-team-bar" style="background:${teamColor};"></span>
            <span class="cmd-team-emblem" style="background:${teamColor}1a;border-color:${teamColor}55;color:${teamColor};">
              <i class="fa-solid fa-car-side"></i>
            </span>
            <div class="cmd-leader-info">
              <div class="cmd-leader-name">${t.team_name}${favStarT}</div>
              <div class="cmd-leader-sub">${driverCodes ? `${driverCodes} • ` : ''}${t.wins || 0} win${t.wins !== 1 ? 's' : ''}</div>
            </div>
            <div class="cmd-leader-pts-col">
              <div class="cmd-leader-pts">${t.points}<span> pts</span></div>
              ${gapHtml}
            </div>
          </button>
        `;
      }).join('');

      wccEl.querySelectorAll('.cmd-leader-row[data-team]').forEach(btn => {
        btn.addEventListener('click', () => {
          const teamName = btn.dataset.team;
          const team = standings.constructors.find(c => c.team_name === teamName);
          if (team) {
            showTeamProfile(team, standings);
          }
        });
      });
    }
  }
}

function renderRaceCenter({
  latestRaceEl,
  gps,
  fullRaces,
  sprintRaces,
  lastCompiledRace,
  currentWeekend,
  seasonData,
  standings,
  year
}) {
  if (!latestRaceEl) return;
  if (dashboardCountdownInterval) {
    clearInterval(dashboardCountdownInterval);
    dashboardCountdownInterval = null;
  }

  // Reset legacy inline handlers if any
  latestRaceEl.style.cursor = '';
  latestRaceEl.onclick = null;
  latestRaceEl.onmouseenter = null;
  latestRaceEl.onmouseleave = null;

  const cwRace = currentWeekend ? fullRaces.find(s => s.meeting_key === currentWeekend.meeting_key) : null;
  const isLiveWeekend = Boolean(currentWeekend && (!cwRace || !isPast(cwRace.date_end)));

  const nextUpcoming = isLiveWeekend
    ? currentWeekend
    : gps.find(m => {
        const r = fullRaces.find(s => s.meeting_key === m.meeting_key);
        return r ? !isPast(r.date_end) : !isPast(m.date_end);
      });

  let html = '';

  // Part A: Latest Completed GP + Podium
  let lastMeeting = null;
  if (lastCompiledRace && lastCompiledRace.results && lastCompiledRace.results.length > 0) {
    lastMeeting = gps.find(m => m.meeting_key === lastCompiledRace.meeting_key) || null;
    const roundNum = lastMeeting ? gps.indexOf(lastMeeting) + 1 : (standings.totalRounds || 1);
    const raceTitle = (lastMeeting?.meeting_name || lastCompiledRace.circuit_short_name || 'Grand Prix').replace(' Grand Prix', ' GP');
    const flagImg = lastMeeting?.country_flag
      ? `<img class="cmd-gp-flag" src="${lastMeeting.country_flag}" alt="${lastMeeting.country_code || ''}">`
      : '';

    const podiumRows = lastCompiledRace.results.slice(0, 3).map((res, idx) => {
      const pos = idx + 1;
      const raceDriver = (lastCompiledRace.drivers || []).find(d => d.driver_number === res.driver_number);
      const acronym = raceDriver?.name_acronym || null;
      const seasonDriver = acronym ? seasonData.drivers.get(acronym) : null;
      const standingDriver = acronym ? (standings.drivers || []).find(d => d.name_acronym === acronym) : null;
      const roundEntry = standingDriver?.allResults?.find(ar => !ar.isSprint && ar.meeting_key === lastCompiledRace.meeting_key);

      const resolvedColor = getTeamColor(
        roundEntry?.team_colour ||
        (raceDriver?.team_name && raceDriver.team_name !== 'Unknown' ? raceDriver.team_colour : null) ||
        seasonDriver?.team_colour
      );
      const resolvedTeam = roundEntry?.team_name ||
        (raceDriver?.team_name && raceDriver.team_name !== 'Unknown' ? raceDriver.team_name : null) ||
        seasonDriver?.team_name ||
        '';
      const displayName = seasonDriver?.full_name || raceDriver?.full_name || acronym || `#${res.driver_number}`;
      const shortCode = acronym || displayName.slice(0, 3).toUpperCase();

      return `
        <div class="cmd-podium-item p${pos}">
          <span class="cmd-podium-pos p${pos}">P${pos}</span>
          <span class="cmd-podium-bar" style="background:${resolvedColor};"></span>
          <span class="cmd-podium-driver" title="${displayName}${resolvedTeam ? ' • ' + resolvedTeam : ''}">
            <strong class="cmd-podium-full">${displayName}</strong>
            <strong class="cmd-podium-code">${shortCode}</strong>
          </span>
          <span class="cmd-podium-team">${resolvedTeam}</span>
        </div>
      `;
    }).join('');

    html += `
      <div class="cmd-race-subcard latest">
        <div class="cmd-subcard-top">
          <div class="cmd-subcard-meta">
            <span class="cmd-status-tag completed">Round ${roundNum} Result</span>
            <div class="cmd-gp-title-row">
              ${flagImg}
              <span class="cmd-gp-name">${raceTitle}</span>
            </div>
          </div>
          <button type="button" class="cmd-inline-cta primary" id="cmd-analyze-race-btn">
            <i class="fa-solid fa-chart-simple"></i>
            <span>Analyze</span>
          </button>
        </div>
        <div class="cmd-podium-list">
          ${podiumRows}
        </div>
      </div>
    `;
  }

  // Part B: Next / Live GP Countdown OR Season Concluded Summary
  if (nextUpcoming) {
    const nextRound = gps.indexOf(nextUpcoming) + 1;
    const nextRaceSession = fullRaces.find(s => s.meeting_key === nextUpcoming.meeting_key);
    const hasSprint = sprintRaces.some(s => s.meeting_key === nextUpcoming.meeting_key);
    const nextTitle = nextUpcoming.meeting_name.replace(' Grand Prix', ' GP');
    const flagImg = nextUpcoming.country_flag
      ? `<img class="cmd-gp-flag" src="${nextUpcoming.country_flag}" alt="${nextUpcoming.country_code || ''}">`
      : '';

    const statusBadge = isLiveWeekend
      ? `<span class="cmd-status-tag live"><span class="live-dot"></span> Race Weekend Live</span>`
      : `<span class="cmd-status-tag upcoming">Next • Round ${nextRound}</span>`;

    const sprintTag = hasSprint
      ? `<span class="cmd-sprint-tag"><i class="fa-solid fa-bolt"></i> Sprint</span>`
      : '';

    html += `
      <div class="cmd-race-subcard upcoming ${isLiveWeekend ? 'is-live' : ''}">
        <div class="cmd-subcard-top">
          <div class="cmd-subcard-meta">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              ${statusBadge}
              ${sprintTag}
            </div>
            <div class="cmd-gp-title-row">
              ${flagImg}
              <span class="cmd-gp-name">${nextTitle}</span>
            </div>
            <div class="cmd-gp-loc">${nextUpcoming.circuit_short_name || nextUpcoming.location} • ${formatDateRange(nextUpcoming.date_start, nextUpcoming.date_end)}</div>
          </div>
          <button type="button" class="cmd-inline-cta" id="cmd-schedule-btn">
            <i class="fa-regular fa-clock"></i>
            <span>Schedule</span>
          </button>
        </div>
        <div class="cmd-countdown-strip" id="cmd-countdown-strip">
          <span class="cmd-countdown-label" id="cmd-countdown-label">Lights out in</span>
          <span class="cmd-countdown-timer" id="cmd-countdown-timer">--d --h --m --s</span>
        </div>
      </div>
    `;
  } else if (lastCompiledRace) {
    const champDriver = standings.drivers?.[0];
    const champTeam = standings.constructors?.[0];
    html += `
      <div class="cmd-race-subcard concluded">
        <div class="cmd-concluded-row">
          <span class="cmd-status-tag concluded-tag"><i class="fa-solid fa-flag-checkered"></i> ${year} Season Complete</span>
          <span class="cmd-concluded-count">${gps.length || standings.totalRounds} Grands Prix</span>
        </div>
        ${champDriver ? `
          <div class="cmd-concluded-champs">
            <span><i class="fa-solid fa-crown" style="color:#ffd700;"></i> <strong>${champDriver.full_name}</strong> (${champDriver.points} pts)</span>
            ${champTeam ? `<span><i class="fa-solid fa-trophy" style="color:#ffd700;"></i> <strong>${champTeam.team_name}</strong></span>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  } else {
    html = `
      <div class="cmd-empty-state">
        <i class="fa-solid fa-calendar-xmark"></i>
        <span>No race sessions scheduled yet for ${year}</span>
      </div>
    `;
  }

  latestRaceEl.innerHTML = html;

  // Wire "Analyze" button -> jump to Calendar + Race Deep-Dive
  const analyzeBtn = document.getElementById('cmd-analyze-race-btn');
  if (analyzeBtn && lastCompiledRace) {
    analyzeBtn.addEventListener('click', () => {
      const fallbackMeeting = lastMeeting || {
        meeting_key: lastCompiledRace.meeting_key,
        meeting_name: `${lastCompiledRace.circuit_short_name || ''} Grand Prix`.trim(),
        circuit_short_name: lastCompiledRace.circuit_short_name,
        year
      };
      selectCalendarMeeting(lastCompiledRace.meeting_key, lastCompiledRace.session_key, fallbackMeeting);
    });
  }

  // Wire "Schedule" button -> open Weekend Schedule modal
  const scheduleBtn = document.getElementById('cmd-schedule-btn');
  if (scheduleBtn && nextUpcoming) {
    scheduleBtn.addEventListener('click', () => {
      showFutureRaceSchedule(nextUpcoming);
    });
  }

  // Start live ticking countdown if upcoming/live GP exists
  if (nextUpcoming) {
    const nextRaceSession = fullRaces.find(s => s.meeting_key === nextUpcoming.meeting_key);
    const labelEl = document.getElementById('cmd-countdown-label');
    const timerEl = document.getElementById('cmd-countdown-timer');

    const updateTick = () => {
      if (!timerEl || !labelEl) return;
      const now = Date.now();
      const raceStartMs = nextRaceSession?.date_start ? new Date(nextRaceSession.date_start).getTime() : null;
      const raceEndMs = nextRaceSession?.date_end ? new Date(nextRaceSession.date_end).getTime() : null;
      const weekendStartMs = new Date(nextUpcoming.date_start).getTime();

      if (raceStartMs && raceEndMs && now >= raceStartMs && now <= raceEndMs) {
        labelEl.textContent = 'Grand Prix Status';
        timerEl.innerHTML = '<span class="cmd-live-now">RACE LIVE NOW</span>';
        return;
      }

      const targetMs = (raceStartMs && raceStartMs > now) ? raceStartMs : weekendStartMs;
      const isRaceTarget = Boolean(raceStartMs && raceStartMs > now);

      if (targetMs > now) {
        const diff = targetMs - now;
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        const pad = n => String(n).padStart(2, '0');

        labelEl.textContent = isRaceTarget ? 'Race lights out' : 'Weekend starts';
        timerEl.textContent = `${d > 0 ? d + 'd ' : ''}${pad(h)}h ${pad(m)}m ${pad(s)}s`;
      } else {
        labelEl.textContent = 'Weekend Status';
        timerEl.innerHTML = '<span class="cmd-live-now">IN PROGRESS</span>';
      }
    };

    updateTick();
    dashboardCountdownInterval = setInterval(updateTick, 1000);
  }
}

export async function initDashboard(year, forceResetChart = false) {
  const heroBadge = $('#hero-badge-text');
  const latestRaceEl = $('#latest-race-info');
  const progressFill = $('#progress-fill');
  const progressLabel = $('#progress-completed');

  wireCommandQuickLinks();

  if (dashboardCountdownInterval) {
    clearInterval(dashboardCountdownInterval);
    dashboardCountdownInterval = null;
  }

  heroBadge.textContent = `${year} SEASON`;

  // Reset stats while loading
  document.getElementById('stat-races').textContent = '…';
  document.getElementById('stat-sprints').textContent = '…';
  document.getElementById('stat-overtakes').textContent = '…';
  document.getElementById('stat-fastest').textContent = '…';

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
    progressLabel.textContent = `${completedCount} / ${totalRaces} Races (${Math.round(progressPct)}%)`;

    // Update basic stat cards immediately
    document.getElementById('stat-races').textContent = `${completedCount}/${totalRaces}`;
    document.getElementById('stat-sprints').textContent = sprintRaces.length > 0
      ? `${completedSprints.length}/${sprintRaces.length}`
      : '0';

    // Find current weekend & latest compiled race
    const currentWeekend = gps.find(m => isThisWeek(m.date_start, m.date_end));
    const compiledRaces = seasonData.races || [];
    const lastCompiledRace = compiledRaces.filter(r => r.session_name === 'Race').pop();

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
      const raceDriver = overallFastestRace.drivers ? overallFastestRace.drivers.find(d => d.driver_number === overallFastestDriver) : null;
      const driverAcronym = raceDriver ? raceDriver.name_acronym : null;
      const driverInfo = driverAcronym ? seasonData.drivers.get(driverAcronym) : null;
      const driverName = driverInfo ? driverInfo.name_acronym : `#${overallFastestDriver}`;
      document.getElementById('stat-fastest').innerHTML = `<span class="kpi-lap-time">${formatLapTime(overallFastestLap)}</span><span class="kpi-lap-driver">${driverName}</span>`;
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

    // Compute season standings once and share across WDC/WCC Bento cards + Race Center + Points Tracker
    const standings = computeStandingsFromSeason(seasonData);

    lastDashboardRenderCtx = { standings, lastCompiledRace, gps, seasonData, year };
    renderCommandFavorites(lastDashboardRenderCtx);
    renderCommandStandings(standings, year);

    if (!favoritesListenerWired) {
      favoritesListenerWired = true;
      window.addEventListener('pitcorner:favorites-changed', () => {
        if (!lastDashboardRenderCtx) return;
        renderCommandFavorites(lastDashboardRenderCtx);
        renderCommandStandings(lastDashboardRenderCtx.standings, lastDashboardRenderCtx.year);
        const fav = getFavorites();
        if (fav.driver && lastDashboardRenderCtx.standings.drivers.some(d => isFavoriteDriver(d.name_acronym))) {
          chartSelectedDrivers.add(fav.driver.toUpperCase());
        }
        if (fav.team) {
          const matchT = lastDashboardRenderCtx.standings.constructors.find(c => isFavoriteTeam(c.team_name));
          if (matchT) chartSelectedConstructors.add(matchT.team_name);
        }
        if (currentSeasonData) {
          const sel = document.getElementById('chart-drivers-count');
          drawChampionshipBattle(currentSeasonData, sel ? parseInt(sel.value, 10) : 5, false, lastDashboardRenderCtx.standings);
        }
      });
    }
    renderRaceCenter({
      latestRaceEl,
      gps,
      fullRaces,
      sprintRaces,
      lastCompiledRace,
      currentWeekend,
      seasonData,
      standings,
      year
    });

    // ── Championship Battle Points Tracker ──
    currentSeasonData = seasonData;
    const selectEl = document.getElementById('chart-drivers-count');
    const defaultCount = selectEl ? parseInt(selectEl.value, 10) : 5;
    drawChampionshipBattle(seasonData, defaultCount, forceResetChart, standings);

    if (selectEl && !changeListenerAdded) {
      selectEl.addEventListener('change', (e) => {
        if (currentSeasonData) {
          drawChampionshipBattle(currentSeasonData, parseInt(e.target.value, 10), true);
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
let chartActiveType = 'drivers'; // 'drivers' or 'constructors'
let chartSelectedDrivers = new Set();
let chartSelectedConstructors = new Set();
let lastLoadedSeasonYear = null;
let chartTogglesInitialized = false;
let chartLegendExpanded = false;


function resetChartSelections(standings, count) {
  chartSelectedDrivers.clear();
  chartSelectedConstructors.clear();

  const topDrivers = standings.drivers.slice(0, count);
  topDrivers.forEach(d => chartSelectedDrivers.add(d.name_acronym));

  const topConstructors = standings.constructors.slice(0, count);
  topConstructors.forEach(c => chartSelectedConstructors.add(c.team_name));

  // Ensure pinned favorite driver & constructor are automatically tracked on chart
  const fav = getFavorites();
  if (fav.driver) {
    const matchD = standings.drivers.find(d => isFavoriteDriver(d.name_acronym));
    if (matchD) chartSelectedDrivers.add(matchD.name_acronym);
  }
  if (fav.team) {
    const matchT = standings.constructors.find(c => isFavoriteTeam(c.team_name));
    if (matchT) chartSelectedConstructors.add(matchT.team_name);
  }
}

function drawChampionshipBattle(seasonData, presetCount, forceReset = false, precomputedStandings = null) {
  const standings = precomputedStandings || computeStandingsFromSeason(seasonData);

  const needsReset = lastLoadedSeasonYear !== seasonData.year || 
                     forceReset || 
                     (chartSelectedDrivers.size === 0 && standings.drivers.length > 0) || 
                     (chartSelectedConstructors.size === 0 && standings.constructors.length > 0);

  if (needsReset) {
    lastLoadedSeasonYear = seasonData.year;
    resetChartSelections(standings, presetCount);
  }

  const chartCanvas = document.getElementById('dashboard-championship-chart');
  const legendEl = document.getElementById('dashboard-chart-legend');

  const allItems = chartActiveType === 'drivers' ? standings.drivers : standings.constructors;
  const selectedSet = chartActiveType === 'drivers' ? chartSelectedDrivers : chartSelectedConstructors;

  if (chartCanvas && legendEl) {
    if (allItems.length === 0) {
      chartCanvas.style.display = 'none';
      legendEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No points data available yet</div>';
      const timelineEl = document.getElementById('championship-leaders-timeline');
      if (timelineEl) timelineEl.style.display = 'none';
    } else {
      chartCanvas.style.display = 'block';

      // Gather completed meetings in chronological order
      const meetingsMap = new Map();
      for (const r of seasonData.races) {
        if (!r.results || r.results.length === 0) continue;
        if (!meetingsMap.has(r.meeting_key)) {
          meetingsMap.set(r.meeting_key, {
            meeting_key: r.meeting_key,
            circuit_short_name: r.circuit_short_name,
            date_end: r.date_end,
          });
        }
        const m = meetingsMap.get(r.meeting_key);
        if (new Date(r.date_end) > new Date(m.date_end)) {
          m.date_end = r.date_end;
        }
      }
      const sortedMeetings = Array.from(meetingsMap.values())
        .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

      // Filter to only active/selected items
      const activeItems = allItems.filter(item => {
        const id = chartActiveType === 'drivers' ? item.name_acronym : item.team_name;
        return selectedSet.has(id);
      });

      const datasets = activeItems.map(item => {
        const label = chartActiveType === 'drivers' ? item.name_acronym : item.team_name;
        return {
          label: label,
          data: item.pointsHistory || [],
          color: getTeamColor(item.team_colour),
          alpha: 0.9,
        };
      });

      // Store current datasets and meetings on canvas to avoid closure bugs across redraws
      chartCanvas._chartData = {
        datasets,
        sortedMeetings,
        activeItems
      };

      // Create/grab dynamic tooltip container inside parent element
      let tooltip = chartCanvas.parentElement.querySelector('.chart-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'chart-tooltip';
        chartCanvas.parentElement.appendChild(tooltip);
      }

      function drawChartWithHover(hoverIndex) {
        const data = chartCanvas._chartData;
        if (!data) return;
        requestAnimationFrame(() => {
          drawLineChart(chartCanvas, data.datasets, {
            xLabel: 'Races Completed',
            yLabel: 'Points',
            lineWidth: 2.5,
            showDots: true,
            yMin: 0,
            hoveredIndex: hoverIndex,
          });
        });
      }

      // Draw initial state (no hover)
      drawChartWithHover(undefined);

      // Attach event listeners for hover interaction (once per canvas lifetime)
      if (!chartCanvas._hoverInitialized) {
        chartCanvas._hoverInitialized = true;

        const handleHover = (e) => {
          const data = chartCanvas._chartData;
          if (!data) return;

          const rect = chartCanvas.getBoundingClientRect();
          const clientX = e.clientX || (e.touches && e.touches[0].clientX);
          const clientY = e.clientY || (e.touches && e.touches[0].clientY);
          
          const mouseX = clientX - rect.left;
          const mouseY = clientY - rect.top;

          // Padding variables used in charts.js
          const padLeft = 60;
          const padRight = 20;
          const plotW = rect.width - padLeft - padRight;
          
          if (mouseX >= padLeft && mouseX <= rect.width - padRight) {
            const maxLen = data.sortedMeetings.length;
            if (maxLen === 0) return;
            const ratio = (mouseX - padLeft) / plotW;
            let idx = Math.round(ratio * (maxLen - 1));
            idx = Math.max(0, Math.min(maxLen - 1, idx));

            // Repaint chart with hover highlight
            drawChartWithHover(idx);

            // Populate and position the tooltip
            const meeting = data.sortedMeetings[idx];
            const roundNumber = idx + 1;

            // Gather values of active items at this index
            const hoverItems = data.datasets.map(ds => {
              const itemInfo = data.activeItems.find(ai => {
                const id = chartActiveType === 'drivers' ? ai.name_acronym : ai.team_name;
                return id === ds.label;
              });
              const displayName = chartActiveType === 'drivers'
                ? (itemInfo?.full_name || ds.label)
                : ds.label;

              return {
                label: ds.label,
                displayName: displayName,
                color: ds.color,
                points: ds.data[idx] || 0
              };
            }).sort((a, b) => b.points - a.points); // sort highest points first

            let html = `
              <div class="chart-tooltip-header">
                Round ${roundNumber}: ${meeting.circuit_short_name} GP
              </div>
            `;
            
            hoverItems.forEach(hi => {
              html += `
                <div class="chart-tooltip-row">
                  <span class="chart-tooltip-driver">
                    <span class="chart-tooltip-color-dot" style="background:${hi.color}"></span>
                    <span>${hi.displayName}</span>
                  </span>
                  <span class="chart-tooltip-value">${hi.points} pts</span>
                </div>
              `;
            });

            tooltip.innerHTML = html;
            tooltip.classList.add('show');

            // Position tooltip dynamically near the hover point
            const tooltipRect = tooltip.getBoundingClientRect();
            const leftOffset = mouseX + 15;
            const rightEdge = leftOffset + tooltipRect.width;

            if (rightEdge > rect.width) {
              tooltip.style.left = `${mouseX - tooltipRect.width - 15}px`;
            } else {
              tooltip.style.left = `${leftOffset}px`;
            }
            tooltip.style.top = `${Math.max(10, Math.min(rect.height - tooltipRect.height - 10, mouseY - tooltipRect.height / 2))}px`;
          } else {
            clearHover();
          }
        };

        const clearHover = () => {
          drawChartWithHover(undefined);
          tooltip.classList.remove('show');
        };

        chartCanvas.addEventListener('mousemove', handleHover);
        chartCanvas.addEventListener('mouseleave', clearHover);
        chartCanvas.addEventListener('touchstart', handleHover, { passive: true });
        chartCanvas.addEventListener('touchmove', handleHover, { passive: true });
        chartCanvas.addEventListener('touchend', clearHover);
      }

      // Wire up Drivers / Constructors Toggle button tabs (once per page load)
      const driversToggle = document.getElementById('chart-toggle-drivers');
      const constructorsToggle = document.getElementById('chart-toggle-constructors');

      if (driversToggle && constructorsToggle && !chartTogglesInitialized) {
        chartTogglesInitialized = true;

        driversToggle.addEventListener('click', () => {
          if (chartActiveType === 'drivers') return;
          chartActiveType = 'drivers';
          driversToggle.classList.add('active');
          constructorsToggle.classList.remove('active');

          const countSelect = document.getElementById('chart-drivers-count');
          const count = countSelect ? parseInt(countSelect.value, 10) : 5;
          drawChampionshipBattle(currentSeasonData, count, true);
        });

        constructorsToggle.addEventListener('click', () => {
          if (chartActiveType === 'constructors') return;
          chartActiveType = 'constructors';
          constructorsToggle.classList.add('active');
          driversToggle.classList.remove('active');

          const countSelect = document.getElementById('chart-drivers-count');
          const count = countSelect ? parseInt(countSelect.value, 10) : 5;
          drawChampionshipBattle(currentSeasonData, count, true);
        });
      }

      // Ensure active classes are in sync on toggle buttons
      if (driversToggle && constructorsToggle) {
        if (chartActiveType === 'drivers') {
          driversToggle.classList.add('active');
          constructorsToggle.classList.remove('active');
        } else {
          constructorsToggle.classList.add('active');
          driversToggle.classList.remove('active');
        }
      }

      // Render legend as interactive chips
      legendEl.innerHTML = allItems.map(item => {
        const id = chartActiveType === 'drivers' ? item.name_acronym : item.team_name;
        const color = getTeamColor(item.team_colour);
        const isActive = selectedSet.has(id);
        const activeClass = isActive ? 'active' : '';

        return `
          <button class="chart-legend-chip ${activeClass}" data-id="${id}">
            <span class="color-dot" style="background:${isActive ? color : 'transparent'}; border-color:${color}"></span>
            <span>${id}</span>
          </button>
        `;
      }).join('');

      // Wire up clicks on chips to toggle lines on/off
      legendEl.querySelectorAll('.chart-legend-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const id = chip.dataset.id;
          if (selectedSet.has(id)) {
            // Keep at least one selected
            if (selectedSet.size > 1) {
              selectedSet.delete(id);
            } else {
              return;
            }
          } else {
            selectedSet.add(id);
          }

          const countSelect = document.getElementById('chart-drivers-count');
          const count = countSelect ? parseInt(countSelect.value, 10) : 5;
          if (currentSeasonData) {
            drawChampionshipBattle(currentSeasonData, count, false);
          }
        });
      });

      // Wire legend expand/collapse toggle
      const legendToggle = document.getElementById('fb-legend-toggle');
      const legendToggleText = document.getElementById('fb-legend-toggle-text');
      const legendToggleIcon = document.getElementById('fb-legend-toggle-icon');

      if (legendToggle && legendEl) {
        // Sync visual states on load/redraw
        if (chartLegendExpanded) {
          legendEl.style.display = 'flex';
          if (legendToggleText) legendToggleText.textContent = 'Hide Selection';
          if (legendToggleIcon) {
            legendToggleIcon.style.transform = 'rotate(-180deg)';
            legendToggleIcon.style.color = 'var(--f1-red)';
          }
        } else {
          legendEl.style.display = 'none';
          if (legendToggleText) legendToggleText.textContent = 'Show Selection';
          if (legendToggleIcon) {
            legendToggleIcon.style.transform = 'rotate(0deg)';
            legendToggleIcon.style.color = 'var(--text-muted)';
          }
        }

        // Click handler (wire once)
        if (!legendToggle._listenerAdded) {
          legendToggle._listenerAdded = true;
          legendToggle.addEventListener('click', () => {
            chartLegendExpanded = !chartLegendExpanded;
            
            // Re-draw chart with new toggle state
            const countSelect = document.getElementById('chart-drivers-count');
            const count = countSelect ? parseInt(countSelect.value, 10) : 5;
            if (currentSeasonData) {
              drawChampionshipBattle(currentSeasonData, count, false);
            }
          });

          // Hover effects on toggle button
          legendToggle.addEventListener('mouseenter', () => {
            legendToggle.style.color = 'var(--text-primary)';
          });
          legendToggle.addEventListener('mouseleave', () => {
            legendToggle.style.color = 'var(--text-secondary)';
          });
        }
      }


      // Render Championship Leaders Timeline (Drivers or Constructors)
      const timelineEl = document.getElementById('championship-leaders-timeline');
      if (timelineEl) {
        const leadersByRound = [];
        for (let mIdx = 0; mIdx < sortedMeetings.length; mIdx++) {
          if (chartActiveType === 'drivers') {
            const roundDriverPoints = standings.drivers.map(d => ({
              driver_number: d.driver_number,
              name_acronym: d.name_acronym,
              full_name: d.full_name,
              team_name: d.team_name,
              team_colour: d.team_colour,
              points: d.pointsHistory[mIdx] || 0
            })).sort((a, b) => b.points - a.points);

            if (roundDriverPoints.length > 0 && roundDriverPoints[0].points > 0) {
              const leader = roundDriverPoints[0];
              leadersByRound.push({
                round: mIdx + 1,
                id: leader.driver_number,
                name: leader.name_acronym,
                fullName: leader.full_name,
                teamName: leader.team_name,
                teamColour: leader.team_colour
              });
            }
          } else {
            const roundConstructorPoints = standings.constructors.map(c => ({
              team_name: c.team_name,
              team_colour: c.team_colour,
              points: c.pointsHistory[mIdx] || 0
            })).sort((a, b) => b.points - a.points);

            if (roundConstructorPoints.length > 0 && roundConstructorPoints[0].points > 0) {
              const leader = roundConstructorPoints[0];
              leadersByRound.push({
                round: mIdx + 1,
                id: leader.team_name,
                name: leader.team_name,
                fullName: leader.team_name,
                teamName: leader.team_name,
                teamColour: leader.team_colour
              });
            }
          }
        }

        // Group contiguous rounds
        const groups = [];
        if (leadersByRound.length > 0) {
          let currentGroup = {
            startRound: leadersByRound[0].round,
            endRound: leadersByRound[0].round,
            item: leadersByRound[0]
          };

          for (let i = 1; i < leadersByRound.length; i++) {
            const current = leadersByRound[i];
            if (current.id === currentGroup.item.id) {
              currentGroup.endRound = current.round;
            } else {
              groups.push(currentGroup);
              currentGroup = {
                startRound: current.round,
                endRound: current.round,
                item: current
              };
            }
          }
          groups.push(currentGroup);
        }

        if (groups.length > 0) {
          timelineEl.style.display = 'block';
          
          const titleText = chartActiveType === 'drivers' 
            ? 'Driver Leader History' 
            : 'Constructor Leader History';

          timelineEl.innerHTML = `
            <button id="fb-timeline-toggle" style="background:none;border:none;width:100%;text-align:left;padding:0;font-family:'Outfit',sans-serif;font-size:0.8rem;font-weight:700;color:var(--text-secondary);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;display:flex;align-items:center;justify-content:space-between;cursor:pointer;outline:none;transition:color var(--transition-fast);">
              <span style="display:flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-timeline" style="color:var(--f1-red);"></i> ${titleText}
              </span>
              <span style="display:flex;align-items:center;gap:6px;font-size:0.7rem;color:var(--text-muted);text-transform:none;">
                <span id="fb-timeline-toggle-text">Show History</span>
                <i id="fb-timeline-toggle-icon" class="fa-solid fa-chevron-down" style="transition:transform var(--transition-base);"></i>
              </span>
            </button>
            <div id="fb-timeline-content" style="display:none;gap:10px;overflow-x:auto;padding-bottom:10px;scrollbar-width:thin;" class="custom-scrollbar">
              ${groups.map(g => {
                const roundsText = g.startRound === g.endRound ? `Round ${g.startRound}` : `Rounds ${g.startRound}–${g.endRound}`;
                const tColor = getTeamColor(g.item.teamColour);
                const subtitleText = chartActiveType === 'drivers' ? g.item.teamName : 'Constructor';
                
                return `
                  <div style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-left:4px solid ${tColor};border-radius:var(--radius-sm);padding:8px 12px;flex:0 0 auto;min-width:150px;display:flex;flex-direction:column;gap:2px;">
                    <div style="font-size:0.68rem;color:var(--text-muted);font-weight:600;">${roundsText}</div>
                    <div style="font-family:'Outfit',sans-serif;font-weight:800;font-size:0.9rem;color:var(--text-primary);">
                      ${g.item.fullName || g.item.name}
                    </div>
                    <div style="font-size:0.68rem;color:var(--text-secondary);">${subtitleText}</div>
                  </div>
                `;
              }).join('')}
            </div>
          `;

          // Wire collapse/expand toggle
          const toggleBtn = document.getElementById('fb-timeline-toggle');
          const toggleText = document.getElementById('fb-timeline-toggle-text');
          const toggleIcon = document.getElementById('fb-timeline-toggle-icon');
          const contentDiv = document.getElementById('fb-timeline-content');

          if (toggleBtn && contentDiv) {
            toggleBtn.addEventListener('click', () => {
              const isHidden = contentDiv.style.display === 'none';
              if (isHidden) {
                contentDiv.style.display = 'flex';
                toggleText.textContent = 'Hide History';
                toggleIcon.style.transform = 'rotate(-180deg)';
                toggleIcon.style.color = 'var(--f1-red)';
              } else {
                contentDiv.style.display = 'none';
                toggleText.textContent = 'Show History';
                toggleIcon.style.transform = 'rotate(0deg)';
                toggleIcon.style.color = 'var(--text-muted)';
              }
            });

            // Hover effects on the toggle button
            toggleBtn.addEventListener('mouseenter', () => {
              toggleBtn.style.color = 'var(--text-primary)';
            });
            toggleBtn.addEventListener('mouseleave', () => {
              toggleBtn.style.color = 'var(--text-secondary)';
            });
          }
        } else {
          timelineEl.style.display = 'none';
        }
      }
    }
  }
}
