// =============================================
// F1 CORNER — Utility Functions
// =============================================

/**
 * Format seconds to lap time string: 1:15.234
 */
export function formatLapTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  if (mins > 0) {
    return `${mins}:${secs.padStart(6, '0')}`;
  }
  return secs;
}

/**
 * Format gap: +1.234s
 */
export function formatGap(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  if (seconds === 0) return 'LEADER';
  return `+${seconds.toFixed(3)}s`;
}

/**
 * Get CSS color from team_colour hex string
 */
export function getTeamColor(teamColour) {
  if (!teamColour) return '#666666';
  return `#${teamColour}`;
}

/**
 * Get tyre compound CSS color
 */
export function getCompoundColor(compound) {
  if (!compound) return '#666';
  switch (compound.toUpperCase()) {
    case 'SOFT': return '#ff3333';
    case 'MEDIUM': return '#ffd000';
    case 'HARD': return '#e0e0e0';
    case 'INTERMEDIATE': return '#39b54a';
    case 'WET': return '#2b7bcd';
    default: return '#666';
  }
}

/**
 * Get tyre compound CSS class
 */
export function getCompoundClass(compound) {
  if (!compound) return '';
  return compound.toLowerCase();
}

/**
 * F1 Points system (modern: 2025)
 * Positions 1–10 score, no fastest lap bonus from API easily
 */
const POINTS_MAP = {
  1: 25, 2: 18, 3: 15, 4: 12, 5: 10,
  6: 8, 7: 6, 8: 4, 9: 2, 10: 1
};

const SPRINT_POINTS_MAP = {
  1: 8, 2: 7, 3: 6, 4: 5, 5: 4,
  6: 3, 7: 2, 8: 1
};

export function getPointsForPosition(position, isSprint = false) {
  const map = isSprint ? SPRINT_POINTS_MAP : POINTS_MAP;
  return map[position] || 0;
}

/**
 * Format date string to readable: "May 25"
 * Uses UTC to match the race calendar (API provides UTC + offset)
 */
export function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Format date range: "Mar 14–16"
 * Uses UTC dates. The API's date_end often includes a buffer past midnight,
 * so we subtract 6 hours to snap back to the actual race day.
 */
export function formatDateRange(startStr, endStr) {
  if (!startStr || !endStr) return '';
  const start = new Date(startStr);
  // Snap end date back by 6 hours to avoid midnight rollover
  // (e.g., "May 24 22:00 UTC" in local time = "May 25" which is wrong)
  const end = new Date(new Date(endStr).getTime() - 6 * 60 * 60 * 1000);

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sMonth = months[start.getUTCMonth()];
  const eMonth = months[end.getUTCMonth()];
  const sDay = start.getUTCDate();
  const eDay = end.getUTCDate();

  if (sMonth === eMonth) {
    return `${sMonth} ${sDay}–${eDay}`;
  }
  return `${sMonth} ${sDay} – ${eMonth} ${eDay}`;
}

/**
 * Check if a date is in the past
 */
export function isPast(dateStr) {
  return new Date(dateStr) < new Date();
}

/**
 * Check if date is this week
 */
export function isThisWeek(startStr, endStr) {
  const now = new Date();
  const start = new Date(startStr);
  const end = new Date(endStr);

  // If the race weekend has already concluded, it is no longer "this week's" active race
  if (now > end) {
    return false;
  }

  // Give a 1-day buffer before the start (build-up starts on Thursday/Friday)
  start.setDate(start.getDate() - 1);
  return now >= start && now <= end;
}

/**
 * Create shimmer loading skeleton elements
 */
export function createSkeletonRows(count, container) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'skeleton skeleton-row';
    container.appendChild(row);
  }
}

/**
 * Intersection Observer for reveal animations
 */
export function setupRevealAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
  return observer;
}

/**
 * Debounce function
 */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Get ordinal suffix: 1st, 2nd, 3rd...
 */
export function ordinal(n) {
  if (n == null) return '—';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Group array by a key function
 */
export function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/**
 * Build a driver lookup map from drivers array
 * Returns Map<driver_number, driver_info>
 */
export function buildDriverMap(drivers) {
  const map = new Map();
  for (const d of drivers) {
    map.set(d.driver_number, d);
  }
  return map;
}

/**
 * Safe element accessor
 */
export function $(selector) {
  return document.querySelector(selector);
}

export function $$(selector) {
  return document.querySelectorAll(selector);
}

// ── Official F1 Driver Photo URL Mapper ──

const OFFICIAL_F1_PHOTOS = {
  VER: 'versta01',
  HAM: 'hamilt01',
  LEC: 'lecler01',
  NOR: 'norris01',
  SAI: 'sainz01',
  PIA: 'piastr01',
  RUS: 'russel01',
  PER: 'perez01',
  ALO: 'alonso01',
  STR: 'stroll01',
  GAS: 'gasly01',
  OCO: 'ocon01',
  ALB: 'albon01',
  TSU: 'tsunod01',
  HUL: 'hulken01',
  BOT: 'bottas01',
  LAW: 'lawson01',
  COL: 'colapi01',
  BEA: 'bearma01',
  ANT: 'antone01',
  BOR: 'bortol01',
  HAD: 'hadjar01',
  ZHO: 'guanyu01',
  MAG: 'magnus01',
  SAR: 'sargea01',
  LIN: 'lindba01'
};

export function getDriverHeadshot(acronym, year = 2025) {
  const file = OFFICIAL_F1_PHOTOS[acronym?.toUpperCase()];
  if (!file) return null;
  return `https://media.formula1.com/d_driver_fallback_image.png/content/dam/fom-website/drivers/${year}Drivers/${file}.png`;
}
