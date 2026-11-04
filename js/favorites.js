// =============================================
// PITCORNER — Favorite Driver & Team Pinning
// Persistent local personalization with live event sync
// =============================================

import { getSeasonData, computeStandingsFromSeason } from './season-data.js';
import { getTeamColor, getDriverFlagImg } from './utils.js';

const STORAGE_KEY = 'pitcorner_favorites_v1';

let favState = loadFromStorage();
let favOverlay = null;
let activeModalYear = null;
let activeModalStandings = null;
let activeModalTab = 'drivers'; // 'drivers' | 'teams'
let activeModalSearch = '';

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { driver: null, team: null };
    const parsed = JSON.parse(raw);
    return {
      driver: typeof parsed?.driver === 'string' && parsed.driver.trim() ? parsed.driver.trim() : null,
      team: typeof parsed?.team === 'string' && parsed.team.trim() ? parsed.team.trim() : null,
    };
  } catch {
    return { driver: null, team: null };
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favState));
  } catch (e) {
    console.warn('[Favorites] Failed to persist favorites:', e);
  }
}

function emitFavoritesChanged() {
  updateNavFavoritesBadge();
  window.dispatchEvent(new CustomEvent('pitcorner:favorites-changed', {
    detail: { ...favState }
  }));
}

export function getFavorites() {
  return { ...favState };
}

export function isFavoriteDriver(acronym) {
  if (!acronym || !favState.driver) return false;
  return favState.driver.toUpperCase() === String(acronym).trim().toUpperCase();
}

export function isFavoriteTeam(teamName) {
  if (!teamName || !favState.team) return false;
  return favState.team.toLowerCase() === String(teamName).trim().toLowerCase();
}

export function setFavoriteDriver(acronym) {
  const clean = typeof acronym === 'string' && acronym.trim() ? acronym.trim().toUpperCase() : null;
  if (favState.driver === clean) return;
  favState.driver = clean;
  saveToStorage();
  emitFavoritesChanged();
}

export function setFavoriteTeam(teamName) {
  const clean = typeof teamName === 'string' && teamName.trim() ? teamName.trim() : null;
  if (favState.team === clean) return;
  favState.team = clean;
  saveToStorage();
  emitFavoritesChanged();
}

export function toggleFavoriteDriver(acronym) {
  if (!acronym) return false;
  if (isFavoriteDriver(acronym)) {
    setFavoriteDriver(null);
    return false;
  } else {
    setFavoriteDriver(acronym);
    return true;
  }
}

export function toggleFavoriteTeam(teamName) {
  if (!teamName) return false;
  if (isFavoriteTeam(teamName)) {
    setFavoriteTeam(null);
    return false;
  } else {
    setFavoriteTeam(teamName);
    return true;
  }
}

function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Update the Navbar Favorites button state & badge
 */
export function updateNavFavoritesBadge() {
  const btn = document.getElementById('nav-favorites-btn');
  const icon = document.getElementById('nav-fav-icon');
  const label = document.getElementById('nav-fav-label');
  if (!btn) return;

  const hasAny = Boolean(favState.driver || favState.team);
  btn.classList.toggle('has-favorites', hasAny);

  if (icon) {
    icon.className = hasAny ? 'fa-solid fa-star' : 'fa-regular fa-star';
  }

  if (label) {
    if (favState.driver && favState.team) {
      const shortTeam = favState.team.length > 9 ? favState.team.substring(0, 3).toUpperCase() : favState.team;
      label.textContent = `${favState.driver} · ${shortTeam}`;
    } else if (favState.driver) {
      label.textContent = favState.driver;
    } else if (favState.team) {
      label.textContent = favState.team.length > 11 ? `${favState.team.substring(0, 9)}…` : favState.team;
    } else {
      label.textContent = 'Favorites';
    }
  }
}

