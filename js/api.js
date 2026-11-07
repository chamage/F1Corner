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

// Standard ISO-3166-1 alpha-3 / FIA / IOC 3-letter country codes used by OpenF1 /v1/drivers
const OPENF1_COUNTRY_CODES = {
  'GBR': { country: 'United Kingdom', code: 'gb' },
  'GER': { country: 'Germany', code: 'de' },
  'DEU': { country: 'Germany', code: 'de' },
  'FRA': { country: 'France', code: 'fr' },
  'ITA': { country: 'Italy', code: 'it' },
  'BRA': { country: 'Brazil', code: 'br' },
  'USA': { country: 'United States', code: 'us' },
  'FIN': { country: 'Finland', code: 'fi' },
  'AUS': { country: 'Australia', code: 'au' },
  'ESP': { country: 'Spain', code: 'es' },
  'JPN': { country: 'Japan', code: 'jp' },
  'AUT': { country: 'Austria', code: 'at' },
  'CAN': { country: 'Canada', code: 'ca' },
  'NZL': { country: 'New Zealand', code: 'nz' },
  'SWE': { country: 'Sweden', code: 'se' },
  'BEL': { country: 'Belgium', code: 'be' },
  'SUI': { country: 'Switzerland', code: 'ch' },
  'CHE': { country: 'Switzerland', code: 'ch' },
  'ARG': { country: 'Argentina', code: 'ar' },
  'NED': { country: 'Netherlands', code: 'nl' },
  'NLD': { country: 'Netherlands', code: 'nl' },
  'RSA': { country: 'South Africa', code: 'za' },
  'ZAF': { country: 'South Africa', code: 'za' },
  'COL': { country: 'Colombia', code: 'co' },
  'MEX': { country: 'Mexico', code: 'mx' },
  'RUS': { country: 'Russia', code: 'ru' },
  'DEN': { country: 'Denmark', code: 'dk' },
  'DNK': { country: 'Denmark', code: 'dk' },
  'POL': { country: 'Poland', code: 'pl' },
  'MON': { country: 'Monaco', code: 'mc' },
  'MCO': { country: 'Monaco', code: 'mc' },
  'VEN': { country: 'Venezuela', code: 've' },
  'IND': { country: 'India', code: 'in' },
  'THA': { country: 'Thailand', code: 'th' },
  'CHN': { country: 'China', code: 'cn' },
  'IRL': { country: 'Ireland', code: 'ie' },
  'POR': { country: 'Portugal', code: 'pt' },
  'PRT': { country: 'Portugal', code: 'pt' },
  'HUN': { country: 'Hungary', code: 'hu' },
  'CHI': { country: 'Chile', code: 'cl' },
  'CHL': { country: 'Chile', code: 'cl' },
  'URU': { country: 'Uruguay', code: 'uy' },
  'URY': { country: 'Uruguay', code: 'uy' },
  'CZE': { country: 'Czechia', code: 'cz' },
  'EST': { country: 'Estonia', code: 'ee' },
  'NOR': { country: 'Norway', code: 'no' },
  'ISR': { country: 'Israel', code: 'il' },
  'IDN': { country: 'Indonesia', code: 'id' },
  'INA': { country: 'Indonesia', code: 'id' },
  'MYS': { country: 'Malaysia', code: 'my' },
  'MAS': { country: 'Malaysia', code: 'my' },
  'ARE': { country: 'United Arab Emirates', code: 'ae' },
  'UAE': { country: 'United Arab Emirates', code: 'ae' },
  'SAU': { country: 'Saudi Arabia', code: 'sa' },
  'QAT': { country: 'Qatar', code: 'qa' },
  'BHR': { country: 'Bahrain', code: 'bh' },
  'SGP': { country: 'Singapore', code: 'sg' },
  'KOR': { country: 'South Korea', code: 'kr' },
  'TUR': { country: 'Turkey', code: 'tr' },
  'BGR': { country: 'Bulgaria', code: 'bg' },
  'BUL': { country: 'Bulgaria', code: 'bg' },
  'ROU': { country: 'Romania', code: 'ro' }
};

export function registerDriverNationalityFromRecord(driverRecord) {
  if (!driverRecord || !driverRecord.name_acronym) return;
  const acronym = driverRecord.name_acronym;
  if (DRIVER_NATIONALITY[acronym]) return;
  if (driverRecord.country_code) {
    const mapped = OPENF1_COUNTRY_CODES[String(driverRecord.country_code).trim().toUpperCase()];
    if (mapped) {
      DRIVER_NATIONALITY[acronym] = mapped;
    }
  }
}

const API_BASE = 'https://api.openf1.org/v1';

// ── Jolpi Ergast Historical & Modern Fallback Integration ──
const historicalSeasons = new Map();
const jolpiWeekendCache = new Map(); // year_round -> normalized weekend driver-team entries
const enrichedSessionDriversCache = new Map(); // sessionKey -> Promise<driver[]>

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

        const parsedGrid = res.grid !== undefined && res.grid !== null ? parseInt(res.grid, 10) : null;
        results.push({
          driver_number: dNum,
          position: position,
          grid: !isNaN(parsedGrid) ? parsedGrid : null,
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
        const q1Sec = res.Q1 ? parseTimeStringToSeconds(res.Q1) : null;
        const q2Sec = res.Q2 ? parseTimeStringToSeconds(res.Q2) : null;
        const q3Sec = res.Q3 ? parseTimeStringToSeconds(res.Q3) : null;
        results.push({
          driver_number: dNum,
          position: position,
          status: 'FINISHED',
          q1: q1Sec,
          q2: q2Sec,
          q3: q3Sec,
          bestLap: q3Sec || q2Sec || q1Sec || null,
          hasOfficialSegments: true
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

// ── Live Session Lockout Circuit Breaker ──
const LOCKOUT_COOLDOWN_MS = 3 * 60 * 1000; // 3 min cooldown before re-probing locked OpenF1 API
let apiLockoutUntil = 0;
let apiLockoutReason = '';
let activeLiveSessionInfo = null;

export function isApiLocked() {
  return Date.now() < apiLockoutUntil;
}

export function getApiLockoutState() {
  return {
    locked: isApiLocked(),
    until: apiLockoutUntil,
    reason: apiLockoutReason,
    liveSession: activeLiveSessionInfo
  };
}

export function resetApiLockout() {
  apiLockoutUntil = 0;
  apiLockoutReason = '';
  activeLiveSessionInfo = null;
}

export function registerKnownSessionsForLockout(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return;
  const now = Date.now();
  const preBufferMs = 5 * 60 * 1000;
  const postBufferMs = 15 * 60 * 1000;
  for (const s of sessions) {
    if (!s || s.is_cancelled || s.is_fallback || !s.date_start || !s.date_end) continue;
    const startMs = new Date(s.date_start).getTime();
    const endMs = new Date(s.date_end).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && now >= (startMs - preBufferMs) && now <= (endMs + postBufferMs)) {
      activeLiveSessionInfo = {
        session_key: s.session_key,
        session_name: s.session_name || 'Session',
        circuit_short_name: s.circuit_short_name || s.location || '',
        country_name: s.country_name || '',
        date_start: s.date_start,
        date_end: s.date_end
      };
      return;
    }
  }
}

function triggerApiLockout(reason = 'Live F1 session in progress — OpenF1 API temporarily locked') {
  const wasLocked = isApiLocked();
  apiLockoutUntil = Date.now() + LOCKOUT_COOLDOWN_MS;
  apiLockoutReason = reason;
  if (!wasLocked) {
    console.warn(`[API] 🔒 Circuit breaker activated (${reason}). Serving cached data without blocking.`);
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('pitcorner:api-lockout', { detail: getApiLockoutState() }));
      } catch { /* ignore */ }
    }
  }
}

