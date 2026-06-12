// =============================================
// PITCORNER — API Abstraction Layer
// Handles all OpenF1 API requests with:
//  - localStorage persistence (survives page reloads)
//  - Smart TTLs (past data cached forever, current data refreshes)
//  - Rate limiting (3 req/s, 30 req/min)
//  - Retry with exponential backoff on 429
//  - In-flight request deduplication
// =============================================

import { getDriverHeadshot, DRIVER_NATIONALITY } from './utils.js';
import { dbGet, dbSet, dbClear, dbGetAllKeys, dbGetAllEntries, dbDelete, dbGetCount } from './db.js';

const NATIONALITY_TO_COUNTRY = {
  'british': { country: 'United Kingdom', code: 'gb' },
  'german': { country: 'Germany', code: 'de' },
  'french': { country: 'France', code: 'fr' },
  'italian': { country: 'Italy', code: 'it' },
  'brazilian': { country: 'Brazil', code: 'br' },
  'american': { country: 'United States', code: 'us' },
  'finnish': { country: 'Finland', code: 'fi' },
  'australian': { country: 'Australia', code: 'au' },
  'spanish': { country: 'Spain', code: 'es' },
  'japanese': { country: 'Japan', code: 'jp' },
  'austrian': { country: 'Austria', code: 'at' },
  'canadian': { country: 'Canada', code: 'ca' },
  'new zealander': { country: 'New Zealand', code: 'nz' },
  'kiwi': { country: 'New Zealand', code: 'nz' },
  'swedish': { country: 'Sweden', code: 'se' },
  'belgian': { country: 'Belgium', code: 'be' },
  'swiss': { country: 'Switzerland', code: 'ch' },
  'argentine': { country: 'Argentina', code: 'ar' },
  'dutch': { country: 'Netherlands', code: 'nl' },
  'south african': { country: 'South Africa', code: 'za' },
  'colombian': { country: 'Colombia', code: 'co' },
  'mexican': { country: 'Mexico', code: 'mx' },
  'russian': { country: 'Russia', code: 'ru' },
  'danish': { country: 'Denmark', code: 'dk' },
  'polish': { country: 'Poland', code: 'pl' },
  'monegasque': { country: 'Monaco', code: 'mc' },
  'venezuelan': { country: 'Venezuela', code: 've' },
  'indian': { country: 'India', code: 'in' },
  'thai': { country: 'Thailand', code: 'th' },
  'chinese': { country: 'China', code: 'cn' },
  'irish': { country: 'Ireland', code: 'ie' },
  'portuguese': { country: 'Portugal', code: 'pt' },
  'hungarian': { country: 'Hungary', code: 'hu' },
  'chilean': { country: 'Chile', code: 'cl' },
  'uruguayan': { country: 'Uruguay', code: 'uy' },
  'rhodesian': { country: 'Zimbabwe', code: 'zw' },
  'east german': { country: 'Germany', code: 'de' },
  'czechoslovakian': { country: 'Czechia', code: 'cz' },
  'liechtenstein': { country: 'Liechtenstein', code: 'li' },
  'indonesian': { country: 'Indonesia', code: 'id' },
  'malaysian': { country: 'Malaysia', code: 'my' },
  'moroccan': { country: 'Morocco', code: 'ma' }
};

function translateNationalityToCountry(nationality) {
  if (!nationality) return null;
  const clean = nationality.trim().toLowerCase();
  return NATIONALITY_TO_COUNTRY[clean] || null;
}

export const ISO3_TO_COUNTRY = {
  ARG: { country: 'Argentina', code: 'ar' },
  AUS: { country: 'Australia', code: 'au' },
  AUT: { country: 'Austria', code: 'at' },
  AZE: { country: 'Azerbaijan', code: 'az' },
  BEL: { country: 'Belgium', code: 'be' },
  BRA: { country: 'Brazil', code: 'br' },
  CAN: { country: 'Canada', code: 'ca' },
  CHN: { country: 'China', code: 'cn' },
  DEN: { country: 'Denmark', code: 'dk' },
  ESP: { country: 'Spain', code: 'es' },
  FIN: { country: 'Finland', code: 'fi' },
  FRA: { country: 'France', code: 'fr' },
  GBR: { country: 'United Kingdom', code: 'gb' },
  GER: { country: 'Germany', code: 'de' },
  IND: { country: 'India', code: 'in' },
  ITA: { country: 'Italy', code: 'it' },
  JPN: { country: 'Japan', code: 'jp' },
  MEX: { country: 'Mexico', code: 'mx' },
  MON: { country: 'Monaco', code: 'mc' },
  NED: { country: 'Netherlands', code: 'nl' },
  NZL: { country: 'New Zealand', code: 'nz' },
  POL: { country: 'Poland', code: 'pl' },
  RUS: { country: 'Russia', code: 'ru' },
  SGP: { country: 'Singapore', code: 'sg' },
  SUI: { country: 'Switzerland', code: 'ch' },
  THA: { country: 'Thailand', code: 'th' },
  USA: { country: 'United States', code: 'us' },
  ISR: { country: 'Israel', code: 'il' },
  EST: { country: 'Estonia', code: 'ee' },
  SWE: { country: 'Sweden', code: 'se' },
  BAR: { country: 'Barbados', code: 'bb' },
  IRL: { country: 'Ireland', code: 'ie' },
  NOR: { country: 'Norway', code: 'no' }
};

