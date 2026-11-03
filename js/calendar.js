// =============================================
// PITCORNER — Race Calendar
// Uses compiled season data (shared)
// =============================================

import { getMeetings } from './api.js';
import { getSeasonData } from './season-data.js';
import { isPast, isThisWeek, formatDateRange, $ } from './utils.js';
import { showFutureRaceSchedule } from './race-detail.js';

let onRaceSelect = null;
let pendingMeetingSelection = null;
let controlsWired = false;

export function setRaceSelectHandler(handler) {
  onRaceSelect = handler;
}

/**
 * Programmatically jump to Calendar tab, highlight a specific GP card,
 * and open its Race Deep-Dive section.
 */
export function selectCalendarMeeting(meetingKey, sessionKey, meetingInfo) {
  const container = $('#calendar-scroll');
  const targetTab = '#calendar';
  if (window.location.hash !== targetTab) {
    window.location.hash = targetTab;
  }

  const card = container ? container.querySelector(`.race-card[data-meeting-key="${meetingKey}"]`) : null;
  if (card) {
    pendingMeetingSelection = null;
    container.querySelectorAll('.race-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');

    requestAnimationFrame(() => {
      const scrollOffset = card.offsetLeft - container.offsetWidth / 2 + card.offsetWidth / 2;
      container.scrollTo({ left: scrollOffset, behavior: 'smooth' });
    });

    const resolvedSessionKey = sessionKey || (card.dataset.sessionKey ? Number(card.dataset.sessionKey) : null);
    if (resolvedSessionKey && onRaceSelect) {
      const detailSec = $('#race-detail');
      if (detailSec) {
        detailSec.style.display = 'block';
        detailSec.classList.add('active-tab');
      }
      onRaceSelect(resolvedSessionKey, meetingInfo);
      setTimeout(() => {
        detailSec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    }
  } else {
    // Calendar cards are still loading — queue selection and open detail immediately
    pendingMeetingSelection = { meetingKey, sessionKey, meetingInfo };
    if (sessionKey && onRaceSelect) {
      const detailSec = $('#race-detail');
      if (detailSec) {
        detailSec.style.display = 'block';
        detailSec.classList.add('active-tab');
      }
      onRaceSelect(sessionKey, meetingInfo);
    }
  }
}

let currentCalendarFilter = 'all';
let currentCalendarView = 'carousel'; // 'carousel' or 'grid'

function applyCalendarFilter() {
  const container = $('#calendar-scroll');
  if (!container) return;

  const cards = container.querySelectorAll('.race-card');
  cards.forEach(card => {
    const isUpcoming = card.classList.contains('upcoming');
    const hasSprint = Boolean(card.querySelector('.race-card-sprint-pill'));

    let visible = true;
    if (currentCalendarFilter === 'completed') {
      visible = !isUpcoming;
    } else if (currentCalendarFilter === 'upcoming') {
      visible = isUpcoming;
    } else if (currentCalendarFilter === 'sprint') {
      visible = hasSprint;
    }

    card.style.display = visible ? '' : 'none';
  });
}

function wireCalendarControls() {
  if (controlsWired) return;
  const prevBtn = document.getElementById('cal-scroll-prev');
  const nextBtn = document.getElementById('cal-scroll-next');
  const latestBtn = document.getElementById('cal-jump-latest');
  const viewCarouselBtn = document.getElementById('cal-view-carousel');
  const viewGridBtn = document.getElementById('cal-view-grid');
  const filterBtns = document.querySelectorAll('#calendar-filters .cal-filter-btn');

  controlsWired = true;

  // View Mode: Carousel vs Grid
  if (viewCarouselBtn && viewGridBtn) {
    viewCarouselBtn.addEventListener('click', () => {
      currentCalendarView = 'carousel';
      viewCarouselBtn.classList.add('active');
      viewGridBtn.classList.remove('active');
      const container = $('#calendar-scroll');
      if (container) container.classList.remove('grid-mode');
    });

    viewGridBtn.addEventListener('click', () => {
      currentCalendarView = 'grid';
      viewGridBtn.classList.add('active');
      viewCarouselBtn.classList.remove('active');
      const container = $('#calendar-scroll');
      if (container) container.classList.add('grid-mode');
    });
  }

  // Filter chips
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCalendarFilter = btn.dataset.filter || 'all';
      applyCalendarFilter();
    });
  });

  prevBtn?.addEventListener('click', () => {
    const container = $('#calendar-scroll');
    if (container) container.scrollBy({ left: -520, behavior: 'smooth' });
  });

  nextBtn?.addEventListener('click', () => {
    const container = $('#calendar-scroll');
    if (container) container.scrollBy({ left: 520, behavior: 'smooth' });
  });

  latestBtn?.addEventListener('click', () => {
    const container = $('#calendar-scroll');
    if (!container) return;
    const currentCard = container.querySelector('.race-card.current');
    const completedCards = container.querySelectorAll('.race-card:not(.upcoming)');
    const firstUpcoming = container.querySelector('.race-card.upcoming');
    const target = currentCard || (completedCards.length > 0 ? completedCards[completedCards.length - 1] : firstUpcoming);
    if (target) {
      if (currentCalendarView === 'carousel') {
        const scrollOffset = target.offsetLeft - container.offsetWidth / 2 + target.offsetWidth / 2;
        container.scrollTo({ left: scrollOffset, behavior: 'smooth' });
      } else {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      target.click();
    }
  });
}