function hasUsableCachedData(data) {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'object') return Object.keys(data).length > 0;
  return true;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── IndexedDB helpers ──

/**
 * Non-destructive cache lookup: returns { data, isExpired, time, ttl }.
 * Never deletes expired entries upfront so stale data can be served if the API is locked or offline.
 */
async function lsGetEntry(url) {
  try {
    const entry = await dbGet('api_cache', url);
    if (!entry || entry.data === undefined || entry.data === null) return null;
    const isExpired = (Date.now() - (entry.time || 0)) > (entry.ttl || TTL_FRESH);
    return {
      data: entry.data,
      isExpired,
      time: entry.time,
      ttl: entry.ttl
    };
  } catch {
    return null;
  }
}

async function lsGet(url) {
  const entry = await lsGetEntry(url);
  if (!entry || entry.isExpired) return null;
  return entry.data;
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
  if (/\/(laps|position|stints|pit|overtakes|intervals|race_control|weather|session_result|starting_grid)\?/.test(url) &&
      /(session_key|meeting_key)=(\d+)/.test(url)) {
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
  const isOpenF1 = cacheKey.includes('api.openf1.org');

  // Tier 1: in-memory cache (instant)
  const memCached = memCache.get(cacheKey);
  if (memCached) return memCached;

  // Tier 2: IndexedDB cache (non-destructive lookup: preserves expired entries as stale fallback)
  const cacheEntry = await lsGetEntry(cacheKey);
  if (cacheEntry && !cacheEntry.isExpired) {
    memCache.set(cacheKey, cacheEntry.data); // promote to memory
    return cacheEntry.data;
  }

  let staleData = (cacheEntry && hasUsableCachedData(cacheEntry.data)) ? cacheEntry.data : null;

  // Fast-path circuit breaker: if OpenF1 is currently locked during a live session,
  // serve stale cached data immediately or fast-resolve [] without waiting in requestQueue!
  if (isOpenF1 && isApiLocked()) {
    if (staleData) {
      memCache.set(cacheKey, staleData);
      return staleData;
    }
    return [];
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
        const entryNow = await lsGetEntry(cacheKey);
        if (entryNow && !entryNow.isExpired) {
          memCache.set(cacheKey, entryNow.data);
          resolve(entryNow.data);
          inFlight.delete(cacheKey);
          return;
        }
        if (!staleData && entryNow && hasUsableCachedData(entryNow.data)) {
          staleData = entryNow.data;
        }

        // Re-check circuit breaker inside queue in case an earlier queued request tripped it
        if (isOpenF1 && isApiLocked()) {
          if (staleData) {
            memCache.set(cacheKey, staleData);
            resolve(staleData);
          } else {
            resolve([]);
          }
          inFlight.delete(cacheKey);
          return;
        }

        await waitForMinuteSlot();

        // If a live session is known to be on track right now, use a shorter timeout & fewer retries
        // so locked/hanging endpoints trip the circuit breaker quickly instead of stalling for 60s.
        const maxAttempts = (isOpenF1 && activeLiveSessionInfo) ? 1 : MAX_RETRIES;
        const timeoutMs = (isOpenF1 && activeLiveSessionInfo) ? 6500 : 20000;

        let lastError = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(url.toString(), { signal: controller.signal });
            clearTimeout(timeout);

            // OpenF1 returns HTTP 401 or 403 when the API is locked during a live F1 session
            if (isOpenF1 && (response.status === 401 || response.status === 403)) {
              let lockDetail = `OpenF1 live session lock (HTTP ${response.status})`;
              try {
                const errJson = await response.json();
                if (errJson?.detail || errJson?.message) {
                  lockDetail = String(errJson.detail || errJson.message);
                }
              } catch { /* ignore body parse error */ }
              triggerApiLockout(lockDetail);
              if (staleData) {
                memCache.set(cacheKey, staleData);
                resolve(staleData);
              } else {
                resolve([]);
              }
              inFlight.delete(cacheKey);
              return;
            }

            if (response.status === 429) {
              // If we already have stale cached data during a live session or heavy rate limit,
              // after 1 retry or during an active live session serve staleData rather than hanging.
              if (isOpenF1 && activeLiveSessionInfo) {
                triggerApiLockout('OpenF1 rate-limited/locked during live session (HTTP 429)');
                if (staleData) {
                  memCache.set(cacheKey, staleData);
                  resolve(staleData);
                } else {
                  resolve([]);
                }
                inFlight.delete(cacheKey);
                return;
              }

              const retryAfter = response.headers.get('Retry-After');
              const waitMs = retryAfter
                ? (parseInt(retryAfter) * 1000 || 5000)
                : RETRY_BASE_DELAY * Math.pow(2, attempt);
              console.warn(`[API] 429 on ${endpoint}, retry in ${waitMs}ms (${attempt + 1}/${maxAttempts})`);
              
              // Force the entire queue to cool down
              minuteRequestCount = 28;
              minuteResetTime = Date.now() + waitMs;

              await delay(waitMs);
              continue;
            }

            if (response.status === 404) {
              if (staleData) {
                memCache.set(cacheKey, staleData);
                resolve(staleData);
                inFlight.delete(cacheKey);
                return;
              }
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

            // OpenF1 endpoints always return JSON Arrays. If OpenF1 returns an error/lock object
            // (e.g. { detail: "Access restricted during live session" }), trigger lockout & fallback!
            if (isOpenF1 && !Array.isArray(data)) {
              const lockMsg = data?.detail || data?.message || data?.error || 'OpenF1 live session lock response';
              triggerApiLockout(String(lockMsg));
              if (staleData) {
                memCache.set(cacheKey, staleData);
                resolve(staleData);
              } else {
                resolve([]);
              }
              inFlight.delete(cacheKey);
              return;
            }

            // Never overwrite non-empty cached data with an unexpected empty [] response
            if (Array.isArray(data) && data.length === 0 && staleData) {
              console.warn(`[API] Preserving non-empty cached data for ${endpoint} after empty [] response`);
              memCache.set(cacheKey, staleData);
              resolve(staleData);
              inFlight.delete(cacheKey);
              await delay(REQUEST_DELAY);
              return;
            }

            let ttl = getTTL(cacheKey);
            // If the data is empty and we expected records (e.g. race results, stints, laps),
            // do NOT cache it immutably! Instead use a short TTL so it will be retried on next load.
            if (Array.isArray(data) && data.length === 0 && ttl === TTL_IMMUTABLE) {
              console.warn(`[API] Empty response for immutable endpoint ${endpoint}, overriding to TTL_FRESH`);
              ttl = TTL_FRESH;
            }
            // If OpenF1 /drivers for a session has any reserve/replacement driver with null team_name,
            // use TTL_FRESH so upstream OpenF1 backfills are picked up quickly
            if (Array.isArray(data) && data.length > 0 && /\/drivers\?.*session_key=\d+/.test(cacheKey)) {
              if (data.some(d => !d || !d.team_name)) {
                ttl = TTL_FRESH;
              }
            }
            if (cacheKey.includes('api.jolpi.ca') && data?.MRData?.RaceTable?.Races?.length === 0) {
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
            console.warn(`[API] ${err.name === 'AbortError' ? 'Timeout' : err.message} on ${endpoint} (${attempt + 1}/${maxAttempts})`);
            if (attempt < maxAttempts - 1) {
              await delay(RETRY_BASE_DELAY * Math.pow(2, attempt));
            }
          }
        }

        if (isOpenF1 && activeLiveSessionInfo) {
          triggerApiLockout(`OpenF1 unreachable during live ${activeLiveSessionInfo.session_name}`);
        }

        if (staleData) {
          console.warn(`[API] ♻️ Serving preserved stale cache for ${endpoint} after network failure (${lastError?.message})`);
          memCache.set(cacheKey, staleData);
          resolve(staleData);
          inFlight.delete(cacheKey);
          return;
        }

        console.error(`[API] All ${maxAttempts} attempts failed: ${endpoint}`, lastError?.message);
        resolve([]);
        inFlight.delete(cacheKey);
        await delay(REQUEST_DELAY);
      });
  });

  inFlight.set(cacheKey, promise);
  return promise;
}

