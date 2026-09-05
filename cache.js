/**
 * LUMIÈRE — client-side HTTP cache layer.
 *
 * A drop-in replacement for `fetch()` that transparently caches successful GET
 * responses in localStorage with a per-content-type TTL, deduplicates in-flight
 * requests, and evicts least-recently-used entries when storage fills up.
 *
 *   import { cachedFetch } from './cache.js';
 *   const res = await cachedFetch(url, { headers });   // same shape as fetch()
 *   const data = await res.json();
 *
 * Design decisions worth knowing:
 *
 *  - Returns a real `Response`, not parsed JSON. That makes it a true drop-in:
 *    existing `res.ok` / `res.json()` / `res.status` code keeps working, and a
 *    cache hit is indistinguishable from a network hit except for the
 *    `x-cache: HIT` header it carries.
 *  - Only 2xx GET responses are cached. Errors, redirects and non-GET methods
 *    pass straight through, so a rate-limit 429 is never cached and replayed.
 *  - Auth params are stripped from the cache key, so a request made with a
 *    bearer header and the same request made with `?api_key=` share one entry.
 *  - Every storage write is quota-guarded. A full localStorage degrades to
 *    "evict and retry", then to "serve from network without caching" — it never
 *    throws into application code.
 *  - If localStorage is unavailable entirely (private mode, disabled cookies,
 *    embedded webview), the layer silently falls back to an in-memory store for
 *    the life of the page. The app behaves identically, just without persistence.
 */

/* ============================================================================
 * 1. CONFIGURATION
 * ========================================================================== */

// Namespace + schema version. Bumping the version orphans old entries, which
// the janitor below sweeps on the next load — a safe way to ship a format change.
const NS = 'lumiere.cache.v1:';
const INDEX_KEY = `${NS}__index__`;

const MINUTE = 60 * 1000;

/** Never cache a single response larger than this (bytes). One huge entry can
 *  evict the entire rest of the cache for no benefit. */
const MAX_ENTRY_BYTES = 512 * 1024;

/** Safety valve on the eviction loop so a pathological store can't spin. */
const MAX_EVICTIONS_PER_WRITE = 200;

/**
 * Default TTLs by content type, in minutes. First matching rule wins.
 *
 *  - Trending / popular / discover: refreshed by TMDB roughly daily → 12h.
 *  - Search: users expect reasonably fresh results, but repeat the same query
 *    constantly while browsing → 1h.
 *  - Details, seasons, credits, videos: effectively immutable → 7 days.
 */
