// =============================================
// PITCORNER — Alternate History Sandbox
// Allows users to modify completed race results,
// complete future races, and dynamically re-calculate
// standings, charts, and leader history.
// =============================================

import { dbGet, dbSet, dbDelete } from './db.js';
import { getSeasonData, computeStandingsFromSeason } from './season-data.js';
import { renderDriverStandings, renderConstructorStandings } from './standings.js';
import { drawLineChart } from './charts.js';
import { getTeamColor, getPointsForPosition, isPast, $ } from './utils.js';
import { getMeetings } from './api.js';

// Global Sandbox State
let currentYear = 2026;
let officialSeasonData = null;
let altSeasonData = null;
let altStandings = null;
let userModifications = {}; // session_key -> { results: [], fastest_lap_driver, is_completed }
let activeSelectedSessionKey = '';
let activeEditingSessionType = 'gp'; // 'gp' or 'sprint'

let sandboxSettings = {
  pointsSystem: 'modern',
  customPoints: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  sprintPointsSystem: 'modern',
  fastestLapPoint: 'auto',
  doublePointsFinal: false
};

let chartActiveType = 'drivers'; // 'drivers' or 'constructors'
let chartSelectedDrivers = new Set();
let chartSelectedConstructors = new Set();
let chartLegendExpanded = false;
let chartTogglesInitialized = false;

/**
 * Initialize the Alternate History Sandbox panel
 */
export async function initAltHistory(year) {
  currentYear = year;
  activeSelectedSessionKey = '';
  
  // Setup tabs
  setupAltTabs();
  
  // Setup settings panel listeners
  setupSettingsListeners();
  
  // Setup save, reset, change listeners
  setupActionListeners();

  // Load and render
  await loadAltData();
}

/**
 * Setup Alt History Sandbox panel tab switching
 */
function setupAltTabs() {
  const tabBtns = document.querySelectorAll('.alt-tab-btn');
  tabBtns.forEach(btn => {
    // Clone to strip old listeners
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', () => {
      document.querySelectorAll('.alt-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.alt-tab-content').forEach(c => c.style.display = 'none');

      newBtn.classList.add('active');
      const tabId = newBtn.dataset.tab;
      
      if (tabId === 'alt-standings') {
        $('#alt-tab-content-standings').style.display = 'block';
      } else if (tabId === 'alt-chart') {
        $('#alt-tab-content-chart').style.display = 'block';
        // Redraw chart when visible to ensure canvas boundaries align
        drawAltChampionshipChart();
      } else if (tabId === 'alt-settings') {
        $('#alt-tab-content-settings').style.display = 'block';
        populateSettingsForm();
      }
    });
  });

  // Standings type buttons
  const driversBtn = $('#alt-standings-drivers-btn');
  const constructorsBtn = $('#alt-standings-constructors-btn');

  if (driversBtn && constructorsBtn) {
    const newDriversBtn = driversBtn.cloneNode(true);
    const newConstructorsBtn = constructorsBtn.cloneNode(true);
    
    newDriversBtn.classList.add('active');
    newConstructorsBtn.classList.remove('active');
    
    driversBtn.parentNode.replaceChild(newDriversBtn, driversBtn);
    constructorsBtn.parentNode.replaceChild(newConstructorsBtn, constructorsBtn);

    newDriversBtn.addEventListener('click', () => {
      newDriversBtn.classList.add('active');
      newConstructorsBtn.classList.remove('active');
      renderAltStandingsTable('drivers');
    });

    newConstructorsBtn.addEventListener('click', () => {
      newConstructorsBtn.classList.add('active');
      newDriversBtn.classList.remove('active');
      renderAltStandingsTable('constructors');
    });
  }
}

/**
 * Setup controls listeners (Save, Reset, Dropdowns)
 */
function setupActionListeners() {
  // Reset button
  const resetBtn = $('#althistory-reset-btn');
  if (resetBtn) {
    const newResetBtn = resetBtn.cloneNode(true);
    resetBtn.parentNode.replaceChild(newResetBtn, resetBtn);
    newResetBtn.addEventListener('click', async () => {
      if (confirm('Are you sure you want to discard all alternate history modifications and reset to official results?')) {
        await dbDelete('compiled_races', `althistory_mods_${currentYear}`);
        activeSelectedSessionKey = '';
        await loadAltData();
      }
    });
  }

  // Save button
  const saveBtn = $('#althistory-save-btn');
  if (saveBtn) {
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', async () => {
      await saveCurrentRaceEdit();
    });
  }

  // Selector dropdown
  const selectEl = $('#althistory-race-select');
  if (selectEl) {
    const newSelectEl = selectEl.cloneNode(true);
    selectEl.parentNode.replaceChild(newSelectEl, selectEl);
    newSelectEl.addEventListener('change', (e) => {
      activeSelectedSessionKey = e.target.value;
      activeEditingSessionType = 'gp'; // Default to GP when changing race selection
      
      const toggleGp = $('#alt-session-toggle-gp');
      const toggleSprint = $('#alt-session-toggle-sprint');
      if (toggleGp && toggleSprint) {
        toggleGp.classList.add('active');
        toggleSprint.classList.remove('active');
      }
      
      renderRaceEditor();
    });
  }

  // Session type selectors for Sprint Weekends
  const toggleGp = $('#alt-session-toggle-gp');
  const toggleSprint = $('#alt-session-toggle-sprint');
  if (toggleGp && toggleSprint) {
    const newToggleGp = toggleGp.cloneNode(true);
    const newToggleSprint = toggleSprint.cloneNode(true);
    
    newToggleGp.classList.add('active');
    newToggleSprint.classList.remove('active');
    
    toggleGp.parentNode.replaceChild(newToggleGp, toggleGp);
    toggleSprint.parentNode.replaceChild(newToggleSprint, toggleSprint);

    newToggleGp.addEventListener('click', () => {
      newToggleGp.classList.add('active');
      newToggleSprint.classList.remove('active');
      activeEditingSessionType = 'gp';
      renderRaceEditor();
    });

    newToggleSprint.addEventListener('click', () => {
      newToggleSprint.classList.add('active');
      newToggleGp.classList.remove('active');
      activeEditingSessionType = 'sprint';
      renderRaceEditor();
    });
  }

  // Upcoming Completion toggle
  const completeCheck = $('#althistory-complete-checkbox');
  if (completeCheck) {
    const newCompleteCheck = completeCheck.cloneNode(true);
    completeCheck.parentNode.replaceChild(newCompleteCheck, completeCheck);
    newCompleteCheck.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      handleSimulationToggle(isChecked);
    });
  }
}