// ── Endpoint Functions ──

async function synthesizeMeetingsFromCompiledSeason(year) {
  try {
    const compiled = await dbGet('compiled_races', `season_compiled_${year}`);
    if (!compiled) return [];
    const sourceSessions = [
      ...(compiled.totalRaceSessions || []),
      ...(compiled.races || []),
      ...(compiled.qualifying || [])
    ];
    if (sourceSessions.length === 0) return [];
    const byMeeting = new Map();
    for (const s of sourceSessions) {
      if (!s || !s.meeting_key) continue;
      const mk = s.meeting_key;
      const existing = byMeeting.get(mk);
      const startStr = s.date_start || s.date_end;
      const endStr = s.date_end || s.date_start;
      if (!existing) {
        const circuit = s.circuit_short_name || s.location || 'Formula 1';
        const meetingName = s.meeting_name || (circuit.includes('Grand Prix') ? circuit : `${circuit} Grand Prix`);
        byMeeting.set(mk, {
          meeting_key: mk,
          meeting_name: meetingName,
          circuit_short_name: circuit,
          location: s.location || circuit,
          country_name: s.country_name || circuit,
          country_code: s.country_code || '',
          country_flag: s.country_flag || '',
          circuit_image: s.circuit_image || '',
          gmt_offset: s.gmt_offset || '00:00:00',
          date_start: startStr,
          date_end: endStr,
          year: Number(year),
          is_synthesized: true
        });
      } else {
        if (startStr && (!existing.date_start || new Date(startStr) < new Date(existing.date_start))) {
          existing.date_start = startStr;
        }
        if (endStr && (!existing.date_end || new Date(endStr) > new Date(existing.date_end))) {
          existing.date_end = endStr;
        }
      }
    }
    return Array.from(byMeeting.values()).sort((a, b) => new Date(a.date_start || a.date_end) - new Date(b.date_start || b.date_end));
  } catch {
    return [];
  }
}

async function synthesizeSessionsFromCompiledSeason(params = {}) {
  try {
    const targetYear = params.year ? parseInt(params.year) : null;
    const candidateYears = targetYear ? [targetYear] : [new Date().getFullYear(), new Date().getFullYear() - 1];
    for (const y of candidateYears) {
      const compiled = await dbGet('compiled_races', `season_compiled_${y}`);
      if (!compiled) continue;
      const combined = [];
      const seenKeys = new Set();
      const pushUnique = (s, defaultType) => {
        if (!s || !s.session_key || seenKeys.has(String(s.session_key))) return;
        seenKeys.add(String(s.session_key));
        combined.push({
          ...s,
          session_name: s.session_name || defaultType || 'Race',
          session_type: s.session_type || (defaultType === 'Qualifying' ? 'Qualifying' : 'Race'),
          date_start: s.date_start || s.date_end,
          date_end: s.date_end || s.date_start,
          year: Number(y)
        });
      };
      for (const s of (compiled.totalRaceSessions || [])) pushUnique(s, s.session_name || 'Race');
      for (const r of (compiled.races || [])) pushUnique(r, r.session_name || 'Race');
      for (const q of (compiled.qualifying || [])) pushUnique(q, q.session_name || 'Qualifying');

      let filtered = combined;
      if (params.meeting_key !== undefined && params.meeting_key !== null) {
        filtered = filtered.filter(s => String(s.meeting_key) === String(params.meeting_key));
      }
      if (params.session_name) {
        filtered = filtered.filter(s => s.session_name === params.session_name);
      }
      if (params.session_type === 'Qualifying') {
        filtered = filtered.filter(s =>
          s.session_type === 'Qualifying' ||
          (s.session_name && (s.session_name.includes('Qualifying') || s.session_name.includes('Shootout')))
        );
      }
      if (filtered.length > 0) return filtered;
    }
    return [];
  } catch {
    return [];
  }
}