const TTL_RULES = [
  { test: /\/(trending|popular|top_rated|now_playing|upcoming|airing_today|on_the_air|discover)\b/, minutes: 12 * 60 },
  { test: /\/search\//,                                                                              minutes: 60 },
  { test: /\/(movie|tv|person)\/\d+/,                                                                minutes: 7 * 24 * 60 },
  { test: /\/(genre|configuration)\b/,                                                               minutes: 7 * 24 * 60 },
];

const DEFAULT_TTL_MINUTES = 60;

/** Query params that must not affect the cache key (they carry credentials). */
const IGNORED_PARAMS = new Set(['api_key', 'access_token', 'session_id', '_']);

/* ============================================================================
 * 2. STORAGE BACKEND (localStorage, with in-memory fallback)
 * ========================================================================== */

/** Minimal Storage-compatible in-memory shim. */
function createMemoryStore() {
  const map = new Map();
  return {
    isMemory: true,
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/**
 * Probe localStorage. Safari private mode and some webviews expose the object
 * but throw on write, so an actual write is the only reliable test.
 */
function resolveStore() {
  try {
    const probe = `${NS}__probe__`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    console.warn('[cache] localStorage unavailable — using in-memory cache for this session.');
    return createMemoryStore();
  }
}

const store = resolveStore();

/** Rough byte cost of an entry. Browsers store DOMString as UTF-16 → 2 bytes/char. */
const byteSize = (key, value) => (key.length + value.length) * 2;

/** Cross-browser QuotaExceededError detection. */
function isQuotaError(err) {
  if (!err) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||   // Firefox
    err.code === 22 ||
    err.code === 1014
  );
}

/* ============================================================================
 * 3. THE INDEX
 *
 * A single JSON blob holding metadata for every entry:
 *   { "<key>": { e: expiryMs, l: lastAccessMs, s: sizeBytes } }
 *
 * Kept separate from the entries themselves so eviction can rank the whole
 * cache without parsing (or even reading) every stored payload.
 * ========================================================================== */

let index = loadIndex();
let indexDirty = false;
let flushHandle = null;

function loadIndex() {
  try {
    const raw = store.getItem(INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Corrupt index: start clean rather than fighting it.
    return {};
  }
}

/** Write the index immediately. Returns false if even the index won't fit. */
function flushIndex() {
  indexDirty = false;
  try {
    store.setItem(INDEX_KEY, JSON.stringify(index));
    return true;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    // The index itself no longer fits. Evict aggressively and retry once.
    evictLRU(Math.max(1, Math.ceil(Object.keys(index).length * 0.25)));
    try {
      store.setItem(INDEX_KEY, JSON.stringify(index));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Mark the index dirty and flush on the next idle tick.
 *
 * Why deferred: every cache HIT updates `lastAccess`, and rewriting the whole
 * index synchronously on every read would make reads more expensive than the
 * network calls they replace. Batching collapses a burst of hits into one write.
 */
function scheduleIndexFlush() {
  indexDirty = true;
  if (flushHandle != null) return;
  const schedule = window.requestIdleCallback || ((fn) => setTimeout(fn, 0));
  flushHandle = schedule(() => {
    flushHandle = null;
    if (indexDirty) flushIndex();
  });
}

// Never lose the last batch of access-time updates on navigation.
window.addEventListener('pagehide', () => { if (indexDirty) flushIndex(); });

/* ============================================================================
 * 4. EVICTION
 * ========================================================================== */

function removeEntry(key) {
  try { store.removeItem(key); } catch { /* nothing useful to do */ }
  delete index[key];
}

/** Drop every entry past its expiry. Returns the number removed. */
function purgeExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [key, meta] of Object.entries(index)) {
    if (meta.e <= now) { removeEntry(key); removed++; }
  }
  if (removed) indexDirty = true;
  return removed;
}

/**
 * Evict the N least-recently-used entries. Returns the number removed.
 * Expired entries are always cheaper to lose, so they go first.
 */
function evictLRU(count = 1) {
  const expired = purgeExpired();
  if (expired >= count) return expired;

  const remaining = count - expired;
  const ranked = Object.entries(index).sort((a, b) => a[1].l - b[1].l);  // oldest access first
  let removed = expired;

  for (let i = 0; i < remaining && i < ranked.length; i++) {
    removeEntry(ranked[i][0]);
    removed++;
  }
  if (removed) indexDirty = true;
  return removed;
}

/**
 * Sweep entries that belong to an older schema version, or that exist in
 * storage but not in the index (a write that died between the two steps).
 * Runs once on load; cost is proportional to localStorage key count, not size.
 */
function reconcile() {
  const orphans = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key) continue;
    if (key.startsWith('lumiere.cache.') && !key.startsWith(NS)) orphans.push(key); // old version
    else if (key.startsWith(NS) && key !== INDEX_KEY && !(key in index)) orphans.push(key);
  }
  for (const key of orphans) {
    try { store.removeItem(key); } catch { /* ignore */ }
  }
  // Index entries whose payload vanished (e.g. user cleared site data partially).
  for (const key of Object.keys(index)) {
    if (store.getItem(key) === null) { delete index[key]; indexDirty = true; }
  }
  purgeExpired();
  if (indexDirty) flushIndex();
}
reconcile();

/* ============================================================================
 * 5. READ / WRITE
 * ========================================================================== */

/**
 * Write an entry, evicting as needed to make room.
 * Returns true if stored, false if the write was abandoned (never throws for
 * quota — a cache that can't store is a slow cache, not a broken app).
 */
function writeEntry(key, payload, expiry) {
  const value = JSON.stringify(payload);
  const size = byteSize(key, value);

  if (size > MAX_ENTRY_BYTES) {
    // Too big to be worth the space it would evict.
    return false;
  }

  for (let attempt = 0; attempt <= MAX_EVICTIONS_PER_WRITE; attempt++) {
    try {
      store.setItem(key, value);
      index[key] = { e: expiry, l: Date.now(), s: size };
      flushIndex();
      return true;
    } catch (err) {
      if (!isQuotaError(err)) throw err;

      // Out of room. Free some and try again. Evict in growing batches so a
      // large payload doesn't need hundreds of single-entry round trips.
      const freed = evictLRU(attempt === 0 ? 5 : 10);
      if (freed === 0) {
        // Nothing left to evict and it still doesn't fit — give up quietly.
        console.warn('[cache] Storage full and nothing left to evict; skipping cache write.');
        flushIndex();
        return false;
      }
    }
  }
  return false;
}

/** Read a live entry, or null on miss / expiry / corruption. */
function readEntry(key) {
  const meta = index[key];
  if (!meta) return null;

  if (meta.e <= Date.now()) {          // expired
    removeEntry(key);
    scheduleIndexFlush();
    return null;
  }

  let raw;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) {                  // index/storage drift
    delete index[key];
    scheduleIndexFlush();
    return null;
  }

  try {
    const payload = JSON.parse(raw);
    meta.l = Date.now();               // LRU touch
    scheduleIndexFlush();
    return payload;
  } catch {
    removeEntry(key);                  // corrupt JSON
    scheduleIndexFlush();
    return null;
  }
}

/* ============================================================================
 * 6. KEYS AND TTL
 * ========================================================================== */

/**
 * Build a stable cache key from a URL.
 * Params are sorted (so `?a=1&b=2` and `?b=2&a=1` are one entry) and credential
 * params are dropped (so bearer and api_key callers share one entry).
 */
function makeKey(url) {
  let parsed;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return NS + String(url);
  }

  const params = [...parsed.searchParams.entries()]
    .filter(([k]) => !IGNORED_PARAMS.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  return `${NS}${parsed.origin}${parsed.pathname}${params ? '?' + params : ''}`;
}

/** Pick a TTL (ms) for a URL from TTL_RULES. */
function ttlForUrl(url) {
  let path;
  try {
    path = new URL(url, window.location.href).pathname;
  } catch {
    path = String(url);
  }
  const rule = TTL_RULES.find((r) => r.test.test(path));
  return (rule ? rule.minutes : DEFAULT_TTL_MINUTES) * MINUTE;
}

/* ============================================================================
 * 7. IN-FLIGHT DEDUPLICATION
 *
 * Two components asking for the same URL in the same tick should cost one
 * network request, not two. Matters most on first paint, where several rails
 * can request overlapping endpoints before anything has been cached.
 * ========================================================================== */

const inFlight = new Map();   // cacheKey -> Promise<Response>

/* ============================================================================
 * 8. PUBLIC API
 * ========================================================================== */

/**
 * Cache-aware fetch. Same signature and return type as `fetch`.
 *
 * @param {string|URL} url
 * @param {RequestInit} [options]        passed through to fetch()
 * @param {number}      [ttlInMinutes]   overrides the TTL_RULES default
 * @returns {Promise<Response>}          cache hits carry `x-cache: HIT`
 *
 * Bypass the cache for one call with `options.cache = 'reload'`.
 */
export async function cachedFetch(url, options = {}, ttlInMinutes) {
  const href = String(url);
  const method = (options.method || 'GET').toUpperCase();

  // Only GET is safely cacheable. Everything else goes straight to the network.
  if (method !== 'GET') return fetch(href, options);

  const key = makeKey(href);
  const bypass = options.cache === 'reload' || options.cache === 'no-store';

  // --- 1. Cache hit ---------------------------------------------------------
  if (!bypass) {
    const hit = readEntry(key);
    if (hit) {
      return new Response(hit.b, {
        status: hit.s || 200,
        statusText: 'OK',
        headers: { ...(hit.h || {}), 'x-cache': 'HIT', 'x-cache-age-ms': String(Date.now() - hit.t) },
      });
    }

    // --- 2. Already being fetched -> join that request, don't start a second.
    const pending = inFlight.get(key);
    if (pending) return (await pending).clone();
  }

  // --- 3. Network -----------------------------------------------------------
  const task = (async () => {
    const res = await fetch(href, options);

    // Never cache errors: a cached 429 or 500 would poison the app for hours.
    if (!res.ok) return res;

    // Read the body once, then hand every caller their own Response built from it.
    const body = await res.text();
    const ttl = (typeof ttlInMinutes === 'number' && ttlInMinutes > 0)
      ? ttlInMinutes * MINUTE
      : ttlForUrl(href);

    writeEntry(key, {
      t: Date.now(),
      b: body,
      s: res.status,
      h: { 'content-type': res.headers.get('content-type') || 'application/json' },
    }, Date.now() + ttl);

    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: {
        'content-type': res.headers.get('content-type') || 'application/json',
        'x-cache': 'MISS',
      },
    });
  })();

  inFlight.set(key, task);
  try {
    const res = await task;
    return res.clone();
  } finally {
    inFlight.delete(key);
  }
}