/**
 * Helper to retrieve the current active editing session_key (GP key or resolved Sprint key)
 */
function getCurrentEditingSessionKey() {
  if (!activeSelectedSessionKey) return '';
  if (activeEditingSessionType === 'gp') return activeSelectedSessionKey;

  const gpSession = officialSeasonData?.totalRaceSessions.find(s => s.session_key == activeSelectedSessionKey);
  if (!gpSession) return activeSelectedSessionKey;

  const sprintSession = officialSeasonData?.totalRaceSessions.find(s => s.meeting_key == gpSession.meeting_key && s.session_name === 'Sprint');
  return sprintSession ? sprintSession.session_key : activeSelectedSessionKey;
}

/**
 * Load data from IndexedDB and build sandbox state
 */
async function loadAltData() {
  try {
    // 1. Fetch official season details
    officialSeasonData = await getSeasonData(currentYear);
    
    // 2. Fetch customizations and settings for this year
    const savedMods = await dbGet('compiled_races', `althistory_mods_${currentYear}`);
    userModifications = savedMods || {};

    const savedSettings = await dbGet('compiled_races', `althistory_settings_${currentYear}`);
    if (savedSettings) {
      sandboxSettings = savedSettings;
    } else {
      sandboxSettings = {
        pointsSystem: 'modern',
        customPoints: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
        sprintPointsSystem: 'modern',
        fastestLapPoint: 'auto',
        doublePointsFinal: false
      };
    }

    // Update status bar label
    const modCount = Object.keys(userModifications).length;
    const syncStatusEl = $('#althistory-sync-status');
    if (syncStatusEl) {
      if (modCount === 0) {
        syncStatusEl.textContent = 'Status: Cloned from official standings (no modifications)';
      } else {
        syncStatusEl.textContent = `Status: Sandbox active with ${modCount} simulated race${modCount > 1 ? 's' : ''}`;
      }
    }

    // 3. Clone and apply overrides
    buildAltSeasonData();

    // 4. Compute standings
    altStandings = computeStandingsFromSeason(altSeasonData);

    // 5. Populate dropdown selector
    populateRaceSelector();

    // 6. Draw Dashboard / Standings / Charts
    const activeStandingsType = $('.standings-toggle button.active[id^="alt-standings-"]').id.includes('drivers') ? 'drivers' : 'constructors';
    renderAltStandingsTable(activeStandingsType);
    drawAltChampionshipChart();
    renderRaceEditor();

  } catch (err) {
    console.error('[Alt History] Failed to load sandbox data:', err);
  }
}

/**
 * Clone official season data and apply user mods
 */
function buildAltSeasonData() {
  if (!officialSeasonData) return;

  // Deep clone races, qualifying, totalRaceSessions
  const clonedRaces = officialSeasonData.races.map(r => {
    const mod = userModifications[r.session_key];
    if (mod) {
      return {
        ...r,
        results: mod.results.map(res => ({ ...res })),
        fastest_lap_driver: mod.fastest_lap_driver,
        is_simulated: true
      };
    }
    return {
      ...r,
      results: r.results.map(res => ({ ...res })),
      drivers: r.drivers ? r.drivers.map(d => ({ ...d })) : []
    };
  });

  // Rebuild upcoming races list if completed in alt-history
  const allOfficialSessions = officialSeasonData.totalRaceSessions || [];
  const processedRaces = [...clonedRaces];

  allOfficialSessions.forEach(session => {
    // If it's a Race or Sprint session, check if it is completed in alt-history
    const isSprint = session.session_name === 'Sprint';
    const hasOfficial = officialSeasonData.races.some(r => r.session_key == session.session_key);
    
    // If it's upcoming officially, but completed in alt history, we inject it!
    if (!hasOfficial) {
      const mod = userModifications[session.session_key];
      if (mod && mod.is_completed) {
        // Find if meeting metadata is available
        processedRaces.push({
          session_key: session.session_key,
          session_name: session.session_name,
          meeting_key: session.meeting_key,
          circuit_short_name: session.circuit_short_name || 'GP',
          date_end: session.date_end,
          results: mod.results.map(res => ({ ...res })),
          fastest_lap_driver: mod.fastest_lap_driver,
          is_simulated: true,
          drivers: mod.results.map(res => {
            const dInfo = officialSeasonData.drivers.get(res.name_acronym) || {};
            return {
              driver_number: res.driver_number,
              name_acronym: res.name_acronym,
              team_name: dInfo.team_name || 'Unknown',
              team_colour: dInfo.team_colour || '666666'
            };
          })
        });
      }
    }
  });

  // Re-calculate points for all races/sprints under active sandbox rules
  const finalGpKey = getFinalGpSessionKey();
  processedRaces.forEach(race => {
    const isSprint = race.session_name === 'Sprint';
    race.results.forEach(res => {
      res.points = calculateDriverPoints(
        res.position,
        res.status,
        res.driver_number == race.fastest_lap_driver,
        isSprint,
        race.session_key,
        finalGpKey
      );
    });
  });

  altSeasonData = {
    year: officialSeasonData.year,
    compiledAt: Date.now(),
    races: processedRaces,
    qualifying: officialSeasonData.qualifying.map(q => ({
      ...q,
      results: q.results.map(res => ({ ...res })),
      drivers: q.drivers ? q.drivers.map(d => ({ ...d })) : []
    })),
    drivers: new Map(officialSeasonData.drivers),
    totalRaceSessions: allOfficialSessions.map(s => ({ ...s })),
    is_preliminary: false,
    is_fetching_background: false
  };
}