const API_BASE = 'https://api.openf1.org/v1';

// ── Jolpi Ergast Historical mirror Integration ──
const historicalSeasons = new Map();

const HISTORICAL_COUNTRY_CODES = {
  'australia': 'au',
  'austria': 'at',
  'bahrain': 'bh',
  'belgium': 'be',
  'brazil': 'br',
  'canada': 'ca',
  'china': 'cn',
  'france': 'fr',
  'germany': 'de',
  'great britain': 'gb',
  'uk': 'gb',
  'united kingdom': 'gb',
  'hungary': 'hu',
  'italy': 'it',
  'japan': 'jp',
  'malaysia': 'my',
  'mexico': 'mx',
  'monaco': 'mc',
  'morocco': 'ma',
  'netherlands': 'nl',
  'portugal': 'pt',
  'russia': 'ru',
  'singapore': 'sg',
  'south africa': 'za',
  'spain': 'es',
  'sweden': 'se',
  'switzerland': 'ch',
  'turkey': 'tr',
  'uae': 'ae',
  'united arab emirates': 'ae',
  'usa': 'us',
  'united states': 'us',
  'azerbaijan': 'az',
  'qatar': 'qa',
  'saudi arabia': 'sa',
  'india': 'in',
  'korea': 'kr',
  'argentina': 'ar',
  'imola': 'it',
  'san marino': 'sm'
};

const CONSTRUCTOR_COLORS = {
  'ferrari': 'EF1A2D',
  'mclaren': 'FF8000',
  'red_bull': '3671C6',
  'mercedes': '27F4D2',
  'alpine': '2293D1',
  'aston_martin': '229971',
  'williams': '37BEDD',
  'haas': 'B6BABD',
  'sauber': '52E252',
  'rb': '6692FF',
  'alpha_tauri': '5E8FAA',
  'toro_rosso': '469BFF',
  'renault': 'FFF500',
  'force_india': 'FF8700',
  'racing_point': 'F596C8',
  'alfa_romeo': 'C00000',
  'lotus': 'FFB300',
  'lotus_f1': 'FFB300',
  'benetton': '00A650',
  'tyrrell': '002FA7',
  'brabham': '003366',
  'jordan': 'FFF200',
  'bar': 'E60000',
  'honda': 'E60000',
  'toyota': 'E60000',
  'jaguar': '006644',
  'minardi': 'FFF200',
  'ligier': '2643B9',
  'arrows': 'FF6600',
  'bmw_sauber': '0000FF',
  'brawn': 'E2FF00',
  'stewart': '005A36',
  'prost': '0000FF',
  'march': '30C8D6',
  'cooper': '004225',
  'brm': '004225',
  'matra': '0055A5'
};

function getConstructorColor(constructorId, name) {
  const cleanId = (constructorId || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (CONSTRUCTOR_COLORS[cleanId]) return CONSTRUCTOR_COLORS[cleanId];
  
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  const h = Math.abs(hash % 360);
  const s = 70 + (Math.abs(hash >> 8) % 20);
  const l = 45 + (Math.abs(hash >> 16) % 15);
  
  const hDecimal = h / 360;
  const sDecimal = s / 100;
  const lDecimal = l / 100;
  
  let r, g, b;
  if (sDecimal === 0) {
    r = g = b = lDecimal;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = lDecimal < 0.5 ? lDecimal * (1 + sDecimal) : lDecimal + sDecimal - lDecimal * sDecimal;
    const p = 2 * lDecimal - q;
    r = hue2rgb(p, q, hDecimal + 1/3);
    g = hue2rgb(p, q, hDecimal);
    b = hue2rgb(p, q, hDecimal - 1/3);
  }
  
  const toHex = x => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return (toHex(r) + toHex(g) + toHex(b)).toUpperCase();
}

function parseTimeStringToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(parts[0]);
}

async function fetchAPI_Direct(url) {
  return fetchAPI(url);
}

async function fetchHistoricalPaginated(baseEndpoint) {
  const firstPage = await fetchAPI_Direct(`${baseEndpoint}?limit=100&offset=0`);
  const total = parseInt(firstPage.MRData.total || 0);
  let allRaces = firstPage.MRData.RaceTable.Races || [];
  
  if (total > 100) {
    const promises = [];
    for (let offset = 100; offset < total; offset += 100) {
      promises.push(fetchAPI_Direct(`${baseEndpoint}?limit=100&offset=${offset}`));
    }
    const pages = await Promise.all(promises);
    pages.forEach(page => {
      const races = page.MRData.RaceTable.Races || [];
      allRaces = allRaces.concat(races);
    });
  }
  return allRaces;
}

