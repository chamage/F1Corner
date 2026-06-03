// =============================================
// PITCORNER — IndexedDB Storage Engine
// Promisified helper to manage async browser cache storage.
// =============================================

const DB_NAME = 'f1corner_db';
const DB_VERSION = 2;

// Eagerly open IndexedDB connection on script load to run in parallel with HTML/JS parsing
const dbPromise = new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('IndexedDB is not supported'));
    return;
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = (event) => {
    const db = event.target.result;
    
    // Store for core API URL requests
    if (!db.objectStoreNames.contains('api_cache')) {
      db.createObjectStore('api_cache');
    }
    
    // Store for compiled race & qualifying data
    if (!db.objectStoreNames.contains('compiled_races')) {
      db.createObjectStore('compiled_races');
    }
    
    // Store for historical season data
    if (!db.objectStoreNames.contains('historical_seasons')) {
      db.createObjectStore('historical_seasons');
    }
  };

  request.onsuccess = (event) => {
    resolve(event.target.result);
  };

  request.onerror = (event) => {
    console.error('[DB] Failed to open IndexedDB:', event.target.error);
    reject(event.target.error);
  };
});

function getDB() {
  return dbPromise;
}

// Helper to wrap object store operations
async function getStore(storeName, mode = 'readonly') {
  const db = await getDB();
  const tx = db.transaction(storeName, mode);
  return tx.objectStore(storeName);
}

export async function dbGet(storeName, key) {
  try {
    const store = await getStore(storeName, 'readonly');
    return await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`[DB] get failed for ${storeName}/${key}:`, err);
    return null;
  }
}

export async function dbSet(storeName, key, value) {
  try {
    const store = await getStore(storeName, 'readwrite');
    return await new Promise((resolve, reject) => {
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`[DB] put failed for ${storeName}/${key}:`, err);
  }
}

export async function dbDelete(storeName, key) {
  try {
    const store = await getStore(storeName, 'readwrite');
    return await new Promise((resolve, reject) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`[DB] delete failed for ${storeName}/${key}:`, err);
  }
}

export async function dbClear(storeName) {
  try {
    const store = await getStore(storeName, 'readwrite');
    return await new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`[DB] clear failed for ${storeName}:`, err);
  }
}

export async function dbGetAllKeys(storeName) {
  try {
    const store = await getStore(storeName, 'readonly');
    return await new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`[DB] getAllKeys failed for ${storeName}:`, err);
    return [];
  }
}

export async function dbGetAllEntries(storeName) {
  try {
    const store = await getStore(storeName, 'readonly');
    return await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`[DB] getAll entries failed for ${storeName}:`, err);
    return [];
  }
}

export async function dbGetMultiple(storeName, keys) {
  try {
    if (!keys || keys.length === 0) return new Map();
    const db = await getDB();
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);

    const promises = keys.map(key => {
      return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve({ key, value: request.result });
        request.onerror = () => reject(request.error);
      });
    });

    const results = await Promise.all(promises);
    const map = new Map();
    for (const res of results) {
      map.set(res.key, res.value);
    }
    return map;
  } catch (err) {
    console.error(`[DB] getMultiple failed for ${storeName}:`, err);
    return new Map();
  }
}

export async function dbGetCount(storeName) {
  try {
    const store = await getStore(storeName, 'readonly');
    return await new Promise((resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`[DB] count failed for ${storeName}:`, err);
    return 0;
  }
}