/**
 * Helper to identify the final chronological GP of the season
 */
function getFinalGpSessionKey() {
  if (!officialSeasonData || !officialSeasonData.totalRaceSessions) return '';
  const gpSessions = officialSeasonData.totalRaceSessions
    .filter(s => s.session_name === 'Race')
    .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
  if (gpSessions.length === 0) return '';
  return gpSessions[gpSessions.length - 1].session_key;
}

/**
 * Setup event listeners for the Sandbox Settings panel
 */
function setupSettingsListeners() {
  const pointsSystemSelect = $('#alt-settings-points-system');
  if (pointsSystemSelect) {
    pointsSystemSelect.addEventListener('change', (e) => {
      const isCustom = e.target.value === 'custom';
      $('#alt-settings-custom-points-block').style.display = isCustom ? 'block' : 'none';
    });
  }

  const saveSettingsBtn = $('#alt-settings-save-btn');
  if (saveSettingsBtn) {
    const newSaveBtn = saveSettingsBtn.cloneNode(true);
    saveSettingsBtn.parentNode.replaceChild(newSaveBtn, saveSettingsBtn);
    
    newSaveBtn.addEventListener('click', async () => {
      newSaveBtn.disabled = true;
      newSaveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving Rules...';

      try {
        const pointsSystem = $('#alt-settings-points-system').value;
        const sprintPointsSystem = $('#alt-settings-sprint-system').value;
        const fastestLapPoint = $('#alt-settings-fastest-lap').value;
        const doublePointsFinal = $('#alt-settings-double-points').checked;

        const customPoints = [];
        for (let i = 1; i <= 10; i++) {
          customPoints.push(parseInt($(`#alt-custom-pts-${i}`).value || '0', 10));
        }

        sandboxSettings = {
          pointsSystem,
          customPoints,
          sprintPointsSystem,
          fastestLapPoint,
          doublePointsFinal
        };

        // Write settings to IndexedDB
        await dbSet('compiled_races', `althistory_settings_${currentYear}`, sandboxSettings);

        // Reload data to recalculate all standings/points histories based on new rules
        await loadAltData();

        newSaveBtn.style.background = '#2ecc71';
        newSaveBtn.style.borderColor = '#2ecc71';
        newSaveBtn.style.color = '#111116';
        newSaveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Rules Saved!';

        setTimeout(() => {
          newSaveBtn.disabled = false;
          newSaveBtn.style.background = '';
          newSaveBtn.style.borderColor = '';
          newSaveBtn.style.color = '';
          newSaveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Sandbox Rules';
        }, 1500);

      } catch (err) {
        console.error('[Alt History] Failed to save settings:', err);
        newSaveBtn.disabled = false;
        newSaveBtn.style.background = '';
        newSaveBtn.style.borderColor = '';
        newSaveBtn.style.color = '';
        newSaveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Sandbox Rules';
      }
    });
  }
}

/**
 * Populate the Settings Form inputs based on current sandboxSettings values
 */
function populateSettingsForm() {
  const pointsSystemSelect = $('#alt-settings-points-system');
  if (pointsSystemSelect) pointsSystemSelect.value = sandboxSettings.pointsSystem;

  const isCustom = sandboxSettings.pointsSystem === 'custom';
  $('#alt-settings-custom-points-block').style.display = isCustom ? 'block' : 'none';

  for (let i = 1; i <= 10; i++) {
    const val = sandboxSettings.customPoints[i - 1] !== undefined ? sandboxSettings.customPoints[i - 1] : 0;
    const input = $(`#alt-custom-pts-${i}`);
    if (input) input.value = val;
  }

  const sprintSelect = $('#alt-settings-sprint-system');
  if (sprintSelect) sprintSelect.value = sandboxSettings.sprintPointsSystem;

  const fastestSelect = $('#alt-settings-fastest-lap');
  if (fastestSelect) fastestSelect.value = sandboxSettings.fastestLapPoint;

  const doubleCheck = $('#alt-settings-double-points');
  if (doubleCheck) doubleCheck.checked = sandboxSettings.doublePointsFinal;
}

/**
 * Populate race selector dropdown
 */