async function loadHistoricalSeason(year) {
  if (historicalSeasons.has(year)) {
    return historicalSeasons.get(year);
  }

  try {
    const cached = await dbGet('historical_seasons', year);
    if (cached && cached.meetings) {
      cached.driversBySession = new Map(cached.driversBySession);
      cached.resultsBySession = new Map(cached.resultsBySession);
      cached.lapsBySession = new Map(cached.lapsBySession);

      // Re-register cached historical driver nationalities into the global registry
      for (const [sessionKey, drivers] of cached.driversBySession.entries()) {
        for (const d of drivers) {
          if (d.nationality && d.name_acronym) {
            const countryInfo = translateNationalityToCountry(d.nationality);
            if (countryInfo && !DRIVER_NATIONALITY[d.name_acronym]) {
              DRIVER_NATIONALITY[d.name_acronym] = countryInfo;
            }
          }
        }
      }

      historicalSeasons.set(year, cached);
      return cached;
    }
  } catch (e) {
    console.warn(`[Historical] Failed to parse cached historical data for ${year}:`, e);
  }

  console.log(`[Historical] Fetching bulk data from Jolpi Ergast for season ${year}...`);

  const fetches = [
    fetchAPI_Direct(`https://api.jolpi.ca/ergast/f1/${year}.json?limit=100`),
    fetchHistoricalPaginated(`https://api.jolpi.ca/ergast/f1/${year}/results.json`),
    fetchHistoricalPaginated(`https://api.jolpi.ca/ergast/f1/${year}/qualifying.json`)
  ];

  if (year >= 2021) {
    fetches.push(
      fetchHistoricalPaginated(`https://api.jolpi.ca/ergast/f1/${year}/sprint.json`).catch(() => [])
    );
  }

  const [scheduleData, allRaceResults, allQualiResults, allSprintResults] = await Promise.all(fetches);

  if (!scheduleData || !allRaceResults || !allQualiResults) {
    throw new Error(`Failed to load historical season data for ${year}`);
  }

  const meetings = [];
  const sessions = [];
  const driversBySession = new Map();
  const resultsBySession = new Map();
  const lapsBySession = new Map();

  // Group and merge split rounds from paginated results
  const raceResultsMap = new Map();
  allRaceResults.forEach(r => {
    const round = parseInt(r.round);
    if (!raceResultsMap.has(round)) {
      raceResultsMap.set(round, {
        ...r,
        Results: []
      });
    }
    const accumulated = raceResultsMap.get(round);
    if (r.Results) {
      accumulated.Results = accumulated.Results.concat(r.Results);
    }
  });
  const raceResultsList = Array.from(raceResultsMap.values());

  const qResultsMap = new Map();
  allQualiResults.forEach(r => {
    const round = parseInt(r.round);
    if (!qResultsMap.has(round)) {
      qResultsMap.set(round, {
        ...r,
        QualifyingResults: []
      });
    }
    const accumulated = qResultsMap.get(round);
    if (r.QualifyingResults) {
      accumulated.QualifyingResults = accumulated.QualifyingResults.concat(r.QualifyingResults);
    }
  });
  const qualiResultsList = Array.from(qResultsMap.values());

  const sResultsMap = new Map();
  if (allSprintResults) {
    allSprintResults.forEach(r => {
      const round = parseInt(r.round);
      if (!sResultsMap.has(round)) {
        sResultsMap.set(round, {
          ...r,
          SprintResults: []
        });
      }
      const accumulated = sResultsMap.get(round);
      if (r.SprintResults) {
        accumulated.SprintResults = accumulated.SprintResults.concat(r.SprintResults);
      }
    });
  }
  const sprintResultsList = Array.from(sResultsMap.values());

  // Resolve same-season driver acronym collisions and formatting issues (e.g. spaces/short abbreviations)
  const uniqueDriversInSeason = new Map();
  const collectDrivers = (resultsList, resultsProp) => {
    resultsList.forEach(r => {
      if (r[resultsProp]) {
        r[resultsProp].forEach(res => {
          const d = res.Driver;
          const c = res.Constructor;
          if (d && d.driverId && !uniqueDriversInSeason.has(d.driverId)) {
            uniqueDriversInSeason.set(d.driverId, {
              driver: d,
              constructor: c,
              driverNumber: parseInt(res.number)
            });
          }
        });
      }
    });
  };

  collectDrivers(raceResultsList, 'Results');
  collectDrivers(qualiResultsList, 'QualifyingResults');
  collectDrivers(sprintResultsList, 'SprintResults');

  const acronymToDriverId = new Map();
  const driverIdToAcronym = new Map();

  for (const [driverId, info] of uniqueDriversInSeason.entries()) {
    const d = info.driver;
    let baseAcronym = (d.code || d.familyName.slice(0, 3).toUpperCase()).trim();

    // Ensure acronym is exactly 3 letters and alphanumeric
    if (baseAcronym.length < 3) {
      baseAcronym = (baseAcronym + d.givenName.slice(0, 3 - baseAcronym.length).toUpperCase()).padEnd(3, 'X');
    }
    baseAcronym = baseAcronym.substring(0, 3).toUpperCase();

    // Resolve collisions
    let finalAcronym = baseAcronym;
    if (acronymToDriverId.has(finalAcronym) && acronymToDriverId.get(finalAcronym) !== driverId) {
      const alternate = (d.givenName.slice(0, 1) + d.familyName.slice(0, 2)).toUpperCase();
      if (!acronymToDriverId.has(alternate)) {
        finalAcronym = alternate;
      } else {
        for (let i = 1; i <= 9; i++) {
          const alt2 = baseAcronym.slice(0, 2) + i;
          if (!acronymToDriverId.has(alt2)) {
            finalAcronym = alt2;
            break;
          }
        }
      }
    }

    acronymToDriverId.set(finalAcronym, driverId);
    driverIdToAcronym.set(driverId, finalAcronym);
  }

  const racesList = scheduleData.MRData.RaceTable.Races || [];

  racesList.forEach((r) => {
    const round = parseInt(r.round);
    const meetingKey = `${year}_${round}`;
    
    const country = r.Circuit.Location.country || 'Unknown';
    const countryLower = country.toLowerCase();
    const countryCode = HISTORICAL_COUNTRY_CODES[countryLower] || 'un';
    const countryFlag = `https://flagcdn.com/w320/${countryCode}.png`;
    
    meetings.push({
      meeting_key: meetingKey,
      meeting_name: r.raceName,
      meeting_official_name: r.raceName.toUpperCase(),
      location: r.Circuit.Location.locality,
      country_key: round,
      country_code: countryCode.toUpperCase(),
      country_name: country,
      country_flag: countryFlag,
      circuit_key: round,
      circuit_short_name: r.Circuit.Location.locality,
      circuit_type: 'Permanent',
      circuit_info_url: r.url,
      circuit_image: '',
      gmt_offset: '02:00:00',
      date_start: r.date + 'T10:00:00Z',
      date_end: r.date + 'T18:00:00Z',
      year: year,
      is_cancelled: false
    });

    sessions.push({
      session_key: `${meetingKey}_race`,
      session_name: 'Race',
      session_type: 'Race',
      meeting_key: meetingKey,
      circuit_short_name: r.Circuit.Location.locality,
      date_end: r.date + 'T18:00:00Z'
    });

    const qualiDate = (r.Qualifying && r.Qualifying.date) || r.date;
    sessions.push({
      session_key: `${meetingKey}_quali`,
      session_name: 'Qualifying',
      session_type: 'Qualifying',
      meeting_key: meetingKey,
      circuit_short_name: r.Circuit.Location.locality,
      date_end: qualiDate + 'T16:00:00Z'
    });

    const hasSprint = r.Sprint || (year >= 2021 && sprintResultsList.some(sr => parseInt(sr.round) === round));
    if (hasSprint) {
      const sprintDate = (r.Sprint && r.Sprint.date) || r.date;
      sessions.push({
        session_key: `${meetingKey}_sprint`,
        session_name: 'Sprint',
        session_type: 'Sprint',
        meeting_key: meetingKey,
        circuit_short_name: r.Circuit.Location.locality,
        date_end: sprintDate + 'T17:00:00Z'
      });
    }
  });

  const mapDriver = (d, constructor, driverNum) => {
    const acronym = driverIdToAcronym.get(d.driverId) || d.code || d.familyName.slice(0, 3).toUpperCase();
    const cId = constructor.constructorId;
    const cName = constructor.name;
    const teamColour = getConstructorColor(cId, cName);
    
    // Dynamically register the driver's nationality in DRIVER_NATIONALITY:
    if (d.nationality) {
      const countryInfo = translateNationalityToCountry(d.nationality);
      if (countryInfo && !DRIVER_NATIONALITY[acronym]) {
        DRIVER_NATIONALITY[acronym] = countryInfo;
      }
    }

    return {
      driver_number: driverNum,
      name_acronym: acronym,
      full_name: `${d.givenName} ${d.familyName}`,
      team_name: cName,
      team_colour: teamColour,
      headshot_url: getDriverHeadshot(acronym, year <= 2022 ? 2023 : year) || null,
      nationality: d.nationality
    };
  };

  raceResultsList.forEach((r) => {
    const round = parseInt(r.round);
    const sessionKey = `${year}_${round}_race`;
    const results = [];
    const drivers = [];
    const dummyLaps = [];

    let fastestLapDriver = null;

    if (r.Results) {
      r.Results.forEach((res) => {
        const dNum = parseInt(res.number);
        const position = parseInt(res.position);
        
        const ergastStatus = res.status || 'Finished';
        let status = 'FINISHED';
        if (ergastStatus.includes('Did not start') || ergastStatus.includes('Withdrew') || ergastStatus.includes('Excluded')) {
          status = 'DNS';
        } else if (ergastStatus.includes('Disqualified')) {
          status = 'DSQ';
        } else if (!ergastStatus.includes('Finished') && !/^\+\d/.test(ergastStatus)) {
          status = 'DNF';
        }

        results.push({
          driver_number: dNum,
          position: position,
          status: status,
          points: parseFloat(res.points || 0)
        });

        const driverObj = mapDriver(res.Driver, res.Constructor, dNum);
        drivers.push(driverObj);

        let fastLapDuration = null;
        if (res.FastestLap && res.FastestLap.Time && res.FastestLap.Time.time) {
          fastLapDuration = parseTimeStringToSeconds(res.FastestLap.Time.time);
          if (res.FastestLap.rank === "1") {
            fastestLapDriver = dNum;
          }
        }

        dummyLaps.push({
          driver_number: dNum,
          lap_number: parseInt(res.laps) || 0,
          lap_duration: fastLapDuration,
          is_pit_out_lap: false
        });
      });
    }

    resultsBySession.set(sessionKey, results);
    driversBySession.set(sessionKey, drivers);
    lapsBySession.set(sessionKey, dummyLaps);
  });

  qualiResultsList.forEach((r) => {
    const round = parseInt(r.round);
    const sessionKey = `${year}_${round}_quali`;
    const results = [];
    const drivers = [];

    if (r.QualifyingResults) {
      r.QualifyingResults.forEach((res) => {
        const dNum = parseInt(res.number);
        const position = parseInt(res.position);
        results.push({
          driver_number: dNum,
          position: position,
          status: 'FINISHED'
        });
        
        drivers.push(mapDriver(res.Driver, res.Constructor, dNum));
      });
    }

    resultsBySession.set(sessionKey, results);
    driversBySession.set(sessionKey, drivers);
  });

  sprintResultsList.forEach((r) => {
    const round = parseInt(r.round);
    const sessionKey = `${year}_${round}_sprint`;
    const results = [];
    const drivers = [];
    const dummyLaps = [];

    if (r.SprintResults) {
      r.SprintResults.forEach((res) => {
        const dNum = parseInt(res.number);
        const position = parseInt(res.position);
        
        const ergastStatus = res.status || 'Finished';
        let status = 'FINISHED';
        if (ergastStatus.includes('Did not start') || ergastStatus.includes('Withdrew')) {
          status = 'DNS';
        } else if (ergastStatus.includes('Disqualified')) {
          status = 'DSQ';
        } else if (!ergastStatus.includes('Finished') && !/^\+\d/.test(ergastStatus)) {
          status = 'DNF';
        }

        results.push({
          driver_number: dNum,
          position: position,
          status: status,
          points: parseFloat(res.points || 0)
        });

        drivers.push(mapDriver(res.Driver, res.Constructor, dNum));

        let fastLapDuration = null;
        if (res.FastestLap && res.FastestLap.Time && res.FastestLap.Time.time) {
          fastLapDuration = parseTimeStringToSeconds(res.FastestLap.Time.time);
        }

        dummyLaps.push({
          driver_number: dNum,
          lap_number: parseInt(res.laps) || 0,
          lap_duration: fastLapDuration,
          is_pit_out_lap: false
        });
      });
    }

    resultsBySession.set(sessionKey, results);
    driversBySession.set(sessionKey, drivers);
    lapsBySession.set(sessionKey, dummyLaps);
  });

  const compiledData = {
    meetings,
    sessions,
    driversBySession,
    resultsBySession,
    lapsBySession
  };

  historicalSeasons.set(year, compiledData);

  try {
    const serialized = {
      meetings,
      sessions,
      driversBySession: Array.from(driversBySession.entries()),
      resultsBySession: Array.from(resultsBySession.entries()),
      lapsBySession: Array.from(lapsBySession.entries())
    };
    await dbSet('historical_seasons', year, serialized);
  } catch (e) {
    console.warn(`[Historical] Failed to cache historical data in IndexedDB for ${year}:`, e);
  }

  return compiledData;
}