export async function getMeetings(year) {
  if (parseInt(year) <= 2022) {
    const data = await loadHistoricalSeason(parseInt(year));
    return data.meetings;
  }
  const meetings = await fetchAPI('/meetings', { year });
  if (Array.isArray(meetings) && meetings.length > 0) {
    return meetings;
  }
  return synthesizeMeetingsFromCompiledSeason(year);
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

  if ((!Array.isArray(sessionsData) || sessionsData.length === 0) && (!year || year > 2022)) {
    const fallbackSessions = await synthesizeSessionsFromCompiledSeason(params);
    if (fallbackSessions.length > 0) {
      sessionsData = fallbackSessions;
    }
  }

  // Populate session end times & check if any session is currently live on track
  if (Array.isArray(sessionsData)) {
    registerKnownSessionsForLockout(sessionsData);
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
  return fetchAPI('/drivers', params);
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

/**
 * Fetch the official post-penalty Starting Grid for a Race or Sprint session.
 * Uses a 3-tier pipeline:
 *  1) Historical seasons (<=2022): Official FIA Ergast 'grid' attribute from results.json / sprint.json
 *  2) Modern seasons (2023+): OpenF1 '/starting_grid' endpoint (by session_key, quali_session_key, or meeting_key)
 *  3) Jolpi Ergast official FIA 'grid' fallback/enrichment (captures Pit Lane starts where grid === 0 or missing OpenF1 grid records)
 */
export async function getStartingGrid(params = {}) {
  const { session_key, meeting_key, quali_session_key, session_name = 'Race', year, date_end, drivers = [] } = params;

  // 1. Historical seasons (1950-2022)
  if (session_key && typeof session_key === 'string' && session_key.includes('_')) {
    const parts = session_key.split('_');
    const yNum = parseInt(parts[0], 10);
    const roundNum = parseInt(parts[1], 10);
    const isSprint = session_key.endsWith('_sprint') || session_name === 'Sprint';
    if (yNum <= 2022) {
      const data = await loadHistoricalSeason(yNum);
      const targetRaceKey = isSprint ? `${yNum}_${roundNum}_sprint` : `${yNum}_${roundNum}_race`;
      const qualiKey = `${yNum}_${roundNum}_quali`;
      const raceRes = data.resultsBySession.get(targetRaceKey) || [];
      const qualiRes = data.resultsBySession.get(qualiKey) || [];
      const qualiMap = new Map(qualiRes.map(q => [q.driver_number, q]));

      // If cached historical_seasons didn't have .grid yet, read from cached Jolpi results
      let gridByDriver = new Map();
      const hasCachedGrid = raceRes.some(r => typeof r.grid === 'number');
      if (hasCachedGrid) {
        for (const r of raceRes) {
          if (typeof r.grid === 'number') gridByDriver.set(r.driver_number, r.grid);
        }
      } else {
        try {
          const endpoint = isSprint
            ? `https://api.jolpi.ca/ergast/f1/${yNum}/sprint.json`
            : `https://api.jolpi.ca/ergast/f1/${yNum}/results.json`;
          const allRounds = await fetchHistoricalPaginated(endpoint);
          const roundObj = allRounds.find(r => parseInt(r.round, 10) === roundNum);
          const list = isSprint ? (roundObj?.SprintResults || []) : (roundObj?.Results || []);
          for (const item of list) {
            const dNum = parseInt(item.number, 10);
            const gVal = parseInt(item.grid, 10);
            if (!isNaN(dNum) && !isNaN(gVal)) {
              gridByDriver.set(dNum, gVal);
            }
          }
        } catch { /* ignore */ }
      }

      if (gridByDriver.size > 0) {
        const out = [];
        for (const [dNum, gPos] of gridByDriver.entries()) {
          const qEntry = qualiMap.get(dNum);
          out.push({
            driver_number: dNum,
            position: gPos > 0 ? gPos : null,
            is_pit_lane: gPos === 0,
            lap_duration: qEntry?.bestLap || qEntry?.q3 || qEntry?.q2 || qEntry?.q1 || null,
            source: 'fia_ergast'
          });
        }
        out.sort((a, b) => {
          if (a.position === null && b.position !== null) return 1;
          if (a.position !== null && b.position === null) return -1;
          return (a.position || 99) - (b.position || 99);
        });
        return out;
      }
      return [];
    }
  }

  // 2. Modern OpenF1 seasons (2023+)
  const isSprint = session_name === 'Sprint' || session_name === 'Sprint Qualifying' || session_name === 'Sprint Shootout';
  let openF1Grid = [];

  if (session_key && !String(session_key).startsWith('upcoming_')) {
    openF1Grid = await fetchAPI('/starting_grid', { session_key }).catch(() => []);
  }
  if ((!Array.isArray(openF1Grid) || openF1Grid.length === 0) && quali_session_key) {
    openF1Grid = await fetchAPI('/starting_grid', { session_key: quali_session_key }).catch(() => []);
  }
  if ((!Array.isArray(openF1Grid) || openF1Grid.length === 0) && meeting_key) {
    const meetingGrid = await fetchAPI('/starting_grid', { meeting_key }).catch(() => []);
    if (Array.isArray(meetingGrid) && meetingGrid.length > 0) {
      const bySk = new Map();
      for (const row of meetingGrid) {
        if (!row || row.session_key == null) continue;
        if (!bySk.has(row.session_key)) bySk.set(row.session_key, []);
        bySk.get(row.session_key).push(row);
      }
      if (session_key && bySk.has(Number(session_key))) {
        openF1Grid = bySk.get(Number(session_key));
      } else if (quali_session_key && bySk.has(Number(quali_session_key))) {
        openF1Grid = bySk.get(Number(quali_session_key));
      } else {
        const sortedKeys = Array.from(bySk.keys()).sort((a, b) => Number(a) - Number(b));
        if (sortedKeys.length > 1) {
          openF1Grid = isSprint ? bySk.get(sortedKeys[0]) : bySk.get(sortedKeys[sortedKeys.length - 1]);
        } else if (sortedKeys.length === 1 && !isSprint) {
          openF1Grid = bySk.get(sortedKeys[0]);
        }
      }
    }
  }

  // Normalize OpenF1 /starting_grid records
  const normalizedMap = new Map();
  if (Array.isArray(openF1Grid) && openF1Grid.length > 0) {
    for (const item of openF1Grid) {
      if (!item || item.driver_number == null) continue;
      const dn = Number(item.driver_number);
      const pos = item.position != null ? Number(item.position) : null;
      normalizedMap.set(dn, {
        driver_number: dn,
        position: (pos && pos > 0) ? pos : null,
        is_pit_lane: pos === 0,
        lap_duration: item.lap_duration || null,
        source: 'openf1'
      });
    }
  }

  // 3. Jolpi Ergast official FIA grid fallback & Pit-Lane Starter enrichment for 2023+
  if ((normalizedMap.size === 0 || normalizedMap.size < 20) && year && Number(year) >= 2023 && date_end) {
    try {
      const sessionTs = new Date(date_end).getTime();
      if (!isNaN(sessionTs)) {
        const schedData = await fetchAPI(`https://api.jolpi.ca/ergast/f1/${year}.json`, { limit: 100 });
        const races = schedData?.MRData?.RaceTable?.Races || [];
        let bestRace = null;
        let bestDiff = Infinity;
        for (const r of races) {
          if (!r.date) continue;
          const diff = Math.abs(new Date(`${r.date}T12:00:00Z`).getTime() - sessionTs);
          if (diff <= 6 * 24 * 60 * 60 * 1000 && diff < bestDiff) {
            bestDiff = diff;
            bestRace = r;
          }
        }
        if (bestRace && bestRace.round) {
          const endpoint = isSprint
            ? `https://api.jolpi.ca/ergast/f1/${year}/${bestRace.round}/sprint.json`
            : `https://api.jolpi.ca/ergast/f1/${year}/${bestRace.round}/results.json`;
          const resJson = await fetchAPI(endpoint, { limit: 100 });
          const rawList = isSprint
            ? (resJson?.MRData?.RaceTable?.Races?.[0]?.SprintResults || [])
            : (resJson?.MRData?.RaceTable?.Races?.[0]?.Results || []);

          const acronymToNum = new Map();
          for (const d of (drivers || [])) {
            if (d && d.name_acronym && d.driver_number != null) {
              acronymToNum.set(String(d.name_acronym).toUpperCase(), Number(d.driver_number));
            }
          }

          for (const item of rawList) {
            const code = item.Driver?.code ? String(item.Driver.code).toUpperCase() : null;
            const carNum = item.number != null ? Number(item.number) : null;
            const dn = (code && acronymToNum.has(code)) ? acronymToNum.get(code) : carNum;
            const gVal = item.grid != null ? parseInt(item.grid, 10) : NaN;
            if (dn == null || isNaN(gVal)) continue;

            if (!normalizedMap.has(dn)) {
              normalizedMap.set(dn, {
                driver_number: dn,
                position: gVal > 0 ? gVal : null,
                is_pit_lane: gVal === 0,
                lap_duration: null,
                source: normalizedMap.size > 0 ? 'openf1' : 'fia_ergast'
              });
            } else if (gVal === 0 && !normalizedMap.get(dn).position) {
              normalizedMap.get(dn).is_pit_lane = true;
            }
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  const finalGrid = Array.from(normalizedMap.values());
  finalGrid.sort((a, b) => {
    if (a.position === null && b.position !== null) return 1;
    if (a.position !== null && b.position === null) return -1;
    return (a.position || 99) - (b.position || 99);
  });
  return finalGrid;
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

function isMissingTeamName(d) {
  return !d || !d.team_name || d.team_name === 'Unknown' || String(d.team_name).trim() === '';
}

function mergeDriverFields(target, patch) {
  if (!target || !patch) return target;
  if (!target.name_acronym && patch.name_acronym) target.name_acronym = patch.name_acronym;
  if (!target.full_name && patch.full_name) target.full_name = patch.full_name;
  if (!target.first_name && patch.first_name) target.first_name = patch.first_name;
  if (!target.last_name && patch.last_name) target.last_name = patch.last_name;
  if (!target.broadcast_name && patch.broadcast_name) target.broadcast_name = patch.broadcast_name;
  if (!target.country_code && patch.country_code) target.country_code = patch.country_code;
  if (!target.meeting_key && patch.meeting_key) target.meeting_key = patch.meeting_key;

  if (isMissingTeamName(target) && !isMissingTeamName(patch)) {
    target.team_name = patch.team_name;
    if (patch.team_colour && patch.team_colour !== '666666') {
      target.team_colour = patch.team_colour;
    }
  }
  if ((!target.team_colour || target.team_colour === '666666') && patch.team_colour && patch.team_colour !== '666666') {
    target.team_colour = patch.team_colour;
  }
  if (!target.headshot_url && patch.headshot_url) {
    target.headshot_url = patch.headshot_url;
  }
  if (!target.headshot_url && target.name_acronym) {
    const fallbackHeadshot = getDriverHeadshot(target.name_acronym);
    if (fallbackHeadshot) target.headshot_url = fallbackHeadshot;
  }
  registerDriverNationalityFromRecord(target);
  return target;
}

const GENERIC_TEAM_TOKENS = new Set(['f1', 'team', 'racing', 'scuderia', 'formula', 'motorsport', 'gp', 'stake', 'kick', 'visa', 'cash', 'app', 'aramco', 'petronas', 'oracle', 'bwt', 'moneygram', 'at', 't']);

function tokenizeTeamIdentifier(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(tok => tok.length >= 2 && !GENERIC_TEAM_TOKENS.has(tok));
}

function matchJolpiTeamToOpenF1(constructorId, constructorName, jolpiEntries, byNumber, meetingDrivers, allWeekendTeams) {
  // 1. Teammate Bridge: find another car on the same Jolpi constructorId in this weekend that already has an OpenF1 team_name
  if (constructorId) {
    const sameConstructorEntries = jolpiEntries.filter(e => e.constructorId === constructorId);
    for (const mate of sameConstructorEntries) {
      const candidates = [];
      if (mate.carNumber != null && byNumber.has(mate.carNumber)) candidates.push(byNumber.get(mate.carNumber));
      if (mate.permanentNumber != null && byNumber.has(mate.permanentNumber)) candidates.push(byNumber.get(mate.permanentNumber));
      if (mate.code) {
        for (const d of byNumber.values()) {
          if (d.name_acronym === mate.code) candidates.push(d);
        }
        for (const md of meetingDrivers) {
          if (md && md.name_acronym === mate.code) candidates.push(md);
        }
      }
      for (const cand of candidates) {
        if (cand && !isMissingTeamName(cand)) {
          return {
            team_name: cand.team_name,
            team_colour: (cand.team_colour && cand.team_colour !== '666666')
              ? cand.team_colour
              : (allWeekendTeams.get(cand.team_name) || getConstructorColor(constructorId, constructorName || cand.team_name))
          };
        }
      }
    }
  }

  // 2. Distinctive token match against OpenF1 team names active on the same weekend
  const targetTokens = new Set([
    ...tokenizeTeamIdentifier(constructorId),
    ...tokenizeTeamIdentifier(constructorName)
  ]);
  if (targetTokens.size > 0 && allWeekendTeams.size > 0) {
    const matches = [];
    for (const [openF1TeamName, openF1Colour] of allWeekendTeams.entries()) {
      const openTokens = tokenizeTeamIdentifier(openF1TeamName);
      if (openTokens.some(t => targetTokens.has(t))) {
        matches.push({ team_name: openF1TeamName, team_colour: openF1Colour });
      }
    }
    if (matches.length === 1) {
      return matches[0];
    }
  }

  // 3. Clean fallback to Jolpi's official constructor name + deterministic color
  if (constructorName) {
    return {
      team_name: constructorName,
      team_colour: getConstructorColor(constructorId, constructorName)
    };
  }
  return null;
}

async function resolveJolpiWeekendEntries(year, sessionDateStr) {
  if (!year || !sessionDateStr) return [];
  const sessionTs = new Date(sessionDateStr).getTime();
  if (isNaN(sessionTs)) return [];

  try {
    const schedData = await fetchAPI(`https://api.jolpi.ca/ergast/f1/${year}.json`, { limit: 100 });
    const races = schedData?.MRData?.RaceTable?.Races;
    if (!Array.isArray(races) || races.length === 0) return [];

    let bestRace = null;
    let bestDiff = Infinity;
    const maxWindowMs = 6 * 24 * 60 * 60 * 1000;

    for (const r of races) {
      if (!r.date) continue;
      const raceTs = new Date(`${r.date}T12:00:00Z`).getTime();
      const diff = Math.abs(raceTs - sessionTs);
      if (diff <= maxWindowMs && diff < bestDiff) {
        bestDiff = diff;
        bestRace = r;
      }
    }

    if (!bestRace || !bestRace.round) return [];
    const roundKey = `${year}_${bestRace.round}`;
    if (jolpiWeekendCache.has(roundKey)) {
      return jolpiWeekendCache.get(roundKey);
    }

    const roundPromises = [
      fetchAPI(`https://api.jolpi.ca/ergast/f1/${year}/${bestRace.round}/results.json`, { limit: 100 }),
      fetchAPI(`https://api.jolpi.ca/ergast/f1/${year}/${bestRace.round}/qualifying.json`, { limit: 100 })
    ];
    if (bestRace.Sprint) {
      roundPromises.push(fetchAPI(`https://api.jolpi.ca/ergast/f1/${year}/${bestRace.round}/sprint.json`, { limit: 100 }));
    }

    const [resJson, qualiJson, sprintJson] = await Promise.all(roundPromises);
    const rawLists = [
      ...(resJson?.MRData?.RaceTable?.Races?.[0]?.Results || []),
      ...(sprintJson?.MRData?.RaceTable?.Races?.[0]?.SprintResults || []),
      ...(qualiJson?.MRData?.RaceTable?.Races?.[0]?.QualifyingResults || [])
    ];

    const entries = rawLists.map(item => ({
      carNumber: item.number != null && !isNaN(Number(item.number)) ? Number(item.number) : null,
      permanentNumber: item.Driver?.permanentNumber != null && !isNaN(Number(item.Driver.permanentNumber)) ? Number(item.Driver.permanentNumber) : null,
      code: item.Driver?.code ? String(item.Driver.code).trim().toUpperCase() : null,
      givenName: item.Driver?.givenName || '',
      familyName: item.Driver?.familyName || '',
      nationality: item.Driver?.nationality || null,
      constructorId: item.Constructor?.constructorId || '',
      constructorName: item.Constructor?.name || ''
    }));

    if (entries.length > 0) {
      jolpiWeekendCache.set(roundKey, entries);
    }
    return entries;
  } catch (err) {
    console.warn('[API] Jolpi weekend driver fallback failed:', err?.message || err);
    return [];
  }
}

/**
 * Dynamically enrich OpenF1 session driver records when OpenF1 returns null/missing team_name
 * (common for mid-season reserve/stand-in drivers) or omits a classified driver from /drivers.
 * Uses a 4-stage zero-hardcode pipeline:
 *  1) Same-weekend OpenF1 /drivers?meeting_key=... merge
 *  2) Official FIA / Jolpi Ergast round results/qualifying/sprint lookup with teammate name bridging
 *  3) Exact FIA 2-car constructor grid vacancy deduction
 *  4) Same-season OpenF1 driver history fallback
 */
export async function enrichDriversForSession(rawDrivers, sessionKey, knownResults = null, sessionMeta = null) {
  const safeRaw = Array.isArray(rawDrivers) ? rawDrivers : [];
  for (const d of safeRaw) {
    registerDriverNationalityFromRecord(d);
  }

  // Historical seasons (<=2022) already come fully hydrated from Jolpi Ergast
  if (typeof sessionKey === 'string' && sessionKey.includes('_')) {
    return safeRaw;
  }

  const rawNums = new Set(safeRaw.map(d => d.driver_number));
  const missingResultNums = new Set();
  if (Array.isArray(knownResults)) {
    for (const r of knownResults) {
      if (r && r.driver_number != null && !rawNums.has(r.driver_number)) {
        missingResultNums.add(r.driver_number);
      }
    }
  }

  const hasIncompleteDriver = safeRaw.length === 0 || safeRaw.some(d => isMissingTeamName(d) || !d.name_acronym);
  if (!hasIncompleteDriver && missingResultNums.size === 0) {
    return safeRaw;
  }

  // Clone records by driver_number so cached raw API arrays are never mutated in place
  const byNumber = new Map();
  for (const d of safeRaw) {
    if (d && d.driver_number != null) {
      byNumber.set(Number(d.driver_number), { ...d });
    }
  }
  for (const dn of missingResultNums) {
    const num = Number(dn);
    if (!byNumber.has(num)) {
      byNumber.set(num, {
        driver_number: num,
        session_key: sessionKey,
        meeting_key: sessionMeta?.meeting_key || safeRaw[0]?.meeting_key || null,
        name_acronym: null,
        full_name: null,
        first_name: null,
        last_name: null,
        team_name: null,
        team_colour: null,
        country_code: null,
        headshot_url: null
      });
    }
  }

  // Resolve session metadata (meeting_key, year, date_end) if not provided by caller
  let meetingKey = sessionMeta?.meeting_key || safeRaw.find(d => d?.meeting_key)?.meeting_key || null;
  let sessionDateEnd = sessionMeta?.date_end || sessionMeta?.date_start || (sessionKey != null ? sessionEndTimes.get(String(sessionKey)) : null) || null;
  let year = sessionMeta?.year || (sessionDateEnd ? new Date(sessionDateEnd).getFullYear() : null);

  if ((!meetingKey || !sessionDateEnd || !year) && sessionKey && sessionKey !== 'latest') {
    const sessionArr = await fetchAPI('/sessions', { session_key: sessionKey });
    const sInfo = Array.isArray(sessionArr) && sessionArr.length > 0 ? sessionArr[0] : null;
    if (sInfo) {
      meetingKey = meetingKey || sInfo.meeting_key;
      sessionDateEnd = sessionDateEnd || sInfo.date_end || sInfo.date_start;
      year = year || sInfo.year || (sessionDateEnd ? new Date(sessionDateEnd).getFullYear() : null);
      if (sInfo.session_key && sInfo.date_end) {
        sessionEndTimes.set(String(sInfo.session_key), sInfo.date_end);
      }
    }
  }

  const allWeekendTeams = new Map(); // team_name -> team_colour
  for (const d of byNumber.values()) {
    if (!isMissingTeamName(d)) {
      if (!allWeekendTeams.has(d.team_name) || (d.team_colour && d.team_colour !== '666666')) {
        allWeekendTeams.set(d.team_name, d.team_colour || '666666');
      }
    }
  }

  // ── Stage 1: Same-Weekend OpenF1 Merge (/drivers?meeting_key=...) ──
  let meetingDrivers = [];
  if (meetingKey) {
    const fetchedMeetingDrivers = await fetchAPI('/drivers', { meeting_key: meetingKey });
    if (Array.isArray(fetchedMeetingDrivers)) {
      meetingDrivers = fetchedMeetingDrivers;
      for (const md of meetingDrivers) {
        if (!md || md.driver_number == null) continue;
        registerDriverNationalityFromRecord(md);
        if (!isMissingTeamName(md)) {
          if (!allWeekendTeams.has(md.team_name) || (md.team_colour && md.team_colour !== '666666')) {
            allWeekendTeams.set(md.team_name, md.team_colour || '666666');
          }
        }
        const num = Number(md.driver_number);
        if (byNumber.has(num)) {
          mergeDriverFields(byNumber.get(num), md);
        } else if (safeRaw.length === 0) {
          byNumber.set(num, mergeDriverFields({ ...md, session_key: sessionKey }, md));
        }
      }
    }
  }

  const stillNeedsResolution = () => {
    for (const d of byNumber.values()) {
      if (isMissingTeamName(d) || !d.name_acronym) return true;
    }
    return false;
  };

  // ── Stage 2: Official FIA / Jolpi Ergast Weekend Lookup ──
  if (stillNeedsResolution() && year && year >= 2023 && sessionDateEnd) {
    const jolpiEntries = await resolveJolpiWeekendEntries(year, sessionDateEnd);
    if (jolpiEntries.length > 0) {
      for (const entry of jolpiEntries) {
        if (entry.code && entry.nationality && !DRIVER_NATIONALITY[entry.code]) {
          const nat = translateNationalityToCountry(entry.nationality);
          if (nat) DRIVER_NATIONALITY[entry.code] = nat;
        }

        // Match target driver in byNumber by session car number first, then acronym, then permanent number
        let target = (entry.carNumber != null && byNumber.has(entry.carNumber)) ? byNumber.get(entry.carNumber) : null;
        if (!target && entry.code) {
          for (const d of byNumber.values()) {
            if (d.name_acronym === entry.code) {
              target = d;
              break;
            }
          }
        }
        if (!target && entry.permanentNumber != null && byNumber.has(entry.permanentNumber)) {
          const cand = byNumber.get(entry.permanentNumber);
          if (!cand.name_acronym || !entry.code || cand.name_acronym === entry.code) {
            target = cand;
          }
        }
        if (!target) continue;

        const fullName = `${entry.givenName} ${entry.familyName}`.trim();
        const acronym = entry.code || target.name_acronym || (entry.familyName ? entry.familyName.slice(0, 3).toUpperCase() : null);
        const resolvedTeam = matchJolpiTeamToOpenF1(
          entry.constructorId,
          entry.constructorName,
          jolpiEntries,
          byNumber,
          meetingDrivers,
          allWeekendTeams
        );

        mergeDriverFields(target, {
          name_acronym: acronym,
          full_name: fullName || null,
          first_name: entry.givenName || null,
          last_name: entry.familyName || null,
          team_name: resolvedTeam?.team_name || null,
          team_colour: resolvedTeam?.team_colour || null,
          headshot_url: acronym ? getDriverHeadshot(acronym) : null
        });

        if (resolvedTeam?.team_name && !allWeekendTeams.has(resolvedTeam.team_name)) {
          allWeekendTeams.set(resolvedTeam.team_name, resolvedTeam.team_colour || '666666');
        }
      }
    }
  }

  // ── Stage 3: Exact FIA 2-Car Constructor Grid Vacancy Deduction ──
  if (stillNeedsResolution()) {
    let activeResults = Array.isArray(knownResults) && knownResults.length > 0 ? knownResults : null;
    if (!activeResults && sessionKey && sessionKey !== 'latest') {
      const fetchedRes = await getSessionResult({ session_key: sessionKey }).catch(() => []);
      if (Array.isArray(fetchedRes) && fetchedRes.length > 0) {
        activeResults = fetchedRes;
      }
    }

    const activeNums = activeResults
      ? Array.from(new Set(activeResults.map(r => Number(r.driver_number)).filter(n => !isNaN(n))))
      : Array.from(byNumber.keys());

    // Ensure any driver present in activeResults exists in byNumber
    for (const dn of activeNums) {
      if (!byNumber.has(dn)) {
        const mdMatch = meetingDrivers.find(m => Number(m.driver_number) === dn);
        byNumber.set(dn, mergeDriverFields({
          driver_number: dn,
          session_key: sessionKey,
          meeting_key: meetingKey,
          name_acronym: null,
          full_name: null,
          team_name: null,
          team_colour: null
        }, mdMatch || {}));
      }
    }

    const teamCounts = new Map();
    for (const [tName] of allWeekendTeams) {
      teamCounts.set(tName, 0);
    }
    for (const d of byNumber.values()) {
      if (!isMissingTeamName(d) && !teamCounts.has(d.team_name)) {
        teamCounts.set(d.team_name, 0);
      }
    }

    const unassignedActiveNums = [];
    for (const dn of activeNums) {
      const d = byNumber.get(dn);
      if (d && !isMissingTeamName(d)) {
        teamCounts.set(d.team_name, (teamCounts.get(d.team_name) || 0) + 1);
      } else {
        unassignedActiveNums.push(dn);
      }
    }

    const underfilledTeams = Array.from(teamCounts.entries()).filter(([, count]) => count < 2);
    if (teamCounts.size >= 8 && unassignedActiveNums.length > 0 && underfilledTeams.length === 1) {
      const [vacantTeamName, currentCars] = underfilledTeams[0];
      const openSeats = 2 - currentCars;
      if (unassignedActiveNums.length <= openSeats) {
        const vacantColour = allWeekendTeams.get(vacantTeamName)
          || Array.from(byNumber.values()).find(d => d.team_name === vacantTeamName && d.team_colour && d.team_colour !== '666666')?.team_colour
          || getConstructorColor(vacantTeamName, vacantTeamName);

        for (const dn of unassignedActiveNums) {
          const d = byNumber.get(dn);
          if (d) {
            d.team_name = vacantTeamName;
            if (!d.team_colour || d.team_colour === '666666') {
              d.team_colour = vacantColour;
            }
          }
        }
      }
    }
  }

  // ── Stage 4: Same-Season OpenF1 Driver History Fallback (for multi-rookie Practice sessions) ──
  if (stillNeedsResolution() && year && year >= 2023) {
    const unresolvedWithAcronym = Array.from(byNumber.values()).filter(d => isMissingTeamName(d) && d.name_acronym);
    if (unresolvedWithAcronym.length > 0) {
      const seasonSessions = await fetchAPI('/sessions', { year }).catch(() => []);
      const validSessionKeys = new Set(
        Array.isArray(seasonSessions) ? seasonSessions.map(s => Number(s.session_key)) : []
      );
      const targetKeyNum = Number(sessionKey) || 0;

      for (const d of unresolvedWithAcronym) {
        const history = await fetchAPI('/drivers', { name_acronym: d.name_acronym }).catch(() => []);
        if (!Array.isArray(history) || history.length === 0) continue;

        const sameSeasonValid = history
          .filter(h => h && validSessionKeys.has(Number(h.session_key)) && !isMissingTeamName(h))
          .sort((a, b) => Math.abs(Number(a.session_key) - targetKeyNum) - Math.abs(Number(b.session_key) - targetKeyNum));

        if (sameSeasonValid.length > 0) {
          mergeDriverFields(d, sameSeasonValid[0]);
        }
      }
    }
  }

  // Ensure sensible fallback acronym & colour if upstream omitted everything
  for (const [dn, d] of byNumber.entries()) {
    if (!d.name_acronym) {
      d.name_acronym = d.last_name ? d.last_name.slice(0, 3).toUpperCase() : `DRV_${dn}`;
    }
    if (!d.full_name) {
      d.full_name = `${d.first_name || ''} ${d.last_name || ''}`.trim() || `Driver #${dn}`;
    }
    if (!isMissingTeamName(d) && (!d.team_colour || d.team_colour === '666666')) {
      d.team_colour = allWeekendTeams.get(d.team_name) || getConstructorColor(d.team_name, d.team_name);
    }
    registerDriverNationalityFromRecord(d);
  }

  return Array.from(byNumber.values());
}

/**
 * Enrichment is best-effort: any failure or stall falls back to the raw OpenF1 driver list
 * so season/race loading is never blocked by the extra team-resolution lookups.
 */
async function safeEnrichDrivers(raw, sessionKey, knownResults = null, sessionMeta = null) {
  try {
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 120000));
    const enriched = await Promise.race([
      enrichDriversForSession(raw, sessionKey, knownResults, sessionMeta),
      timeout
    ]);
    return Array.isArray(enriched) ? enriched : raw;
  } catch (err) {
    console.warn('[API] Driver enrichment failed, using raw drivers:', err?.message || err);
    return raw;
  }
}

export { safeEnrichDrivers };

export async function getSessionDrivers(sessionKey) {
  const cacheKey = String(sessionKey);
  if (enrichedSessionDriversCache.has(cacheKey)) {
    return enrichedSessionDriversCache.get(cacheKey);
  }
  const promise = (async () => {
    const raw = await getDrivers({ session_key: sessionKey });
    return safeEnrichDrivers(raw, sessionKey);
  })();
  enrichedSessionDriversCache.set(cacheKey, promise);
  promise.catch(() => enrichedSessionDriversCache.delete(cacheKey));
  return promise;
}

export async function getLatestDrivers() {
  const raw = await getDrivers({ session_key: 'latest' });
  return safeEnrichDrivers(raw, 'latest');
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
    const parts = sessionKey.split('_');
    const yNum = parseInt(parts[0], 10);
    const roundNum = parseInt(parts[1], 10);
    if (yNum <= 2022) {
      const data = await loadHistoricalSeason(yNum);
      const res = data.resultsBySession.get(sessionKey) || [];
      // Backfill Q1/Q2/Q3 times if historical_seasons was cached before q1/q2/q3 fields were stored
      if (sessionKey.endsWith('_quali') && res.length > 0 && res.every(r => r.q1 === undefined && r.bestLap === undefined)) {
        try {
          const allQuali = await fetchHistoricalPaginated(`https://api.jolpi.ca/ergast/f1/${yNum}/qualifying.json`);
          const roundObj = allQuali.find(r => parseInt(r.round, 10) === roundNum);
          if (roundObj && Array.isArray(roundObj.QualifyingResults)) {
            const byNum = new Map();
            for (const qr of roundObj.QualifyingResults) {
              const dNum = parseInt(qr.number, 10);
              const q1 = qr.Q1 ? parseTimeStringToSeconds(qr.Q1) : null;
              const q2 = qr.Q2 ? parseTimeStringToSeconds(qr.Q2) : null;
              const q3 = qr.Q3 ? parseTimeStringToSeconds(qr.Q3) : null;
              byNum.set(dNum, { q1, q2, q3, bestLap: q3 || q2 || q1 || null });
            }
            for (const item of res) {
              const times = byNum.get(item.driver_number);
              if (times) Object.assign(item, times);
            }
          }
        } catch { /* ignore */ }
      }
      return res;
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

    // Map to our standard schema: { driver_number, position, status, points }
    return sorted.map((r, index) => {
      let status = 'FINISHED';
      if (r.dsq) status = 'DSQ';
      else if (r.dns) status = 'DNS';
      else if (r.dnf) status = 'DNF';

      const isUnclassified = r.position === null || r.position === undefined;
      // If position is null (like DNF/DSQ/DNS), assign a sequential fallback rank at the end
      const finalPosition = !isUnclassified ? r.position : (index + 1);

      const entry = {
        driver_number: r.driver_number,
        position: finalPosition,
        status: status
      };
      // OpenF1 /session_result for Qualifying includes duration: [q1, q2, q3]
      if (Array.isArray(r.duration)) {
        const q1 = typeof r.duration[0] === 'number' && r.duration[0] > 0 ? r.duration[0] : null;
        const q2 = typeof r.duration[1] === 'number' && r.duration[1] > 0 ? r.duration[1] : null;
        const q3 = typeof r.duration[2] === 'number' && r.duration[2] > 0 ? r.duration[2] : null;
        entry.q1 = q1;
        entry.q2 = q2;
        entry.q3 = q3;
        entry.bestLap = q3 || q2 || q1 || null;
        entry.hasOfficialSegments = true;
      } else if (typeof r.duration === 'number' && r.duration > 0) {
        entry.duration = r.duration;
      }
      if (typeof r.number_of_laps === 'number' && r.number_of_laps >= 0) {
        entry.lapCount = r.number_of_laps;
      }
      if (typeof r.points === 'number') {
        entry.points = r.points;
      } else if (isUnclassified) {
        entry.points = 0;
      }
      if (isUnclassified) {
        entry.unclassified = true;
      }
      return entry;
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
  resetApiLockout();
  memCache.clear();
  jolpiWeekendCache.clear();
  enrichedSessionDriversCache.clear();
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
  resetApiLockout();
  memCache.clear();
  jolpiWeekendCache.clear();
  enrichedSessionDriversCache.clear();
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
  resetApiLockout();
  jolpiWeekendCache.clear();
  for (const sk of sessionKeys) {
    enrichedSessionDriversCache.delete(String(sk));
  }
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