function populateRaceSelector() {
  const selectEl = $('#althistory-race-select');
  if (!selectEl) return;

  const prevValue = selectEl.value || activeSelectedSessionKey;
  selectEl.innerHTML = '<option value="">Choose a race to edit...</option>';

  const allSessions = officialSeasonData.totalRaceSessions || [];
  const gpSessions = allSessions.filter(s => s.session_name === 'Race');
  
  gpSessions.forEach((gp, idx) => {
    const round = idx + 1;
    const meetingKey = gp.meeting_key;
    
    const officiallyCompleted = officialSeasonData.races.some(r => r.session_key == gp.session_key);
    const simulated = userModifications[gp.session_key]?.is_completed;
    
    let badgeText = '';
    if (officiallyCompleted) {
      const sprintSession = allSessions.find(s => s.meeting_key == meetingKey && s.session_name === 'Sprint');
      const isGpModified = userModifications[gp.session_key] !== undefined;
      const isSprintModified = sprintSession && userModifications[sprintSession.session_key] !== undefined;
      badgeText = (isGpModified || isSprintModified) ? ' [Simulated]' : ' [Official]';
    } else if (simulated) {
      badgeText = ' [Simulated GP]';
    } else {
      badgeText = ' [Upcoming]';
    }

    const opt = document.createElement('option');
    opt.value = gp.session_key;
    opt.textContent = `Round ${round}: ${gp.circuit_short_name} GP${badgeText}`;
    selectEl.appendChild(opt);
  });

  if (prevValue && selectEl.querySelector(`option[value="${prevValue}"]`)) {
    selectEl.value = prevValue;
    activeSelectedSessionKey = prevValue;
  } else {
    selectEl.value = '';
    activeSelectedSessionKey = '';
  }
}

/**
 * Render standings table on the Sandbox Analytics panel
 */
function renderAltStandingsTable(type) {
  const container = $('#althistory-standings-container');
  if (!container || !altStandings) return;

  if (type === 'drivers') {
    renderDriverStandings(altStandings, container);
  } else {
    renderConstructorStandings(altStandings, container);
  }
}

/**
 * Toggle simulated completion status for future sessions
 */
function handleSimulationToggle(completed) {
  const currentSessionKey = getCurrentEditingSessionKey();
  if (!currentSessionKey) return;
  
  const resultsList = $('#althistory-results-list');
  const footer = $('#althistory-editor-footer');
  
  if (completed) {
    // Enable simulated results - initialize with driver list from previous races/drivers registry
    resultsList.style.display = 'flex';
    footer.style.display = 'flex';
    $('#althistory-editor-placeholder').style.display = 'none';

    // Check if we already have modifications
    if (!userModifications[currentSessionKey]) {
      // Create fresh default results using existing grid drivers
      const activeDrivers = Array.from(officialSeasonData.drivers.values());
      const mockResults = activeDrivers.map((d, i) => {
        const pos = i + 1;
        const status = 'FINISHED';
        const isSprint = activeEditingSessionType === 'sprint';
        const isFastest = (i === 0);
        return {
          driver_number: d.driver_number,
          name_acronym: d.name_acronym,
          position: pos,
          status: status,
          points: calculateDriverPoints(pos, status, isFastest, isSprint, currentSessionKey)
        };
      });

      userModifications[currentSessionKey] = {
        results: mockResults,
        fastest_lap_driver: mockResults[0]?.driver_number || null,
        is_completed: true
      };
    } else {
      userModifications[currentSessionKey].is_completed = true;
    }
    
    renderResultsEditorList();
  } else {
    // Disable simulation - delete modifications
    resultsList.style.display = 'none';
    footer.style.display = 'none';
    $('#althistory-editor-placeholder').style.display = 'flex';
    
    if (userModifications[currentSessionKey]) {
      delete userModifications[currentSessionKey];
    }
  }
}
/**
 * Load qualifying finishing order as simulated race results for an upcoming session.
 * Maps qualifying positions directly to race finishing positions and populates the editor.
 */
function loadQualiOrderAsResults(qualiData, sessionKey) {
  if (!qualiData || !qualiData.results || qualiData.results.length === 0) return;

  const isSprint = activeEditingSessionType === 'sprint';
  const results = qualiData.results
    .filter(r => r.status !== 'DNS')
    .sort((a, b) => a.position - b.position)
    .map((res, i) => {
      const pos = i + 1;
      // Resolve driver acronym from qualifying drivers list or global registry
      let acronym = null;
      if (qualiData.drivers) {
        const dSrc = qualiData.drivers.find(d => d.driver_number === res.driver_number);
        if (dSrc) acronym = dSrc.name_acronym;
      }
      if (!acronym && officialSeasonData.drivers) {
        for (const [acr, dInfo] of officialSeasonData.drivers) {
          if (dInfo.driver_number === res.driver_number) { acronym = acr; break; }
        }
      }
      if (!acronym) acronym = `DRV_${res.driver_number}`;

      return {
        driver_number: res.driver_number,
        name_acronym: acronym,
        position: pos,
        status: 'FINISHED',
        points: calculateDriverPoints(pos, 'FINISHED', i === 0, isSprint, sessionKey)
      };
    });

  userModifications[sessionKey] = {
    results: results,
    fastest_lap_driver: results[0]?.driver_number || null,
    is_completed: true
  };

  // Toggle UI state to show the editor
  const checkbox = $('#althistory-complete-checkbox');
  if (checkbox) { checkbox.checked = true; checkbox.disabled = false; }
  const resultsList = $('#althistory-results-list');
  const footer = $('#althistory-editor-footer');
  const placeholder = $('#althistory-editor-placeholder');
  if (resultsList) resultsList.style.display = 'flex';
  if (footer) footer.style.display = 'flex';
  if (placeholder) placeholder.style.display = 'none';

  renderResultsEditorList();
}

/**
 * Render race results editor based on the selected session key
 */