// ── Cache Config ──
// Two-tier cache: fast in-memory Map + persistent localStorage
const memCache = new Map();
const sessionEndTimes = new Map();
const LS_PREFIX = 'f1c_'; // localStorage key prefix
const LS_VERSION = 3;     // v3: invalidate stale data missing sprints

// TTLs
const TTL_IMMUTABLE = 365 * 24 * 60 * 60 * 1000; // 1 year (past race data)
const TTL_STABLE    = 24 * 60 * 60 * 1000;        // 24 hours (driver info, meetings)
const TTL_FRESH     = 10 * 60 * 1000;              // 10 min (current/live data)

// ── Rate Limiting ──
let requestQueue = Promise.resolve();
const REQUEST_DELAY = 450;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

// ── In-flight deduplication ──
const inFlight = new Map();

// ── Per-minute tracking ──
let minuteRequestCount = 0;
let minuteResetTime = Date.now() + 60000;

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── IndexedDB helpers ──

async function lsGet(url) {
  try {
    const entry = await dbGet('api_cache', url);
    if (!entry || !entry.data) return null;
    if (Date.now() - entry.time > entry.ttl) {
      await dbDelete('api_cache', url);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

async function lsSet(url, data, ttl) {
  try {
    const entry = { data, time: Date.now(), ttl };
    await dbSet('api_cache', url, entry);
  } catch (e) {
    console.warn(`[API] Failed to cache data in IndexedDB for url ${url}:`, e);
  }
}

/**
 * Determine TTL for a given API URL.
 * Past race data → immutable (1 year)
 * Session/meeting lists → stable (24h)
 * Everything else → fresh (10 min)
 */
function getTTL(url) {
  // Jolpi Ergast historical bulk data is immutable for past years
  if (url.includes('api.jolpi.ca')) {
    const yearMatch = url.match(/\/f1\/(\d+)/);
    if (yearMatch) {
      const urlYear = parseInt(yearMatch[1]);
      if (urlYear < new Date().getFullYear()) {
        return TTL_IMMUTABLE;
      }
    }
  }

  // Past race laps/positions/stints/pit/overtakes (session_key is a number)
  // These are immutable once the session is over, EXCEPT if they ended less than 24 hours ago
  if (/\/(laps|position|stints|pit|overtakes|intervals|race_control|weather|session_result)\?/.test(url) &&
      /session_key=(\d+)/.test(url)) {
    const keyMatch = url.match(/session_key=(\d+)/);
    if (keyMatch) {
      const sessionKey = keyMatch[1];
      const endDateStr = sessionEndTimes.get(sessionKey);
      if (endDateStr) {
        const timeSinceEnd = Date.now() - new Date(endDateStr).getTime();
        const oneDay = 24 * 60 * 60 * 1000;
        if (timeSinceEnd > 0 && timeSinceEnd < oneDay) {
          return TTL_FRESH; // Short TTL (10 mins) to pick up late penalty changes
        }
      }
    }
    return TTL_IMMUTABLE;
  }

  // Driver info for a specific session — stable
  if (/\/drivers\?.*session_key=\d+/.test(url)) {
    return TTL_STABLE;
  }

  // Meetings and sessions for past years
  const yearMatch = url.match(/year=(\d+)/);
  if (yearMatch) {
    const urlYear = parseInt(yearMatch[1]);
    const currentYear = new Date().getFullYear();
    if (urlYear < currentYear) {
      return TTL_IMMUTABLE; // Past seasons never change
    }
    // Current year — meetings/sessions can update
    if (/\/(meetings|sessions)\?/.test(url)) {
      return TTL_STABLE;
    }
  }

  return TTL_FRESH;
}

// ── Rate limit helpers ──

async function waitForMinuteSlot() {
  const now = Date.now();
  if (now > minuteResetTime) {
    minuteRequestCount = 0;
    minuteResetTime = now + 60000;
  }
  if (minuteRequestCount >= 28) {
    const waitMs = minuteResetTime - now + 500;
    console.log(`[API] Minute limit approaching (${minuteRequestCount}/30), waiting ${Math.round(waitMs / 1000)}s...`);
    await delay(waitMs);
    minuteRequestCount = 0;
    minuteResetTime = Date.now() + 60000;
  }
  minuteRequestCount++;
}

// ── Core fetch ──

async function fetchAPI(endpoint, params = {}) {
  const url = endpoint.startsWith('http') ? new URL(endpoint) : new URL(`${API_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const cacheKey = url.toString();

  // Tier 1: in-memory cache (instant)
  const memCached = memCache.get(cacheKey);
  if (memCached) return memCached;

  // Tier 2: IndexedDB cache (fast, survives reload)
  const lsCached = await lsGet(cacheKey);
  if (lsCached) {
    memCache.set(cacheKey, lsCached); // promote to memory
    return lsCached;
  }

  // Tier 3: in-flight deduplication
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  // Tier 4: actual API request (queued + rate limited)
  const promise = new Promise((resolve) => {
    requestQueue = requestQueue
      .catch(() => {}) // Prevent previous rejections from breaking the queue
      .then(async () => {
        // Re-check caches (another queued request may have filled them)
        const memNow = memCache.get(cacheKey);
        if (memNow) { resolve(memNow); inFlight.delete(cacheKey); return; }
        const lsNow = await lsGet(cacheKey);
        if (lsNow) {
          memCache.set(cacheKey, lsNow);
          resolve(lsNow);
          inFlight.delete(cacheKey);
          return;
        }

        await waitForMinuteSlot();

        let lastError = null;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            const response = await fetch(url.toString(), { signal: controller.signal });
            clearTimeout(timeout);

            if (response.status === 429) {
              const retryAfter = response.headers.get('Retry-After');
              const waitMs = retryAfter
                ? (parseInt(retryAfter) * 1000 || 5000)
                : RETRY_BASE_DELAY * Math.pow(2, attempt);
              console.warn(`[API] 429 on ${endpoint}, retry in ${waitMs}ms (${attempt + 1}/${MAX_RETRIES})`);
              
              // Force the entire queue to cool down
              minuteRequestCount = 28;
              minuteResetTime = Date.now() + waitMs;

              await delay(waitMs);
              continue;
            }

            if (response.status === 404) {
              const emptyData = [];
              memCache.set(cacheKey, emptyData);
              lsSet(cacheKey, emptyData, TTL_FRESH); // short TTL for 404s
              resolve(emptyData);
              inFlight.delete(cacheKey);
              return;
            }

            if (!response.ok) {
              throw new Error(`API ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            let ttl = getTTL(cacheKey);
            // If the data is empty and we expected records (e.g. race results, stints, laps),
            // do NOT cache it immutably! Instead use a short TTL so it will be retried on next load.
            if (Array.isArray(data) && data.length === 0 && ttl === TTL_IMMUTABLE) {
              console.warn(`[API] Empty response for immutable endpoint ${endpoint}, overriding to TTL_FRESH`);
              ttl = TTL_FRESH;
            }
            memCache.set(cacheKey, data);
            lsSet(cacheKey, data, ttl);
            resolve(data);
            inFlight.delete(cacheKey);
            await delay(REQUEST_DELAY);
            return;
          } catch (err) {
            lastError = err;
            console.warn(`[API] ${err.name === 'AbortError' ? 'Timeout' : err.message} on ${endpoint} (${attempt + 1}/${MAX_RETRIES})`);
            if (attempt < MAX_RETRIES - 1) {
              await delay(RETRY_BASE_DELAY * Math.pow(2, attempt));
            }
          }
        }

        console.error(`[API] All ${MAX_RETRIES} attempts failed: ${endpoint}`, lastError?.message);
        resolve([]);
        inFlight.delete(cacheKey);
        await delay(REQUEST_DELAY);
      });
  });

  inFlight.set(cacheKey, promise);
  return promise;
}