function ensureFavoritesOverlay() {
  if (favOverlay) return favOverlay;
  favOverlay = document.getElementById('favorites-modal-overlay');
  if (!favOverlay) {
    favOverlay = document.createElement('div');
    favOverlay.className = 'driver-modal-overlay';
    favOverlay.id = 'favorites-modal-overlay';
    favOverlay.innerHTML = '<div class="driver-modal fav-picker-modal" id="favorites-modal"></div>';
    document.body.appendChild(favOverlay);
  }

  favOverlay.addEventListener('click', (e) => {
    if (e.target === favOverlay) closeFavoritesModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && favOverlay.classList.contains('open')) {
      closeFavoritesModal();
    }
  });

  return favOverlay;
}

export function closeFavoritesModal() {
  if (favOverlay) {
    favOverlay.classList.remove('open');
    document.body.style.overflow = '';
  }
}

function renderFavoritesModalBody() {
  const modal = document.getElementById('favorites-modal');
  if (!modal || !activeModalStandings) return;

  const drivers = activeModalStandings.drivers || [];
  const constructors = activeModalStandings.constructors || [];
  const q = activeModalSearch.trim().toLowerCase();

  const pinnedDriverObj = favState.driver
    ? drivers.find(d => d.name_acronym?.toUpperCase() === favState.driver.toUpperCase())
    : null;
  const pinnedTeamObj = favState.team
    ? constructors.find(t => t.team_name?.toLowerCase() === favState.team.toLowerCase())
    : null;

  const driverChipHtml = favState.driver
    ? `
      <div class="fav-active-chip" style="--fav-chip-color:${pinnedDriverObj ? getTeamColor(pinnedDriverObj.team_colour) : 'var(--f1-red)'}">
        <i class="fa-solid fa-star" style="color:#ffd700;font-size:0.72rem;"></i>
        <span>Driver: <strong>${escapeAttr(pinnedDriverObj ? pinnedDriverObj.full_name : favState.driver)}</strong></span>
        <button type="button" class="fav-chip-clear" id="fav-clear-driver" title="Unpin favorite driver" aria-label="Unpin favorite driver">✕</button>
      </div>
    `
    : `<div class="fav-active-chip empty"><i class="fa-regular fa-star"></i><span>No driver pinned</span></div>`;

  const teamChipHtml = favState.team
    ? `
      <div class="fav-active-chip" style="--fav-chip-color:${pinnedTeamObj ? getTeamColor(pinnedTeamObj.team_colour) : 'var(--f1-red)'}">
        <i class="fa-solid fa-star" style="color:#ffd700;font-size:0.72rem;"></i>
        <span>Team: <strong>${escapeAttr(favState.team)}</strong></span>
        <button type="button" class="fav-chip-clear" id="fav-clear-team" title="Unpin favorite team" aria-label="Unpin favorite team">✕</button>
      </div>
    `
    : `<div class="fav-active-chip empty"><i class="fa-regular fa-star"></i><span>No constructor pinned</span></div>`;

  let listHtml = '';
  if (activeModalTab === 'drivers') {
    const filtered = q
      ? drivers.filter(d =>
          (d.full_name || '').toLowerCase().includes(q) ||
          (d.name_acronym || '').toLowerCase().includes(q) ||
          (d.team_name || '').toLowerCase().includes(q) ||
          String(d.driver_number || '').includes(q)
        )
      : drivers;

    if (filtered.length === 0) {
      listHtml = `<div class="fav-empty-list">No drivers matching "${escapeAttr(activeModalSearch)}" in ${activeModalYear}.</div>`;
    } else {
      listHtml = `<div class="fav-picker-grid">
        ${filtered.map((d, idx) => {
          const isPinned = isFavoriteDriver(d.name_acronym);
          const color = getTeamColor(d.team_colour);
          const rank = drivers.indexOf(d) + 1;
          const avatar = d.headshot_url
            ? `<img class="fav-pick-avatar" src="${escapeAttr(d.headshot_url)}" alt="${escapeAttr(d.name_acronym)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';"><span class="fav-pick-monogram" style="display:none;border-color:${color};color:${color};">${escapeAttr(d.name_acronym)}</span>`
            : `<span class="fav-pick-monogram" style="border-color:${color};color:${color};">${escapeAttr(d.name_acronym)}</span>`;

          return `
            <button type="button" class="fav-pick-card ${isPinned ? 'pinned' : ''}" data-pick-driver="${escapeAttr(d.name_acronym)}" style="--pick-color:${color}">
              <span class="fav-pick-bar" style="background:${color}"></span>
              ${avatar}
              <div class="fav-pick-info">
                <div class="fav-pick-name">
                  ${getDriverFlagImg(d.name_acronym, 'width:14px;border-radius:1px;flex-shrink:0;')}
                  <span>${escapeAttr(d.full_name || d.name_acronym)}</span>
                </div>
                <div class="fav-pick-sub">P${rank} • ${d.points} pts • ${escapeAttr(d.team_name || 'Formula 1')}</div>
              </div>
              <span class="fav-pick-star ${isPinned ? 'active' : ''}" title="${isPinned ? 'Unpin driver' : 'Pin driver'}">
                <i class="fa-${isPinned ? 'solid' : 'regular'} fa-star"></i>
              </span>
            </button>
          `;
        }).join('')}
      </div>`;
    }
  } else {
    const filteredTeams = q
      ? constructors.filter(t =>
          (t.team_name || '').toLowerCase().includes(q) ||
          (t.drivers || []).some(dr => (dr.name || '').toLowerCase().includes(q))
        )
      : constructors;

    if (filteredTeams.length === 0) {
      listHtml = `<div class="fav-empty-list">No constructors matching "${escapeAttr(activeModalSearch)}" in ${activeModalYear}.</div>`;
    } else {
      listHtml = `<div class="fav-picker-grid teams">
        ${filteredTeams.map(t => {
          const isPinned = isFavoriteTeam(t.team_name);
          const color = getTeamColor(t.team_colour);
          const rank = constructors.indexOf(t) + 1;
          const driverLine = (t.drivers || []).map(dr => dr.name).join(' · ');

          return `
            <button type="button" class="fav-pick-card ${isPinned ? 'pinned' : ''}" data-pick-team="${escapeAttr(t.team_name)}" style="--pick-color:${color}">
              <span class="fav-pick-bar" style="background:${color}"></span>
              <span class="fav-pick-team-icon" style="background:${color}1f;border-color:${color}55;color:${color}">
                <i class="fa-solid fa-shield-halved"></i>
              </span>
              <div class="fav-pick-info">
                <div class="fav-pick-name"><span>${escapeAttr(t.team_name)}</span></div>
                <div class="fav-pick-sub">P${rank} • ${t.points} pts${driverLine ? ` • ${escapeAttr(driverLine)}` : ''}</div>
              </div>
              <span class="fav-pick-star ${isPinned ? 'active' : ''}" title="${isPinned ? 'Unpin constructor' : 'Pin constructor'}">
                <i class="fa-${isPinned ? 'solid' : 'regular'} fa-star"></i>
              </span>
            </button>
          `;
        }).join('')}
      </div>`;
    }
  }

  modal.innerHTML = `
    <button class="driver-modal-close" id="fav-modal-close" aria-label="Close">✕</button>
    <div class="fav-modal-shell">
      <div class="fav-modal-header">
        <div class="fav-modal-title-row">
          <span class="fav-modal-badge"><i class="fa-solid fa-star"></i></span>
          <div>
            <h2>Pin Favorite Driver &amp; Team</h2>
            <p>Pinned selections highlight across Standings, Race Telemetry, Command Center &amp; Head-to-Head.</p>
          </div>
        </div>
        <div class="fav-active-strip">
          ${driverChipHtml}
          ${teamChipHtml}
        </div>
      </div>

      <div class="fav-modal-controls">
        <div class="dm-tabs fav-modal-tabs" style="margin-bottom:0;">
          <button type="button" class="dm-tab ${activeModalTab === 'drivers' ? 'active' : ''}" data-fav-tab="drivers">
            <i class="fa-solid fa-helmet-un"></i> Drivers (${drivers.length})
          </button>
          <button type="button" class="dm-tab ${activeModalTab === 'teams' ? 'active' : ''}" data-fav-tab="teams">
            <i class="fa-solid fa-car-side"></i> Constructors (${constructors.length})
          </button>
        </div>
        <div class="fav-search-wrap">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input type="text" id="fav-modal-search" placeholder="Search ${activeModalTab === 'drivers' ? 'driver or team' : 'constructor'}..." value="${escapeAttr(activeModalSearch)}" autocomplete="off">
        </div>
      </div>

      <div class="fav-modal-list custom-scrollbar" id="fav-modal-list">
        ${listHtml}
      </div>
    </div>
  `;

  document.getElementById('fav-modal-close')?.addEventListener('click', closeFavoritesModal);

  document.getElementById('fav-clear-driver')?.addEventListener('click', () => {
    setFavoriteDriver(null);
    renderFavoritesModalBody();
  });

  document.getElementById('fav-clear-team')?.addEventListener('click', () => {
    setFavoriteTeam(null);
    renderFavoritesModalBody();
  });

  modal.querySelectorAll('[data-fav-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      activeModalTab = tabBtn.dataset.favTab;
      activeModalSearch = '';
      renderFavoritesModalBody();
    });
  });

  const searchInput = document.getElementById('fav-modal-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      activeModalSearch = e.target.value;
      renderFavoritesModalBody();
      const nextInput = document.getElementById('fav-modal-search');
      if (nextInput) {
        nextInput.focus();
        try { nextInput.setSelectionRange(pos, pos); } catch { /* ignore */ }
      }
    });
  }

  modal.querySelectorAll('[data-pick-driver]').forEach(card => {
    card.addEventListener('click', () => {
      toggleFavoriteDriver(card.dataset.pickDriver);
      renderFavoritesModalBody();
    });
  });

  modal.querySelectorAll('[data-pick-team]').forEach(card => {
    card.addEventListener('click', () => {
      toggleFavoriteTeam(card.dataset.pickTeam);
      renderFavoritesModalBody();
    });
  });
}

