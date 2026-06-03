// =============================================
// PITCORNER — Main App Orchestrator
// =============================================

import { initDashboard } from './dashboard.js';
import { initStandings } from './standings.js';
import { initCalendar, setRaceSelectHandler } from './calendar.js';
import { loadRaceDetail } from './race-detail.js';
import { initH2H } from './h2h.js';
import { getCacheStats, clearCache, clearSingleSeasonAPICache } from './api.js';
import { clearSeasonCache, isSeasonPreliminary, clearSingleSeasonCache } from './season-data.js';
import { setupRevealAnimations, $ } from './utils.js';
import { initFeedbackSupport, showClearCacheModal } from './feedback-support.js';
import { openSeasonPickerModal } from './season-picker.js';

// Available years (1950-2022 Jolpi Ergast mirror, 2023+ OpenF1)
const AVAILABLE_YEARS = [];
for (let y = 2026; y >= 1950; y--) {
  AVAILABLE_YEARS.push(y);
}
let currentYear = 2026;

// Generation counter — prevents stale loads when switching years rapidly
let loadGeneration = 0;

async function init() {
  // Determine default year — use last selected year from localStorage, fallback to current year
  const savedYear = localStorage.getItem('pitcorner_selected_year');
  if (savedYear && AVAILABLE_YEARS.includes(parseInt(savedYear))) {
    currentYear = parseInt(savedYear);
  } else {
    const now = new Date();
    const thisYear = now.getFullYear();
    if (AVAILABLE_YEARS.includes(thisYear)) {
      currentYear = thisYear;
    }
  }

  // Setup year selector using our premium visual cockpit grid modal
  const currentYearDisplay = $('#current-year-display');
  if (currentYearDisplay) {
    currentYearDisplay.textContent = currentYear;
  }

  const trigger = $('#year-select-trigger');
  if (trigger) {
    trigger.addEventListener('click', () => {
      openSeasonPickerModal(currentYear, AVAILABLE_YEARS, (selectedYear) => {
        currentYear = selectedYear;
        localStorage.setItem('pitcorner_selected_year', currentYear);
        if (currentYearDisplay) {
          currentYearDisplay.textContent = currentYear;
        }
        loadAll(currentYear);
      });
    });
  }

  // Setup navigation
  setupNav();
  setupBackToTop();

  // Setup feedback & support event listeners
  initFeedbackSupport();

  // Setup race select callback
  setRaceSelectHandler((sessionKey, meetingInfo) => {
    loadRaceDetail(sessionKey, meetingInfo);
  });

  // Setup clear cache button with confirmation modal and single-season option
  const clearBtn = document.getElementById('clear-cache-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      showClearCacheModal(
        currentYear,
        // Option 1: Clear current season only
        async () => {
          await clearSingleSeasonAPICache(currentYear);
          await clearSingleSeasonCache(currentYear);
          await updateCacheStatus();
          loadAll(currentYear);
        },
        // Option 2: Clear entire cache
        async () => {
          await clearCache();
          await clearSeasonCache();
          await updateCacheStatus();
          loadAll(currentYear);
        }
      );
    });
  }

  // Load everything
  loadAll(currentYear);

  // Setup background refresh listener
  document.addEventListener('pitcorner:season-updated', async (e) => {
    if (e.detail.year === currentYear) {
      console.log('[App] 🔄 Background season update received. Silently re-rendering...');
      try {
        const forceResetChart = !e.detail.seasonData.is_fetching_background;
        await initDashboard(currentYear, forceResetChart);
        await initStandings(currentYear);
        await initCalendar(currentYear);
        await initH2H(currentYear);
      } catch (err) {
        console.warn('[App] Silent background refresh failed:', err);
      }
      
      const loadingBanner = $('#api-loading-banner');
      if (loadingBanner) {
        if (e.detail.seasonData.is_fetching_background) {
          const textEl = loadingBanner.querySelector('.api-loading-text');
          if (textEl) {
            const racesCount = e.detail.seasonData.races.length;
            const totalRaces = e.detail.seasonData.totalRaceSessions.filter(s => new Date(s.date_end) < new Date()).length;
            textEl.innerHTML = `
              <strong>Syncing Telemetry (${racesCount}/${totalRaces} sessions compiled)... 🏁</strong>
              <span>PitCorner is fetching real-time telemetry. Standings are fully interactive and update instantly in the background!</span>
            `;
          }
        } else if (e.detail.seasonData.is_preliminary) {
          const textEl = loadingBanner.querySelector('.api-loading-text');
          if (textEl) {
            textEl.innerHTML = `
              <strong>Warning: Partial Standings Data</strong>
              <span>Failed to fetch some completed sessions due to OpenF1 API timeouts. Displaying partial standings. Retrying on next load! ⚠️</span>
            `;
          }
          setTimeout(() => {
            loadingBanner.classList.remove('show');
          }, 5000);
        } else {
          loadingBanner.classList.remove('show');
        }
      }
      await updateCacheStatus();
    }
  });
}