export async function initCalendar(year) {
  const container = $('#calendar-scroll');
  wireCalendarControls();
  container.innerHTML = Array(8).fill('<div class="skeleton skeleton-card" style="flex:0 0 240px;height:260px;"></div>').join('');

  try {
    const [meetings, seasonData] = await Promise.all([
      getMeetings(year),
      getSeasonData(year), // already compiled from standings
    ]);

    // Swap 2026 Spanish GP (Madrid) and Barcelona GP (Catalunya) track maps if mismatched in the API
    if (year === 2026) {
      const spanishGP = meetings.find(m => m.meeting_name && m.meeting_name.includes('Spanish'));
      const barcelonaGP = meetings.find(m => m.meeting_name && m.meeting_name.includes('Barcelona'));
      if (spanishGP && barcelonaGP) {
        const tempImg = spanishGP.circuit_image;
        spanishGP.circuit_image = barcelonaGP.circuit_image;
        barcelonaGP.circuit_image = tempImg;
        console.log('[Calendar] Swapped 2026 Spanish GP and Barcelona GP circuit outlines to correct Madrid/Barcelona mismatch.');
      }
    }

    // Filter to Grand Prix events that are not cancelled
    const gps = meetings.filter(m =>
      m.meeting_name.includes('Grand Prix') && !m.is_cancelled
    );

    const allRaceSessions = seasonData.totalRaceSessions || [];
    const fullRaces = allRaceSessions.filter(s => s.session_name === 'Race');
    const sprintMeetings = new Set(
      allRaceSessions.filter(s => s.session_name === 'Sprint').map(s => s.meeting_key)
    );

    // Get winners from compiled data (zero API calls)
    const winners = new Map();
    for (const race of (seasonData.races || [])) {
      if (race.session_name !== 'Race' || !race.results.length) continue;
      const winnerNum = race.results[0].driver_number;
      const raceDriver = race.drivers ? race.drivers.find(d => d.driver_number === winnerNum) : null;
      const winnerAcronym = raceDriver ? raceDriver.name_acronym : null;
      const winnerInfo = winnerAcronym ? seasonData.drivers.get(winnerAcronym) : null;
      winners.set(race.meeting_key, {
        name: winnerInfo ? winnerInfo.name_acronym : `#${winnerNum}`,
        fullName: winnerInfo ? winnerInfo.full_name : `#${winnerNum}`,
      });
    }

    container.innerHTML = '';

    gps.forEach((gp, i) => {
      const raceSession = fullRaces.find(s => s.meeting_key === gp.meeting_key);
      const completed = raceSession ? isPast(raceSession.date_end) : isPast(gp.date_end);
      const hasStarted = isPast(gp.date_start);
      const current = isThisWeek(gp.date_start, gp.date_end);
      const isSprint = sprintMeetings.has(gp.meeting_key);
      const winner = winners.get(gp.meeting_key);

      const card = document.createElement('div');
      card.className = `race-card${(completed || hasStarted) ? '' : ' upcoming'}${current ? ' current' : ''}`;
      card.dataset.meetingKey = gp.meeting_key;
      if (raceSession) card.dataset.sessionKey = raceSession.session_key;

      // Render country flag as full-bleed background
      const flagBg = gp.country_flag
        ? `<img class="race-card-flag-bg" src="${gp.country_flag}" alt="${gp.country_code}" loading="lazy">`
        : '';

      // Render circuit outline overlay in center if available (hide on error, no map fallback)
      const circuitImg = gp.circuit_image
        ? `<img class="race-card-circuit" src="${gp.circuit_image}" alt="${gp.circuit_short_name}" loading="lazy" onerror="this.style.display='none'">`
        : '';

      const sprintBadgeHtml = isSprint
        ? `<span class="race-card-sprint-pill"><i class="fa-solid fa-bolt"></i> Sprint</span>`
        : '';

      const winnerHtml = winner
        ? `<div class="race-card-winner"><span class="trophy" style="display:inline-flex;align-items:center;"><i class="fa-solid fa-trophy" style="color: #ffd700; margin-right: 4px;"></i></span><span class="winner-name">${winner.fullName}</span></div>`
        : `<div class="race-card-upcoming-cta"><span><i class="fa-regular fa-clock"></i> View Schedule</span><i class="fa-solid fa-chevron-right"></i></div>`;

      card.innerHTML = `
        <div class="race-card-header">
          ${flagBg}
          ${circuitImg}
          ${sprintBadgeHtml}
        </div>
        <div class="race-card-body">
          <div class="race-card-round-row">
            <span class="race-card-round">Round ${i + 1}</span>
            ${completed ? '<span class="race-card-status done"><i class="fa-solid fa-check"></i> Completed</span>' : ''}
          </div>
          <div class="race-card-name">${gp.meeting_name.replace(' Grand Prix', ' GP')}</div>
          <div class="race-card-location">${gp.circuit_short_name}, ${gp.country_name}</div>
          <div class="race-card-date">${formatDateRange(gp.date_start, gp.date_end)}</div>
          ${winnerHtml}
        </div>
      `;

      card.addEventListener('click', () => {
        container.querySelectorAll('.race-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        if ((completed || hasStarted) && raceSession) {
          if (onRaceSelect) {
            onRaceSelect(raceSession.session_key, gp);
          }
        } else {
          showFutureRaceSchedule(gp);
        }
      });

      container.appendChild(card);
    });

    applyCalendarFilter();

    // Honor pending Dashboard jump if requested while loading
    if (pendingMeetingSelection) {
      const pendingCard = container.querySelector(`.race-card[data-meeting-key="${pendingMeetingSelection.meetingKey}"]`);
      pendingMeetingSelection = null;
      if (pendingCard) {
        container.querySelectorAll('.race-card').forEach(c => c.classList.remove('active'));
        pendingCard.classList.add('active');
        setTimeout(() => {
          const scrollOffset = pendingCard.offsetLeft - container.offsetWidth / 2 + pendingCard.offsetWidth / 2;
          container.scrollLeft = scrollOffset;
        }, 100);
        return;
      }
    }

    // Scroll to current/latest completed race inside the horizontal scroll container (instantly to prevent vertical page jumps)
    const currentCard = container.querySelector('.race-card.current');
    const lastCompletedCards = container.querySelectorAll('.race-card:not(.upcoming)');
    const scrollTarget = currentCard || (lastCompletedCards.length > 0 ? lastCompletedCards[lastCompletedCards.length - 1] : null);
    if (scrollTarget) {
      setTimeout(() => {
        const scrollOffset = scrollTarget.offsetLeft - container.offsetWidth / 2 + scrollTarget.offsetWidth / 2;
        container.scrollLeft = scrollOffset;
      }, 150);
      
      // Auto-click to default open the newest/current race weekend session details
      scrollTarget.click();
    }

  } catch (err) {
    console.error('Calendar init failed:', err);
    container.innerHTML = '<div class="no-data" style="width:100%;"><div class="no-data-text">Failed to load calendar</div></div>';
  }
}