/** Remove every cached entry whose key matches a substring or RegExp. */
export function invalidateCache(pattern) {
  const match = pattern instanceof RegExp
    ? (k) => pattern.test(k)
    : (k) => k.includes(String(pattern));

  let removed = 0;
  for (const key of Object.keys(index)) {
    if (match(key)) { removeEntry(key); removed++; }
  }
  flushIndex();
  return removed;
}

/** Wipe the whole cache (entries + index). */
export function clearCache() {
  for (const key of Object.keys(index)) removeEntry(key);
  index = {};
  flushIndex();
}

/** Snapshot for debugging: entry count, total bytes, expiry spread. */
export function cacheStats() {
  const entries = Object.entries(index);
  const now = Date.now();
  return {
    backend: store.isMemory ? 'memory' : 'localStorage',
    entries: entries.length,
    bytes: entries.reduce((sum, [, m]) => sum + (m.s || 0), 0),
    expired: entries.filter(([, m]) => m.e <= now).length,
    oldestAccess: entries.length ? new Date(Math.min(...entries.map(([, m]) => m.l))) : null,
  };
}

// Handy in the console: `window.__cache.stats()`
if (typeof window !== 'undefined') {
  window.__cache = { stats: cacheStats, clear: clearCache, invalidate: invalidateCache };
}
