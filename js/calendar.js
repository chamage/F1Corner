// =============================================
// F1 CORNER — Race Calendar
// Uses compiled season data (shared)
// =============================================

import { getMeetings } from './api.js';
import { getSeasonData } from './season-data.js';
import { isPast, isThisWeek, formatDateRange, $ } from './utils.js';

let onRaceSelect = null;

export function setRaceSelectHandler(handler) {
  onRaceSelect = handler;
}

export async function initCalendar(year) {
  const container = $('#calendar-scroll');
  container.innerHTML = Array(8).fill('<div class="skeleton skeleton-card" style="flex:0 0 240px;height:260px;"></div>').join('');

  try {
    const [meetings, seasonData] = await Promise.all([
      getMeetings(year),
      getSeasonData(year), // already compiled from standings
    ]);

    // Filter to Grand Prix events that are not cancelled
    const gps = meetings.filter(m =>
      m.meeting_name.includes('Grand Prix') && !m.is_cancelled
    );

    const allRaceSessions = seasonData.totalRaceSessions || [];
    const fullRaces = allRaceSessions.filter(s => s.session_name === 'Race');

    // Get winners from compiled data (zero API calls)
    const winners = new Map();
    for (const race of (seasonData.races || [])) {
      if (race.session_name !== 'Race' || !race.results.length) continue;
      const winnerNum = race.results[0].driver_number;
      const winnerInfo = seasonData.drivers.get(winnerNum);
      winners.set(race.meeting_key, {
        name: winnerInfo ? winnerInfo.name_acronym : `#${winnerNum}`,
        fullName: winnerInfo ? winnerInfo.full_name : `#${winnerNum}`,
      });
    }

    container.innerHTML = '';

    gps.forEach((gp, i) => {
      const raceSession = fullRaces.find(s => s.meeting_key === gp.meeting_key);
      const completed = raceSession ? isPast(raceSession.date_end) : isPast(gp.date_end);
      const current = isThisWeek(gp.date_start, gp.date_end);
      const winner = winners.get(gp.meeting_key);

      const card = document.createElement('div');
      card.className = `race-card${completed ? '' : ' upcoming'}${current ? ' current' : ''}`;
      card.dataset.meetingKey = gp.meeting_key;
      if (raceSession) card.dataset.sessionKey = raceSession.session_key;

      // Circuit image uses 'race-card-circuit' class (has filter:invert), flag does NOT
      const circuitImg = gp.circuit_image
        ? `<img class="race-card-circuit" src="${gp.circuit_image}" alt="${gp.circuit_short_name}" loading="lazy" onerror="this.style.display='none'">`
        : '';

      const flagImg = gp.country_flag
        ? `<img class="race-card-flag" src="${gp.country_flag}" alt="${gp.country_code}" loading="lazy">`
        : '';

      const winnerHtml = winner
        ? `<div class="race-card-winner"><span class="trophy">🏆</span><span class="winner-name">${winner.fullName}</span></div>`
        : '';

      card.innerHTML = `
        <div class="race-card-header">
          ${circuitImg}
          ${flagImg}
        </div>
        <div class="race-card-body">
          <div class="race-card-round">Round ${i + 1}</div>
          <div class="race-card-name">${gp.meeting_name.replace(' Grand Prix', ' GP')}</div>
          <div class="race-card-location">${gp.circuit_short_name}, ${gp.country_name}</div>
          <div class="race-card-date">${formatDateRange(gp.date_start, gp.date_end)}</div>
          ${winnerHtml}
        </div>
      `;

      if (completed && raceSession) {
        card.addEventListener('click', () => {
          container.querySelectorAll('.race-card').forEach(c => c.classList.remove('active'));
          card.classList.add('active');
          if (onRaceSelect) {
            onRaceSelect(raceSession.session_key, gp);
          }
        });
      }

      container.appendChild(card);
    });

    // Scroll to current/latest completed race
    const currentCard = container.querySelector('.race-card.current');
    const lastCompletedCards = container.querySelectorAll('.race-card:not(.upcoming)');
    const scrollTarget = currentCard || (lastCompletedCards.length > 0 ? lastCompletedCards[lastCompletedCards.length - 1] : null);
    if (scrollTarget) {
      setTimeout(() => {
        scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }, 300);
    }

  } catch (err) {
    console.error('Calendar init failed:', err);
    container.innerHTML = '<div class="no-data" style="width:100%;"><div class="no-data-text">Failed to load calendar</div></div>';
  }
}