// ── Endpoint Functions ──

export async function getMeetings(year) {
  if (parseInt(year) <= 2022) {
    const data = await loadHistoricalSeason(parseInt(year));
    return data.meetings;
  }
  return fetchAPI('/meetings', { year });
}

export async function getSessions(params = {}) {
  const year = parseInt(params.year);
  let sessionsData = [];
  if (year && year <= 2022) {
    const data = await loadHistoricalSeason(year);
    sessionsData = data.sessions || [];
  } else if (params.meeting_key && typeof params.meeting_key === 'string' && params.meeting_key.includes('_')) {
    const [y] = params.meeting_key.split('_');
    const yNum = parseInt(y);
    if (yNum <= 2022) {
      const data = await loadHistoricalSeason(yNum);
      sessionsData = data.sessions.filter(s => s.meeting_key === params.meeting_key);
    } else {
      sessionsData = await fetchAPI('/sessions', params);
    }
  } else {
    sessionsData = await fetchAPI('/sessions', params);
  }

  // Populate session end times
  if (Array.isArray(sessionsData)) {
    for (const s of sessionsData) {
      if (s.session_key && s.date_end) {
        sessionEndTimes.set(s.session_key.toString(), s.date_end);
      }
    }
  }

  // Apply filters if historical and filter params are present
  if (year && year <= 2022) {
    if (params.session_name === 'Race') {
      return sessionsData.filter(s => s.session_name === 'Race');
    }
    if (params.session_name === 'Sprint') {
      return sessionsData.filter(s => s.session_name === 'Sprint');
    }
    if (params.session_type === 'Qualifying') {
      return sessionsData.filter(s => s.session_name === 'Qualifying');
    }
  }

  return sessionsData;
}