async function loadAll(year) {
  // Increment generation — any in-flight load for a previous year will bail out
  const gen = ++loadGeneration;

  // Show loading banner
  const loadingBanner = $('#api-loading-banner');
  if (loadingBanner) {
    loadingBanner.classList.add('show');
    // Restore default text
    const textEl = loadingBanner.querySelector('.api-loading-text');
    if (textEl) {
      const isHistorical = parseInt(year) <= 2022;
      const apiName = isHistorical ? 'Historical Ergast F1 Data' : 'Live OpenF1 Data';
      textEl.innerHTML = `
        <strong>Streaming ${apiName}...</strong>
        <span>PitCorner is 100% free &amp; fetches real-time telemetry. This may take a moment — thank you for your patience! 🏁</span>
      `;
    }
  }

  // Reset race detail
  const raceDetail = $('#race-detail');
  raceDetail.style.display = 'none';

  // Show loading state immediately for all sections
  showLoadingStates();

  // Load sections SEQUENTIALLY to respect API rate limits (3 req/s, 30 req/min).
  // Each module shares the API cache, so later modules benefit from earlier fetches.
  try {
    await initDashboard(year);
  } catch (e) { console.warn('Dashboard init error:', e); }
  if (gen !== loadGeneration) return; // Year changed while loading

  try {
    await initStandings(year);
  } catch (e) { console.warn('Standings init error:', e); }
  if (gen !== loadGeneration) return;

  try {
    await initCalendar(year);
  } catch (e) { console.warn('Calendar init error:', e); }
  if (gen !== loadGeneration) return;

  try {
    await initH2H(year);
  } catch (e) { console.warn('H2H init error:', e); }
  if (gen !== loadGeneration) return;

  // Setup reveal animations
  setTimeout(() => setupRevealAnimations(), 500);

  // Update cache stats in footer
  await updateCacheStatus();

  // Hide loading banner when loaded successfully, or update text if preliminary
  const isPrelim = isSeasonPreliminary(year);
  if (!isPrelim && loadingBanner) {
    loadingBanner.classList.remove('show');
  } else if (isPrelim && loadingBanner) {
    const textEl = loadingBanner.querySelector('.api-loading-text');
    if (textEl) {
      textEl.innerHTML = `
        <strong>Syncing Missing Telemetry (BG)...</strong>
        <span>PitCorner loaded the cached standings instantly and is fetching the latest completed sessions in the background! 🏁</span>
      `;
    }
  }
}

function showLoadingStates() {
  // Standings
  const standingsContent = $('#standings-content');
  if (standingsContent) {
    standingsContent.innerHTML = Array(8).fill('<div class="skeleton skeleton-row"></div>').join('');
  }

  // Calendar
  const calendarScroll = $('#calendar-scroll');
  if (calendarScroll) {
    calendarScroll.innerHTML = Array(6).fill('<div class="skeleton skeleton-card" style="flex:0 0 240px;height:260px;"></div>').join('');
  }

  // H2H
  const h2hComparison = $('#h2h-comparison');
  if (h2hComparison) {
    h2hComparison.innerHTML = Array(5).fill('<div class="skeleton skeleton-row"></div>').join('');
  }

  // Reset hero stats
  const statIds = ['stat-races', 'stat-sprints', 'stat-overtakes', 'stat-fastest'];
  for (const id of statIds) {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  }
}

async function updateCacheStatus() {
  const stats = await getCacheStats();
  const infoEl = document.getElementById('cache-info');
  if (infoEl) {
    infoEl.textContent = `💾 ${stats.localStorage} entries cached (${stats.localStorageKB} KB)`;
  }
}

function setupNav() {
  // Active link tracking
  const sections = document.querySelectorAll('.section[id]');
  const navLinks = document.querySelectorAll('.nav-links a, .mobile-menu a');

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        navLinks.forEach(link => {
          link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
        });
      }
    }
  }, { rootMargin: '-30% 0px -70% 0px' });

  sections.forEach(s => observer.observe(s));

  // Mobile menu toggle
  const toggle = $('#nav-toggle');
  const mobileMenu = $('#mobile-menu');

  if (toggle && mobileMenu) {
    toggle.addEventListener('click', () => {
      mobileMenu.classList.toggle('open');
    });

    // Close on link click
    mobileMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        mobileMenu.classList.remove('open');
      });
    });
  }
}

function setupBackToTop() {
  const backToTopBtn = document.getElementById('back-to-top-btn');
  if (!backToTopBtn) return;

  // Toggle visibility on scroll
  window.addEventListener('scroll', () => {
    if (window.scrollY > 400) {
      backToTopBtn.classList.add('show');
    } else {
      backToTopBtn.classList.remove('show');
    }
  });

  // Smooth scroll back to top when clicked
  backToTopBtn.addEventListener('click', () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