/**
 * Open the interactive Favorites Cockpit Modal for the active season
 */
export async function openFavoritesModal(year, initialTab = null) {
  const overlay = ensureFavoritesOverlay();
  const modal = document.getElementById('favorites-modal');
  activeModalYear = year;
  if (initialTab === 'drivers' || initialTab === 'teams') {
    activeModalTab = initialTab;
  }
  activeModalSearch = '';

  modal.innerHTML = `
    <button class="driver-modal-close" id="fav-modal-close" aria-label="Close">✕</button>
    <div style="padding: 36px 24px;">
      <div class="skeleton skeleton-row" style="height:28px;width:60%;margin-bottom:16px;"></div>
      <div class="skeleton skeleton-row" style="height:54px;margin-bottom:10px;"></div>
      <div class="skeleton skeleton-row" style="height:54px;margin-bottom:10px;"></div>
      <div class="skeleton skeleton-row" style="height:54px;"></div>
    </div>
  `;
  document.getElementById('fav-modal-close')?.addEventListener('click', closeFavoritesModal);
  document.body.style.overflow = 'hidden';
  overlay.classList.add('open');

  try {
    const seasonData = await getSeasonData(year);
    activeModalStandings = computeStandingsFromSeason(seasonData);
    renderFavoritesModalBody();
  } catch (err) {
    console.error('[Favorites] Failed to load season drivers/teams:', err);
    modal.innerHTML = `
      <button class="driver-modal-close" id="fav-modal-close" aria-label="Close">✕</button>
      <div style="padding:32px 24px;text-align:center;color:var(--text-secondary);">
        Failed to load ${year} grid data. Please try again once season telemetry finishes loading.
      </div>
    `;
    document.getElementById('fav-modal-close')?.addEventListener('click', closeFavoritesModal);
  }
}