export async function getDrivers(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    const yNum = parseInt(y);
    if (yNum <= 2022) {
      const data = await loadHistoricalSeason(yNum);
      return data.driversBySession.get(params.session_key) || [];
    }
  }
  const drivers = await fetchAPI('/drivers', params);
  if (Array.isArray(drivers)) {
    let year = 2025;
    if (params.year) {
      year = parseInt(params.year) || 2025;
    } else if (params.session_key && typeof params.session_key === 'string') {
      // Try to parse year from session_key if it's formatted as YYYY_something
      const match = params.session_key.match(/^(\d{4})/);
      if (match) year = parseInt(match[1]) || 2025;
    }
    for (const d of drivers) {
      if (d.name_acronym) {
        const acronym = d.name_acronym.toUpperCase();
        if (!d.headshot_url) {
          d.headshot_url = getDriverHeadshot(acronym, year) || null;
        }
        if (d.country_code) {
          const iso3 = d.country_code.toUpperCase();
          if (!DRIVER_NATIONALITY[acronym] && ISO3_TO_COUNTRY[iso3]) {
            DRIVER_NATIONALITY[acronym] = ISO3_TO_COUNTRY[iso3];
          }
        }
      }
    }
  }
  return drivers;
}

export async function getLaps(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    const yNum = parseInt(y);
    if (yNum <= 2022) {
      const data = await loadHistoricalSeason(yNum);
      return data.lapsBySession.get(params.session_key) || [];
    }
  }
  return fetchAPI('/laps', params);
}