function renderRaceEditor() {
  const infoBlock = $('#althistory-race-info-block');
  const sessionTypeBlock = $('#althistory-session-type-block');
  const resultsList = $('#althistory-results-list');
  const footer = $('#althistory-editor-footer');
  const placeholder = $('#althistory-editor-placeholder');
  
  if (!activeSelectedSessionKey) {
    infoBlock.style.display = 'none';
    sessionTypeBlock.style.display = 'none';
    resultsList.style.display = 'none';
    footer.style.display = 'none';
    placeholder.style.display = 'flex';
    const flWrap = $('#alt-fastest-lap-wrap');
    if (flWrap) flWrap.style.display = 'none';
    return;
  }

  // Get GP details
  const gpSession = officialSeasonData.totalRaceSessions.find(s => s.session_key == activeSelectedSessionKey);
  if (!gpSession) {
    infoBlock.style.display = 'none';
    sessionTypeBlock.style.display = 'none';
    resultsList.style.display = 'none';
    footer.style.display = 'none';
    placeholder.style.display = 'flex';
    const flWrap = $('#alt-fastest-lap-wrap');
    if (flWrap) flWrap.style.display = 'none';
    return;
  }

  // Check if Sprint exists for this weekend
  const sprintSession = officialSeasonData.totalRaceSessions.find(s => s.meeting_key == gpSession.meeting_key && s.session_name === 'Sprint');
  if (sprintSession) {
    sessionTypeBlock.style.display = 'block';
  } else {
    sessionTypeBlock.style.display = 'none';
    activeEditingSessionType = 'gp'; // Reset to GP if no sprint weekend
  }

  const currentSessionKey = getCurrentEditingSessionKey();
  const currentSession = activeEditingSessionType === 'gp' ? gpSession : sprintSession;
  
  const gpSessions = officialSeasonData.totalRaceSessions.filter(s => s.session_name === 'Race');
  const roundIdx = gpSessions.findIndex(s => s.meeting_key === gpSession.meeting_key) + 1;
  
  // Update GP name & round label
  $('#althistory-editor-round-label').textContent = `Round ${roundIdx}`;
  $('#althistory-editor-gp-name').textContent = `${gpSession.circuit_short_name} ${activeEditingSessionType === 'gp' ? 'GP' : 'Sprint'}`;
  infoBlock.style.display = 'flex';

  const officiallyCompleted = officialSeasonData.races.some(r => r.session_key == currentSessionKey);
  const simulated = userModifications[currentSessionKey]?.is_completed;
  
  const checkbox = $('#althistory-complete-checkbox');
  
  if (officiallyCompleted) {
    // If completed officially, simulation is locked on, but results are editable
    checkbox.checked = true;
    checkbox.disabled = true;
    
    // Load official results into modifications if not already modified
    if (!userModifications[currentSessionKey]) {
      const officialRace = officialSeasonData.races.find(r => r.session_key == currentSessionKey);
      
      let results = [];
      if (officialRace) {
        results = officialRace.results.map(res => {
          const dSrc = officialRace.drivers ? officialRace.drivers.find(d => d.driver_number === res.driver_number) : null;
          const acronym = dSrc ? dSrc.name_acronym : `DRV_${res.driver_number}`;
          return {
            driver_number: res.driver_number,
            name_acronym: acronym,
            position: res.position,
            status: res.status,
            points: res.points
          };
        });
      }

      userModifications[currentSessionKey] = {
        results: results,
        fastest_lap_driver: officialRace ? (officialRace.fastest_lap_driver || null) : null,
        is_completed: true
      };
    }
    
    placeholder.style.display = 'none';
    resultsList.style.display = 'flex';
    footer.style.display = 'flex';
    renderResultsEditorList();
    
  } else {
    // If future race, it is togglable
    checkbox.disabled = false;
    if (simulated) {
      checkbox.checked = true;
      placeholder.style.display = 'none';
      resultsList.style.display = 'flex';
      footer.style.display = 'flex';
      renderResultsEditorList();
    } else {
      checkbox.checked = false;
      resultsList.style.display = 'none';
      footer.style.display = 'none';
      placeholder.style.display = 'flex';
      const flWrap = $('#alt-fastest-lap-wrap');
      if (flWrap) flWrap.style.display = 'none';

      // Check if qualifying data exists for this meeting
      // For GP editing: find 'Qualifying'. For Sprint editing: find 'Sprint Qualifying'/'Sprint Shootout'
      console.log('[AltHistory] gpSession.meeting_key:', gpSession.meeting_key, typeof gpSession.meeting_key);
      console.log('[AltHistory] Available qualifying sessions:', officialSeasonData.qualifying?.map(q => ({ name: q.session_name, key: q.meeting_key, type: typeof q.meeting_key, resultsCount: q.results?.length })));
      const qualiForMeeting = officialSeasonData.qualifying
        ? officialSeasonData.qualifying.find(q => {
            const match = String(q.meeting_key) === String(gpSession.meeting_key);
            if (!match) return false;
            const name = (q.session_name || '').toLowerCase();
            if (activeEditingSessionType === 'sprint') {
              return name.includes('sprint') || name.includes('shootout');
            }
            return name === 'qualifying';
          })
        : null;
      console.log('[AltHistory] Resolved qualiForMeeting:', qualiForMeeting);
      const hasQuali = qualiForMeeting && qualiForMeeting.results && qualiForMeeting.results.length > 0;

      placeholder.innerHTML = `
        <i class="fa-solid fa-hourglass-start fa-2x" style="color:var(--text-muted);margin-bottom:var(--space-xs);"></i>
        <p style="font-weight:600;color:var(--text-secondary);">This session is in the future.</p>
        <p style="font-size:0.8rem;max-width:300px;margin-top:4px;">Toggle the "Completed" switch above to simulate this ${activeEditingSessionType === 'gp' ? 'race' : 'sprint'} and edit results.</p>
        ${hasQuali 
          ? `<button id="alt-load-quali-btn" class="alt-btn-success" style="margin-top:12px;"><i class="fa-solid fa-flag-checkered"></i> Load Quali Grid Order</button>` 
          : `<p style="font-size:0.75rem;color:var(--text-muted);margin-top:10px;"><i class="fa-solid fa-triangle-exclamation"></i> Qualifying results not loaded or not yet available for this weekend.</p>`}
      `;

      // Wire up the Load Quali button
      if (hasQuali) {
        const loadQualiBtn = document.getElementById('alt-load-quali-btn');
        if (loadQualiBtn) {
          loadQualiBtn.addEventListener('click', () => {
            loadQualiOrderAsResults(qualiForMeeting, currentSessionKey);
          });
        }
      }
    }
  }
}

