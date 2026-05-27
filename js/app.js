// =============================================
// PITCORNER — Main App Orchestrator
// =============================================

import { initDashboard } from './dashboard.js';
import { initStandings } from './standings.js';
import { initCalendar, setRaceSelectHandler } from './calendar.js';
import { loadRaceDetail } from './race-detail.js';
import { initH2H } from './h2h.js';
import { getCacheStats, clearCache } from './api.js';
import { clearSeasonCache } from './season-data.js';
import { setupRevealAnimations, $ } from './utils.js';
import { initFeedbackSupport } from './feedback-support.js';

// Available years (OpenF1 data from 2023+)
const AVAILABLE_YEARS = [2026, 2025, 2024, 2023];
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

  // Setup year selector
  const yearSelect = $('#year-select');
  yearSelect.innerHTML = '';
  for (const y of AVAILABLE_YEARS) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === currentYear) opt.selected = true;
    yearSelect.appendChild(opt);
  }

  yearSelect.addEventListener('change', (e) => {
    currentYear = parseInt(e.target.value);
    localStorage.setItem('pitcorner_selected_year', currentYear);
    loadAll(currentYear);
  });

  // Setup navigation
  setupNav();
  setupBackToTop();

  // Setup feedback & support event listeners
  initFeedbackSupport();

  // Setup race select callback
  setRaceSelectHandler((sessionKey, meetingInfo) => {
    loadRaceDetail(sessionKey, meetingInfo);
  });

  // Setup clear cache button
  const clearBtn = document.getElementById('clear-cache-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearCache();
      clearSeasonCache();
      updateCacheStatus();
      loadAll(currentYear);
    });
  }

  // Load everything
  loadAll(currentYear);
}

async function loadAll(year) {
  // Increment generation — any in-flight load for a previous year will bail out
  const gen = ++loadGeneration;

  // Show loading banner
  const loadingBanner = $('#api-loading-banner');
  if (loadingBanner) {
    loadingBanner.classList.add('show');
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
  updateCacheStatus();

  // Hide loading banner when loaded successfully
  if (loadingBanner) {
    loadingBanner.classList.remove('show');
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

function updateCacheStatus() {
  const stats = getCacheStats();
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