export async function getStints(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    if (parseInt(y) <= 2022) return [];
  }
  return fetchAPI('/stints', params);
}

export async function getPits(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    if (parseInt(y) <= 2022) return [];
  }
  return fetchAPI('/pit', params);
}

export async function getOvertakes(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    if (parseInt(y) <= 2022) return [];
  }
  return fetchAPI('/overtakes', params);
}

export async function getPositions(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    if (parseInt(y) <= 2022) return [];
  }
  return fetchAPI('/position', params);
}

export async function getIntervals(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    if (parseInt(y) <= 2022) return [];
  }
  return fetchAPI('/intervals', params);
}

export async function getRaceControl(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    if (parseInt(y) <= 2022) return [];
  }
  return fetchAPI('/race_control', params);
}

export async function getWeather(params = {}) {
  if (params.session_key && typeof params.session_key === 'string' && params.session_key.includes('_')) {
    const [y] = params.session_key.split('_');
    if (parseInt(y) <= 2022) return [];
  }
  return fetchAPI('/weather', params);
}

export async function getSessionResult(params = {}) {
  return fetchAPI('/session_result', params);
}

export async function getRaceSessions(year) {
  const sessions = await getSessions({ year, session_name: 'Race' });
  return sessions.filter(s => !s.is_cancelled);
}

export async function getQualifyingSessions(year) {
  return getSessions({ year, session_type: 'Qualifying' });
}

export async function getMeetingSessions(meetingKey) {
  return getSessions({ meeting_key: meetingKey });
}

export async function getSessionDrivers(sessionKey) {
  return getDrivers({ session_key: sessionKey });
}

export async function getLatestDrivers() {
  return getDrivers({ session_key: 'latest' });
}

// ── Finishing Order from Laps ──