/**
 * Render reorderable list of drivers inside results editor
 */
function renderResultsEditorList() {
  const container = $('#althistory-results-list');
  const currentSessionKey = getCurrentEditingSessionKey();
  if (!container || !currentSessionKey) return;

  const data = userModifications[currentSessionKey];
  if (!data || !data.results) return;

  container.innerHTML = '';
  const isSprint = activeEditingSessionType === 'sprint';

  // ── Populate Fastest Lap dropdown ──
  const flWrap = $('#alt-fastest-lap-wrap');
  const flSelect = $('#alt-fastest-lap-select');
  if (flWrap && flSelect) {
    if (isSprint) {
      flWrap.style.display = 'none';
    } else {
      flWrap.style.display = 'flex';
      
      const flOptions = ['<option value="">No Fastest Lap</option>'];
      data.results.forEach(res => {
        const dInfo = officialSeasonData.drivers.get(res.name_acronym) || { full_name: res.name_acronym };
        if (res.status === 'FINISHED' || res.status === 'DNF') {
          flOptions.push(`<option value="${res.driver_number}" ${data.fastest_lap_driver == res.driver_number ? 'selected' : ''}>${res.name_acronym} (${dInfo.full_name})</option>`);
        }
      });
      flSelect.innerHTML = flOptions.join('');
      
      const newFlSelect = flSelect.cloneNode(true);
      flSelect.parentNode.replaceChild(newFlSelect, flSelect);
      newFlSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        data.fastest_lap_driver = val ? parseInt(val, 10) : null;
        recalculatePointsInEditor();
        renderResultsEditorList();
      });
    }
  }

  data.results.forEach((res, index) => {
    const dInfo = officialSeasonData.drivers.get(res.name_acronym) || {
      full_name: `Driver ${res.name_acronym}`,
      team_name: 'Unknown',
      team_colour: '666666'
    };

    const row = document.createElement('div');
    row.className = 'althistory-row';
    row.draggable = true;
    row.dataset.index = index;
    row.dataset.acronym = res.name_acronym;

    const teamColor = getTeamColor(dInfo.team_colour);
    const calculatedPts = calculateDriverPoints(res.position, res.status, res.driver_number == data.fastest_lap_driver, isSprint, currentSessionKey);

    // Build option selectors for finishing status
    const statusOptions = ['FINISHED', 'DNF', 'DNS', 'DSQ'].map(s => {
      return `<option value="${s}" ${res.status === s ? 'selected' : ''}>${s}</option>`;
    }).join('');

    const fastestChecked = data.fastest_lap_driver == res.driver_number ? 'checked' : '';
    const isFastestLapAbolished = currentYear >= 2025;
    const fastestStyle = (isSprint || isFastestLapAbolished || res.status !== 'FINISHED' || res.position > 10) ? 'display:none;' : '';

    // Build option selectors for position
    const totalPos = data.results.length;
    const posOptions = Array.from({ length: totalPos }, (_, i) => {
      const p = i + 1;
      return `<option value="${p}" ${res.position === p ? 'selected' : ''}>${p}</option>`;
    }).join('');

    row.innerHTML = `
      <div class="althistory-row-left">
        <div class="althistory-grab-handle">
          <i class="fa-solid fa-grip-vertical"></i>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <button class="althistory-reorder-btn alt-up" title="Move Up" ${index === 0 ? 'disabled' : ''}>
            <i class="fa-solid fa-chevron-up"></i>
          </button>
          <button class="althistory-reorder-btn alt-down" title="Move Down" ${index === data.results.length - 1 ? 'disabled' : ''}>
            <i class="fa-solid fa-chevron-down"></i>
          </button>
        </div>
        <div class="althistory-pos-badge-wrap">
          <select class="althistory-pos-select althistory-pos-badge">
            ${posOptions}
          </select>
        </div>
        <div class="althistory-driver-meta">
          <div class="althistory-color-bar" style="background:${teamColor}"></div>
          <div class="althistory-driver-names">
            <span class="althistory-driver-acronym">${res.name_acronym}</span>
            <span class="althistory-driver-fullname">${dInfo.full_name}</span>
          </div>
        </div>
      </div>
      <div class="althistory-row-right">
        <select class="althistory-status-select">
          ${statusOptions}
        </select>
        <label class="althistory-fastest-label" style="${fastestStyle}" title="Fastest Lap Point">
          <input type="checkbox" name="fastest" class="althistory-fastest-input" ${fastestChecked}>
          <i class="fa-solid fa-stopwatch"></i>
        </label>
        <div class="althistory-pts-pill">${calculatedPts} pts</div>
      </div>
    `;

    // ── Position Dropdown Selection Handler ──
    row.querySelector('.althistory-pos-select').addEventListener('change', (e) => {
      const newPos = parseInt(e.target.value, 10);
      reorderEditorResults(index, newPos - 1);
    });

    // ── Button Swapping Handlers (Mobile & Standard UI) ──
    row.querySelector('.alt-up')?.addEventListener('click', (e) => {
      e.stopPropagation();
      swapEditorResults(index, index - 1);
    });

    row.querySelector('.alt-down')?.addEventListener('click', (e) => {
      e.stopPropagation();
      swapEditorResults(index, index + 1);
    });

    // ── Dropdown Status Handler ──
    row.querySelector('.althistory-status-select').addEventListener('change', (e) => {
      res.status = e.target.value;
      
      // If driver drops out of finishing status or top 10, remove fastest lap if they held it
      if (res.status !== 'FINISHED' || res.position > 10) {
        if (data.fastest_lap_driver == res.driver_number) {
          data.fastest_lap_driver = null;
        }
      }
      recalculatePointsInEditor();
      renderResultsEditorList();
    });

    // ── Fastest Lap Checkbox Handler ──
    const flInput = row.querySelector('.althistory-fastest-input');
    flInput?.addEventListener('change', (e) => {
      if (e.target.checked) {
        data.fastest_lap_driver = res.driver_number;
      } else {
        if (data.fastest_lap_driver == res.driver_number) {
          data.fastest_lap_driver = null;
        }
      }
      recalculatePointsInEditor();
      renderResultsEditorList();
    });

    // ── Drag & Drop Event Listeners ──
    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index);
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('.althistory-row').forEach(r => r.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('drag-over');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = index;
      if (fromIdx !== toIdx) {
        reorderEditorResults(fromIdx, toIdx);
      }
    });

    container.appendChild(row);
  });
}