export async function getFinishingOrderFromLaps(sessionKey) {
  const laps = await getLaps({ session_key: sessionKey });
  if (!laps.length) return [];

  const driverData = new Map();
  for (const lap of laps) {
    const dn = lap.driver_number;
    if (!driverData.has(dn)) {
      driverData.set(dn, { lapsCompleted: 0, totalTime: 0 });
    }
    const d = driverData.get(dn);
    if (lap.lap_number > d.lapsCompleted) {
      d.lapsCompleted = lap.lap_number;
    }
    if (lap.lap_duration) {
      d.totalTime += lap.lap_duration;
    }
  }

  const sorted = Array.from(driverData.entries())
    .map(([driver_number, data]) => ({
      driver_number,
      lapsCompleted: data.lapsCompleted,
      totalTime: data.totalTime,
    }))
    .sort((a, b) => {
      if (b.lapsCompleted !== a.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
      return a.totalTime - b.totalTime;
    });

  return sorted.map((d, i) => ({
    driver_number: d.driver_number,
    position: i + 1,
  }));
}

export async function getFinishingOrder(sessionKey) {
  if (typeof sessionKey === 'string' && sessionKey.includes('_')) {
    const [y] = sessionKey.split('_');
    const yNum = parseInt(y);
    if (yNum <= 2022) {
      const data = await loadHistoricalSeason(yNum);
      return data.resultsBySession.get(sessionKey) || [];
    }
  }
  try {
    const results = await getSessionResult({ session_key: sessionKey });
    if (!results || results.length === 0) {
      return getFinishingOrderFromLaps(sessionKey);
    }

    // Sort results: Finishers first (by position), DNFs/DNSs/DSQs at the end
    const sorted = [...results].sort((a, b) => {
      if (a.position === null && b.position !== null) return 1;
      if (a.position !== null && b.position === null) return -1;
      if (a.position === null && b.position === null) return 0;
      return a.position - b.position;
    });

    // Map to our standard schema: { driver_number, position, status }
    return sorted.map((r, index) => {
      let status = 'FINISHED';
      if (r.dsq) status = 'DSQ';
      else if (r.dns) status = 'DNS';
      else if (r.dnf) status = 'DNF';

      // If position is null (like DNF/DSQ/DNS), assign a sequential fallback rank at the end
      const finalPosition = r.position !== null ? r.position : (index + 1);

      return {
        driver_number: r.driver_number,
        position: finalPosition,
        status: status
      };
    });
  } catch (e) {
    console.warn(`[API] Failed to get official finishing order for ${sessionKey}:`, e);
    return getFinishingOrderFromLaps(sessionKey);
  }
}

export async function preloadYear(year) {
  const [meetings, sessions] = await Promise.all([
    getMeetings(year),
    getSessions({ year })
  ]);
  return { meetings, sessions };
}

/**
 * Clear all caches (memory + IndexedDB)
 */
export async function clearCache() {
  memCache.clear();
  try {
    await dbClear('api_cache');
    await dbClear('historical_seasons');
    console.log('[API] Cleared IndexedDB API caches');
  } catch (e) {
    console.error('[API] Failed to clear IndexedDB caches:', e);
  }
}

/**
 * Clear cached entries for a single season only
 */
export async function clearSingleSeasonAPICache(year) {
  memCache.clear();
  try {
    const keys = await dbGetAllKeys('api_cache');
    let clearedCount = 0;
    const deletePromises = [];
    for (const key of keys) {
      if (typeof key === 'string' && (key.includes(`year=${year}`) || key.includes(`year%3D${year}`) || key.includes(`/${year}/`))) {
        deletePromises.push(dbDelete('api_cache', key));
        clearedCount++;
      }
    }
    deletePromises.push(dbDelete('historical_seasons', year));
    await Promise.all(deletePromises);
    console.log(`[API] Cleared ${clearedCount} cached entries for year ${year}`);
  } catch (e) {
    console.error(`[API] Failed to clear single season API cache for ${year}:`, e);
  }
}

/**
 * Clear cached entries (IndexedDB + memory) for specific session keys
 */
export async function clearSessionsAPICache(sessionKeys) {
  // Clear from in-memory cache
  for (const key of memCache.keys()) {
    const match = sessionKeys.some(s => key.includes(`session_key=${s}`));
    if (match) {
      memCache.delete(key);
    }
  }

  // Clear from IndexedDB api_cache
  try {
    const keys = await dbGetAllKeys('api_cache');
    let clearedCount = 0;
    const deletePromises = [];
    for (const key of keys) {
      if (typeof key === 'string') {
        const match = sessionKeys.some(s => key.includes(`session_key=${s}`));
        if (match) {
          deletePromises.push(dbDelete('api_cache', key));
          clearedCount++;
        }
      }
    }
    await Promise.all(deletePromises);
    console.log(`[API] Cleared ${clearedCount} cached entries for sessions: ${sessionKeys.join(', ')}`);
  } catch (e) {
    console.error(`[API] Failed to clear sessions API cache:`, e);
  }
}


/**
 * Get cache stats for debugging
 */
export async function getCacheStats() {
  try {
    const [apiCount, histCount, compiledCount, estimate] = await Promise.all([
      dbGetCount('api_cache'),
      dbGetCount('historical_seasons'),
      dbGetCount('compiled_races'),
      navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve({ usage: 0 })
    ]);

    return {
      memory: memCache.size,
      localStorage: apiCount + histCount + compiledCount,
      localStorageKB: Math.round((estimate.usage || 0) / 1024),
    };
  } catch (err) {
    console.warn('[API] Failed to calculate cache stats:', err);
    return {
      memory: memCache.size,
      localStorage: 0,
      localStorageKB: 0,
    };
  }
}