/**
 * Swaps two driver entries inside results editor array
 */
function swapEditorResults(i, j) {
  const currentSessionKey = getCurrentEditingSessionKey();
  const data = userModifications[currentSessionKey];
  if (!data || !data.results) return;

  const temp = data.results[i];
  data.results[i] = data.results[j];
  data.results[j] = temp;

  // Re-align position numbers
  data.results.forEach((r, idx) => r.position = idx + 1);

  recalculatePointsInEditor();
  renderResultsEditorList();
}

/**
 * Re-orders editor results from dragging source index to target index
 */
function reorderEditorResults(fromIdx, toIdx) {
  const currentSessionKey = getCurrentEditingSessionKey();
  const data = userModifications[currentSessionKey];
  if (!data || !data.results) return;

  const item = data.results.splice(fromIdx, 1)[0];
  data.results.splice(toIdx, 0, item);

  // Re-align position numbers
  data.results.forEach((r, idx) => r.position = idx + 1);

  recalculatePointsInEditor();
  renderResultsEditorList();
}

/**
 * Recalculates points properties in modifications registry array
 */
function recalculatePointsInEditor() {
  const currentSessionKey = getCurrentEditingSessionKey();
  const data = userModifications[currentSessionKey];
  if (!data || !data.results) return;

  const isSprint = activeEditingSessionType === 'sprint';
  
  data.results.forEach(res => {
    res.points = calculateDriverPoints(
      res.position,
      res.status,
      res.driver_number == data.fastest_lap_driver,
      isSprint,
      currentSessionKey
    );
  });
}

/**
 * Calculate dynamic driver points tallies
 */
function calculateDriverPoints(position, status, isFastest, isSprint, sessionKey, finalGpKeyOverride) {
  if (status === 'DSQ' || status === 'DNS' || status === 'ABSENT' || status === 'DNF') {
    return 0;
  }

  let pts = 0;
  if (isSprint) {
    const sprintSys = sandboxSettings.sprintPointsSystem || 'modern';
    if (sprintSys === 'modern') {
      const sprintPts = [8, 7, 6, 5, 4, 3, 2, 1];
      pts = sprintPts[position - 1] || 0;
    } else if (sprintSys === 'original') {
      const sprintPts = [3, 2, 1];
      pts = sprintPts[position - 1] || 0;
    } else {
      pts = 0;
    }
  } else {
    const sys = sandboxSettings.pointsSystem || 'modern';
    if (sys === 'modern') {
      const gpPts = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      pts = gpPts[position - 1] || 0;
    } else if (sys === 'classic') {
      const gpPts = [10, 8, 6, 5, 4, 3, 2, 1];
      pts = gpPts[position - 1] || 0;
    } else if (sys === 'retro') {
      const gpPts = [10, 6, 4, 3, 2, 1];
      pts = gpPts[position - 1] || 0;
    } else if (sys === 'custom') {
      const gpPts = sandboxSettings.customPoints || [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
      pts = gpPts[position - 1] || 0;
    }
  }

  // Fastest lap point rules
  if (!isSprint) {
    const flRule = sandboxSettings.fastestLapPoint || 'auto';
    let awardFl = false;
    if (flRule === 'on') {
      awardFl = true;
    } else if (flRule === 'off') {
      awardFl = false;
    } else {
      awardFl = (currentYear < 2025);
    }

    if (awardFl && isFastest && position <= 10) {
      pts += 1;
    }
  }

  // Double points final round
  if (sandboxSettings.doublePointsFinal && sessionKey) {
    const finalGpKey = finalGpKeyOverride || getFinalGpSessionKey();
    if (sessionKey == finalGpKey) {
      pts *= 2;
    }
  }

  return pts;
}

/**
 * Save user edits for the active session to IndexedDB
 */
async function saveCurrentRaceEdit() {
  const currentSessionKey = getCurrentEditingSessionKey();
  if (!currentSessionKey) return;
  
  const saveBtn = $('#althistory-save-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
  }

  try {
    // Make sure points properties are updated
    recalculatePointsInEditor();

    // Write modifications map back to IndexedDB
    await dbSet('compiled_races', `althistory_mods_${currentYear}`, userModifications);
    
    // Reload state completely
    await loadAltData();

    // Success animation on button
    if (saveBtn) {
      saveBtn.style.background = '#2ecc71';
      saveBtn.style.borderColor = '#2ecc71';
      saveBtn.style.color = '#111116';
      saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Applied successfully!';
      
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.style.background = '';
        saveBtn.style.borderColor = '';
        saveBtn.style.color = '';
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Apply & Save results';
      }, 1500);
    }

  } catch (err) {
    console.error('[Alt History] Save failed:', err);
    alert('Failed to save alt history edits. See console for details.');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Apply & Save results';
    }
  }
}

/**
 * Re-calculate line datasets and draw the Points Tracker chart on canvas
 */
function drawAltChampionshipChart(forceReset = false) {
  if (!altSeasonData || !altStandings) return;

  const chartCanvas = document.getElementById('althistory-championship-chart');
  const legendEl = document.getElementById('althistory-chart-legend');
  if (!chartCanvas || !legendEl) return;

  const presetCount = parseInt($('#alt-chart-drivers-count')?.value || '5', 10);
  const standings = altStandings;

  // Initialize selected elements if empty
  const needsReset = forceReset || chartSelectedDrivers.size === 0 || chartSelectedConstructors.size === 0;
  if (needsReset) {
    chartSelectedDrivers.clear();
    chartSelectedConstructors.clear();
    
    standings.drivers.slice(0, presetCount).forEach(d => chartSelectedDrivers.add(d.name_acronym));
    standings.constructors.slice(0, presetCount).forEach(c => chartSelectedConstructors.add(c.team_name));
  }

  const allItems = chartActiveType === 'drivers' ? standings.drivers : standings.constructors;
  const selectedSet = chartActiveType === 'drivers' ? chartSelectedDrivers : chartSelectedConstructors;

  if (allItems.length === 0) {
    chartCanvas.style.display = 'none';
    legendEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No sandbox points data computed</div>';
    return;
  }

  chartCanvas.style.display = 'block';

  // Gather completed meetings in chronological order
  const meetingsMap = new Map();
  for (const r of altSeasonData.races) {
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

  // Filter to active items
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

  chartCanvas._chartData = { datasets, sortedMeetings, activeItems };

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
        xLabel: 'Simulated Races Completed',
        yLabel: 'Points',
        lineWidth: 2.5,
        showDots: true,
        yMin: 0,
        hoveredIndex: hoverIndex,
      });
    });
  }

  drawChartWithHover(undefined);

  // Attach hover listeners (once per canvas life)
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

      const padLeft = 60;
      const padRight = 20;
      const plotW = rect.width - padLeft - padRight;
      
      if (mouseX >= padLeft && mouseX <= rect.width - padRight) {
        const maxLen = data.sortedMeetings.length;
        if (maxLen === 0) return;
        const ratio = (mouseX - padLeft) / plotW;
        let idx = Math.round(ratio * (maxLen - 1));
        idx = Math.max(0, Math.min(maxLen - 1, idx));

        drawChartWithHover(idx);

        const meeting = data.sortedMeetings[idx];
        const roundNumber = idx + 1;

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
        }).sort((a, b) => b.points - a.points);

        let html = `<div class="chart-tooltip-header">Round ${roundNumber}: ${meeting.circuit_short_name} GP</div>`;
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

  // Drivers/Constructors chart type selector
  const driversToggle = document.getElementById('alt-chart-toggle-drivers');
  const constructorsToggle = document.getElementById('alt-chart-toggle-constructors');

  if (driversToggle && constructorsToggle && !chartTogglesInitialized) {
    chartTogglesInitialized = true;

    driversToggle.addEventListener('click', () => {
      if (chartActiveType === 'drivers') return;
      chartActiveType = 'drivers';
      driversToggle.classList.add('active');
      constructorsToggle.classList.remove('active');
      drawAltChampionshipChart(true);
    });

    constructorsToggle.addEventListener('click', () => {
      if (chartActiveType === 'constructors') return;
      chartActiveType = 'constructors';
      constructorsToggle.classList.add('active');
      driversToggle.classList.remove('active');
      drawAltChampionshipChart(true);
    });
  }

  // Display active class on chart toggles
  if (driversToggle && constructorsToggle) {
    if (chartActiveType === 'drivers') {
      driversToggle.classList.add('active');
      constructorsToggle.classList.remove('active');
    } else {
      constructorsToggle.classList.add('active');
      driversToggle.classList.remove('active');
    }
  }

  // Render legend selector chips
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

  legendEl.querySelectorAll('.chart-legend-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.id;
      if (selectedSet.has(id)) {
        if (selectedSet.size > 1) {
          selectedSet.delete(id);
        } else {
          return;
        }
      } else {
        selectedSet.add(id);
      }
      drawAltChampionshipChart(false);
    });
  });

  // Count dropdown listener
  const countSelect = $('#alt-chart-drivers-count');
  if (countSelect && !countSelect._listenerAdded) {
    countSelect._listenerAdded = true;
    countSelect.addEventListener('change', () => {
      drawAltChampionshipChart(true);
    });
  }
}
