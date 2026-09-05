/**
 * LUMIÈRE — application logic.
 *
 * Views are hash-routed, so every page is deep-linkable, bookmarkable, and
 * survives a refresh:
 *
 *   #/                                     home (trending rails)
 *   #/search/{query}                       search results
 *   #/movie/{id}                           movie detail + player
 *   #/tv/{id}                              series detail + season list
 *   #/tv/{id}/season/{n}                   season detail + episode list
 *   #/tv/{id}/season/{n}/episode/{e}       episode detail + player
 *
 * All network traffic goes through cachedFetch (cache.js): persistent,
 * TTL'd per content type, LRU-evicted. Nothing here manages caching.
 */

import { cachedFetch } from './cache.js';

/* ============================================================================
 * 1. CONFIGURATION
 * ========================================================================== */

const TMDB = {
  base: 'https://api.themoviedb.org/3',
  // Read-only (api_read scope) token. NOT a secret — it ships to the browser.
  bearer:
    'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmZmVhOTc1MDZiMWYwNDE2MTQ1Yzk1MjgzYTI5OGUxYSIsIm5iZiI6MTc1NTE2Mjk4OC4zODQsInN1YiI6IjY4OWRhOTZjMmExNzk2YTY4NTFhM2M2MiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.qsQlbV6ovGA6uXjGNT5woZHTfwIff2FizY-kbViNznk',
  apiKey: 'ffea97506b1f0416145c95283a298e1a',
};

// Sized image endpoints. Requesting w185 for a 90px avatar is the single
// biggest bandwidth win available here — never point these all at /original.
const IMG = {
  poster:   'https://image.tmdb.org/t/p/w500',
  backdrop: 'https://image.tmdb.org/t/p/original',
  profile:  'https://image.tmdb.org/t/p/w185',
  still:    'https://image.tmdb.org/t/p/w300',
  logo:     'https://image.tmdb.org/t/p/w185',
};

/** Inline SVG placeholders — no extra request, so they can never fail to load. */
const ph = (w, h, label) =>
  'data:image/svg+xml;charset=UTF-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<rect width="100%" height="100%" fill="#1a1a22"/>` +
      (label
        ? `<text x="50%" y="50%" fill="#4d4d5c" font-family="system-ui,sans-serif"` +
          ` font-size="${Math.round(w / 12)}" text-anchor="middle" dominant-baseline="middle">${label}</text>`
        : '') +
      `</svg>`
  );

const PLACEHOLDER = {
  poster:   ph(500, 750, 'No image'),
  backdrop: ph(1280, 720, ''),
  profile:  ph(185, 278, ''),
  still:    ph(300, 169, ''),
};

// VidSrc embed host. PATH-style endpoints, per the vidsrc.to API docs:
//   movie:   /embed/movie/{id}
//   series:  /embed/tv/{id}
//   season:  /embed/tv/{id}/{season}
//   episode: /embed/tv/{id}/{season}/{episode}
// {id} takes a bare TMDB id, or an IMDb id with its tt prefix.
const VIDSRC_HOSTS = [
  'https://vidsrc.to/embed',
  'https://vidsrc.net/embed',
  'https://vidsrc.xyz/embed',
];
let vidsrcHostIndex = 0;
const vidsrcBase = () => VIDSRC_HOSTS[vidsrcHostIndex];

const SEARCH_DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 10000;

/* ============================================================================
 * 2. TINY VIEW HELPERS
 * ========================================================================== */

/**
 * Minimal hyperscript. Everything is built with createElement/textContent —
 * TMDB strings (titles, overviews, character names) are never interpolated
 * into innerHTML, so hostile metadata cannot inject markup.
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** <img> with a guaranteed fallback for both a null path and a CDN failure. */
function img(src, alt, { className, fallback, eager } = {}) {
  const node = h('img', {
    class: className,
    src: src || fallback,
    alt: alt || '',
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
  });
  node.addEventListener('error', () => { node.src = fallback; }, { once: true });
  return node;
}

const el = (sel) => document.querySelector(sel);

/** Trailing debounce. */
function debounce(fn, wait) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

/* --- Formatting -------------------------------------------------------- */

const year = (date) => (date ? String(date).slice(0, 4) : '');

/** 8.437 → "8.4"; 0 and null both mean "unrated" here, not "terrible". */
const rating = (v) => (typeof v === 'number' && v > 0 ? v.toFixed(1) : null);

/** 142 → "2h 22m" */
function runtime(mins) {
  if (!mins || mins <= 0) return null;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return hrs ? `${hrs}h${rem ? ` ${rem}m` : ''}` : `${rem}m`;
}

function fullDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

const money = (n) =>
  n && n > 0 ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : null;

/* ============================================================================
 * 3. DATA LAYER
 * ========================================================================== */

/**
 * Fetch a TMDB endpoint.
 *
 * @param {string} endpoint     e.g. '/movie/550'
 * @param {object} params       query params
 * @param {number} [ttlMinutes] override the TTL cache.js picks by URL
 */
async function fetchData(endpoint, params = {}, ttlMinutes) {
  try {
    return await request(endpoint, params, { useBearer: true, ttlMinutes });
  } catch (err) {
    // Only auth rejection is worth a retry — a 404 fails identically twice.
    if (err.status === 401 || err.status === 403) {
      console.warn('[lumiere] Bearer rejected, retrying with api_key fallback.');
      return await request(endpoint, params, { useBearer: false, ttlMinutes });
    }
    throw err;
  }
}

async function request(endpoint, params, { useBearer, ttlMinutes }) {
  const url = new URL(TMDB.base + endpoint);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }

  const headers = { accept: 'application/json' };
  if (useBearer) headers.Authorization = `Bearer ${TMDB.bearer}`;
  else url.searchParams.set('api_key', TMDB.apiKey);

  // Hard timeout so a hung request can't wedge a view in its loading state.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await cachedFetch(url.toString(), { headers, signal: controller.signal }, ttlMinutes);
    if (!res.ok) {
      const err = new Error(`TMDB ${res.status} ${res.statusText} for ${endpoint}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`TMDB request timed out after ${REQUEST_TIMEOUT_MS}ms: ${endpoint}`);
      e.status = 0;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TMDB splits identical concepts across movie and TV field names.
 * Normalize once so no view has to branch on media type.
 */
function normalize(item, fallbackType = 'movie') {
  const type = item.media_type === 'movie' || item.media_type === 'tv' ? item.media_type : fallbackType;
  const date = item.release_date || item.first_air_date || '';
  return {
    id: item.id,
    type,
    title: item.title || item.name || 'Untitled',
    overview: item.overview || '',
    year: year(date),
    rating: rating(item.vote_average),
    poster: item.poster_path ? IMG.poster + item.poster_path : PLACEHOLDER.poster,
    backdrop: item.backdrop_path ? IMG.backdrop + item.backdrop_path : PLACEHOLDER.backdrop,
  };
}

/* --- Endpoint wrappers --------------------------------------------------
 * append_to_response bundles credits + recommendations into the SAME request.
 * Three round trips become one — the biggest single latency win on a detail page.
 * ---------------------------------------------------------------------- */

const getMovie = (id) =>
  fetchData(`/movie/${id}`, { append_to_response: 'credits,recommendations,videos,release_dates' });

const getSeries = (id) =>
  fetchData(`/tv/${id}`, { append_to_response: 'credits,recommendations,content_ratings' });

const getSeason = (id, n) =>
  fetchData(`/tv/${id}/season/${n}`, { append_to_response: 'credits' });

/* ============================================================================
 * 4. APPLICATION STATE
 * ========================================================================== */

const state = {
  route: null,       // parsed route object
  player: null,      // { type, id, season, episode } currently mounted
  searchSeq: 0,      // discards out-of-order search responses
};

/* ============================================================================
 * 5. SHARED COMPONENTS
 * ========================================================================== */

/** Poster card used by every rail and grid. Whole card is one <a> — the browser
 *  gives us middle-click, open-in-new-tab and keyboard activation for free. */
function createMovieCard(item, fallbackType = 'movie') {
  const d = normalize(item, item.media_type || fallbackType);

  return h('a', { class: 'card', href: `#/${d.type}/${d.id}`, 'aria-label': d.title },
    h('div', { class: 'card__art' },
      img(d.poster, d.title, { className: 'card__poster', fallback: PLACEHOLDER.poster }),
      d.rating && h('span', { class: 'card__score', text: `★ ${d.rating}` }),
    ),
    h('div', { class: 'card__body' },
      h('h3', { class: 'card__title', text: d.title }),
      h('div', { class: 'card__meta' },
        d.year && h('span', { text: d.year }),
        h('span', { class: 'card__type', text: d.type === 'tv' ? 'TV' : 'Film' }),
      ),
    ),
  );
}

/** Horizontal scroller of cards. */
function rail(title, items, fallbackType, moreHref) {
  if (!items || items.length === 0) return null;
  return h('section', { class: 'section' },
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: title }),
      moreHref && h('a', { class: 'section__more', href: moreHref, text: 'See all' }),
    ),
    h('div', { class: 'rail' }, items.map((i) => createMovieCard(i, fallbackType))),
  );
}

/** Responsive grid of cards. */
function grid(items, fallbackType) {
  return h('div', { class: 'grid' }, items.map((i) => createMovieCard(i, fallbackType)));
}

/** A labelled fact in the detail sidebar / fact strip. */
const fact = (label, value) =>
  value ? h('div', { class: 'fact' },
    h('dt', { class: 'fact__label', text: label }),
    h('dd', { class: 'fact__value', text: value }),
  ) : null;

/** Circular percentage score — the standard TMDB reading of vote_average. */
function scoreRing(voteAverage, voteCount) {
  const pct = Math.round((voteAverage || 0) * 10);
  const tone = pct >= 70 ? 'good' : pct >= 40 ? 'ok' : 'bad';
  return h('div', { class: 'score' },
    h('div', {
      class: `score__ring score__ring--${tone}`,
      style: `--pct:${pct}`,
      role: 'img',
      'aria-label': `Rated ${pct} percent`,
    }, h('span', { class: 'score__pct', text: pct ? `${pct}%` : 'NR' })),
    h('div', { class: 'score__meta' },
      h('strong', { text: 'User score' }),
      voteCount ? h('span', { text: `${voteCount.toLocaleString()} votes` }) : null,
    ),
  );
}

/** Cast rail. TMDB calls them credits; this is the "staff" section. */
function castSection(credits, heading = 'Top billed cast') {
  const cast = (credits && credits.cast) || [];
  if (cast.length === 0) return null;

  return h('section', { class: 'section' },
    h('h2', { class: 'section__title', text: heading }),
    h('div', { class: 'rail rail--people' },
      cast.slice(0, 20).map((p) =>
        h('article', { class: 'person' },
          img(p.profile_path ? IMG.profile + p.profile_path : PLACEHOLDER.profile, p.name,
              { className: 'person__photo', fallback: PLACEHOLDER.profile }),
          h('h3', { class: 'person__name', text: p.name }),
          h('p', { class: 'person__role', text: p.character || p.roles?.[0]?.character || '' }),
        )
      ),
    ),
  );
}

/** Key crew, pulled out of the credits blob: directors, writers, creators. */
function crewStrip(credits, creators = []) {
  const crew = (credits && credits.crew) || [];
  const pick = (jobs) => crew.filter((c) => jobs.includes(c.job)).map((c) => c.name);

  const groups = [
    ['Created by', creators.map((c) => c.name)],
    ['Director', pick(['Director'])],
    ['Writer', pick(['Screenplay', 'Writer', 'Story'])],
    ['Composer', pick(['Original Music Composer'])],
  ].filter(([, names]) => names.length > 0);

  if (groups.length === 0) return null;

  return h('dl', { class: 'crew' },
    groups.map(([label, names]) =>
      // Dedupe: TMDB lists the same person once per credited job.
      fact(label, [...new Set(names)].slice(0, 3).join(', '))
    ),
  );
}

/** Pill row of genres. */
const genreRow = (genres) =>
  genres && genres.length
    ? h('div', { class: 'pills' }, genres.map((g) => h('span', { class: 'pill', text: g.name })))
    : null;

/* --- Player -------------------------------------------------------------- */

/**
 * Build the provider URL (path-style — the query-string form is not supported
 * by vidsrc.to and silently yields a dead player).
 */
function buildEmbedUrl({ type, tmdbId, season, episode, subFile, subLabel }) {
  const id = encodeURIComponent(tmdbId);
  let url;

  if (type === 'movie') {
    url = `${vidsrcBase()}/movie/${id}`;
  } else {
    url = `${vidsrcBase()}/tv/${id}`;
    // Appended only when known, so an unresolved show opens the series page
    // rather than emitting a broken ".../tv/158876//".
    if (season != null && season !== '') {
      url += `/${encodeURIComponent(season)}`;
      if (episode != null && episode !== '') url += `/${encodeURIComponent(episode)}`;
    }
  }

  if (subFile) {
    const qs = new URLSearchParams({ sub_file: subFile });
    if (subLabel) qs.set('sub_label', subLabel);
    url += `?${qs.toString()}`;
  }
  return url;
}

/**
 * The player block: a poster-backed "click to play" cover that only mounts the
 * provider iframe on demand. Deliberate — mounting it eagerly loads the
 * provider's ad stack on every page view and costs bandwidth on mobile.
 */
/**
 * Sandbox tokens granted to the provider iframe.
 *
 * The ENTIRE anti-ad mechanism is what is NOT in this list:
 *
 *   allow-popups                  omitted → window.open() is a no-op, so the
 *                                 "click anywhere, get a new tab" ads die.
 *   allow-popups-to-escape-sandbox omitted → any popup it does manage stays
 *                                 sandboxed rather than becoming a free tab.
 *   allow-top-navigation          omitted → the iframe cannot navigate YOUR
 *                                 page. This is the redirect-hijack fix.
 *   allow-top-navigation-by-user-activation omitted → same, but the variant
 *                                 that fires on any click inside the frame.
 *   allow-modals                  omitted → no alert()/confirm() spam.
 *   allow-downloads               omitted → no drive-by file prompts.
 *
 * allow-scripts + allow-same-origin together are normally a sandbox escape,
 * but only when the framed document is same-origin with the embedder. This one
 * is cross-origin, so it cannot reach out and strip its own sandbox attribute.
 * Both are required for the player to run at all.
 */
const PLAYER_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation';

/** Feature permissions handed to the frame. Everything else is denied. */
const PLAYER_ALLOW = 'autoplay; fullscreen; encrypted-media; picture-in-picture';

// Some providers detect a sandbox and refuse to play. Remembered per browser so
// a viewer who needs the relaxed mode is not asked to re-pick it every page.
const STRICT_KEY = 'lumiere.player.strict';
const strictMode = () => {
  try { return localStorage.getItem(STRICT_KEY) !== 'off'; } catch { return true; }
};
const setStrictMode = (on) => {
  try { localStorage.setItem(STRICT_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
};

/**
 * The player block: a poster-backed "click to play" cover that only mounts the
 * provider iframe on demand. Deliberate — mounting it eagerly loads the
 * provider's ad stack on every page view and costs bandwidth on mobile.
 */
function playerBlock({ type, id, season, episode, backdrop, label }) {
  const mount = h('div', { class: 'player', id: 'player' });

  const start = () => {
    state.player = { type, id, season, episode };

    const attrs = {
      class: 'player__frame',
      src: buildEmbedUrl({ type, tmdbId: id, season, episode }),
      allowfullscreen: true,
      allow: PLAYER_ALLOW,
      // no-referrer also cuts the "which site is embedding us" signal some
      // providers use to decide how aggressive the ad stack should be.
      referrerpolicy: 'no-referrer',
      title: label || 'Video player',
    };
    if (strictMode()) attrs.sandbox = PLAYER_SANDBOX;

    mount.replaceChildren(h('iframe', attrs));
  };

  mount.replaceChildren(
    h('button', { class: 'player__cover', type: 'button', onClick: start, 'aria-label': `Play ${label || ''}` },
      img(backdrop, '', { className: 'player__art', fallback: PLACEHOLDER.backdrop, eager: true }),
      // Triangle is drawn in CSS: createElement() can't make real SVG nodes
      // (wrong namespace), and this needs no markup anyway.
      h('span', { class: 'player__play', 'aria-hidden': 'true' }),
      h('span', { class: 'player__hint', text: 'Play' }),
    ),
  );

  // Rebuilt on every render, so a stale iframe can never outlive its page.
  return mount;
}

/**
 * Controls under the player: mirror picker + the sandbox escape hatch.
 * Both exist because iframe failures are silent cross-origin — the page cannot
 * detect a dead provider, so the viewer needs a manual lever.
 */
function playerControls(rerender) {
  const strict = strictMode();

  const mirror = h('select', {
    class: 'select',
    'aria-label': 'Video source',
    onChange: (e) => { vidsrcHostIndex = Number(e.target.value); rerender(); },
  }, VIDSRC_HOSTS.map((host, i) =>
    h('option', { value: i, selected: i === vidsrcHostIndex, text: host.replace('https://', '').replace('/embed', '') })
  ));

  return h('div', { class: 'playerbar' },
    h('div', { class: 'playerbar__group' },
      h('span', { class: 'playerbar__label', text: 'Source' }),
      mirror,
    ),
    h('div', { class: 'playerbar__group' },
      h('button', {
        class: `chip ${strict ? 'chip--on' : ''}`,
        type: 'button',
        title: 'Blocks pop-ups and page redirects from the video provider. Turn off only if a video refuses to load.',
        onClick: () => { setStrictMode(!strict); rerender(); },
      }, strict ? '🛡  Pop-up blocking: ON' : '⚠  Pop-up blocking: OFF'),
      h('span', { class: 'playerbar__hint',
        text: strict ? 'Video not loading? Try another source, then disable this.' : 'Provider may open ads in new tabs.' }),
    ),
  );
}

/* --- Page chrome --------------------------------------------------------- */

/** Full-bleed backdrop with scrim, used as the header of every detail page. */
function detailHero(d, children) {
  return h('header', { class: 'detail' },
    img(d.backdrop, '', { className: 'detail__backdrop', fallback: PLACEHOLDER.backdrop, eager: true }),
    h('div', { class: 'detail__scrim' }),
    h('div', { class: 'detail__inner' }, children),
  );
}

const breadcrumb = (crumbs) =>
  h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    crumbs.map(([label, href], i) => [
      i > 0 ? h('span', { class: 'crumbs__sep', text: '›', 'aria-hidden': 'true' }) : null,
      href ? h('a', { href, text: label }) : h('span', { 'aria-current': 'page', text: label }),
    ]),
  );

const loading = (label = 'Loading…') =>
  h('div', { class: 'state state--loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);

const errorState = (message, retry) =>
  h('div', { class: 'state state--error' },
    h('p', { text: message }),
    retry && h('button', { class: 'btn btn--ghost', type: 'button', text: 'Try again', onClick: retry }),
  );

/* ============================================================================
 * 6. VIEWS
 * ========================================================================== */

/** #/ — trending rails. */
async function viewHome(mount) {
  mount.replaceChildren(loading('Loading trending titles…'));

  // allSettled: one dead rail must not blank the others.
  const [movies, tv, top] = await Promise.allSettled([
    fetchData('/trending/movie/week'),
    fetchData('/trending/tv/week'),
    fetchData('/movie/top_rated'),
  ]);

  const movieList = movies.status === 'fulfilled' ? movies.value.results || [] : [];
  const tvList = tv.status === 'fulfilled' ? tv.value.results || [] : [];
  const topList = top.status === 'fulfilled' ? top.value.results || [] : [];

  if (movieList.length === 0 && tvList.length === 0) {
    mount.replaceChildren(errorState('Could not reach TMDB. Check your connection.', () => route()));
    return;
  }

  const featured = movieList[0] ? normalize(movieList[0], 'movie') : null;

  mount.replaceChildren(
    featured &&
      h('section', { class: 'hero' },
        img(featured.backdrop, '', { className: 'hero__backdrop', fallback: PLACEHOLDER.backdrop, eager: true }),
        h('div', { class: 'hero__scrim' }),
        h('div', { class: 'hero__content' },
          h('p', { class: 'hero__eyebrow', text: 'Trending now' }),
          h('h1', { class: 'hero__title', text: featured.title }),
          h('div', { class: 'hero__meta' },
            featured.year && h('span', { text: featured.year }),
            featured.rating && h('span', { class: 'hero__score', text: `★ ${featured.rating}` }),
          ),
          h('p', { class: 'hero__overview', text: featured.overview }),
          h('div', { class: 'hero__actions' },
            h('a', { class: 'btn btn--primary', href: `#/movie/${featured.id}`, text: '▶  Watch now' }),
            h('a', { class: 'btn btn--ghost', href: `#/movie/${featured.id}`, text: 'More info' }),
          ),
        ),
      ),
    rail('Trending Movies', movieList, 'movie'),
    rail('Trending TV Shows', tvList, 'tv'),
    rail('Top Rated Movies', topList, 'movie'),
  );

  document.title = 'LUMIÈRE — Movies & TV';
}

/** #/search/{query} */
async function viewSearch(mount, query) {
  const seq = ++state.searchSeq;

  mount.replaceChildren(
    h('section', { class: 'section section--page' },
      h('h1', { class: 'page__title', text: `Results for “${query}”` }),
      loading('Searching…'),
    ),
  );
  document.title = `${query} — LUMIÈRE`;

  try {
    const data = await fetchData('/search/multi', { query, include_adult: 'false', page: 1 });
    if (seq !== state.searchSeq) return;   // a newer search already won

    // /search/multi also returns people — keep only playable media.
    const results = (data.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');

    mount.replaceChildren(
      h('section', { class: 'section section--page' },
        h('h1', { class: 'page__title', text: `Results for “${query}”` }),
        results.length
          ? grid(results)
          : h('p', { class: 'state', text: `No movies or TV shows match “${query}”.` }),
      ),
    );
  } catch (err) {
    if (seq !== state.searchSeq) return;
    console.error('[lumiere] Search failed:', err);
    mount.replaceChildren(errorState('Search failed. Please try again.', () => route()));
  }
}

/** #/movie/{id} — full detail page. */
async function viewMovie(mount, id) {
  mount.replaceChildren(loading());

  let m;
  try {
    m = await getMovie(id);
  } catch (err) {
    console.error('[lumiere] Movie detail failed:', err);
    mount.replaceChildren(errorState(
      err.status === 404 ? 'That movie could not be found.' : 'Could not load this movie.',
      () => route()));
    return;
  }

  const d = normalize(m, 'movie');
  const recs = (m.recommendations && m.recommendations.results) || [];

  // US certification lives several levels deep and is absent for most titles.
  const cert = (m.release_dates?.results || [])
    .find((r) => r.iso_3166_1 === 'US')?.release_dates
    ?.map((r) => r.certification).find(Boolean) || null;

  mount.replaceChildren(
    detailHero(d, [
      breadcrumb([['Home', '#/'], [d.title, null]]),

      h('div', { class: 'detail__grid' },
        img(d.poster, d.title, { className: 'detail__poster', fallback: PLACEHOLDER.poster, eager: true }),

        h('div', { class: 'detail__info' },
          h('h1', { class: 'detail__title', text: d.title },
            d.year && h('span', { class: 'detail__year', text: ` (${d.year})` })),

          m.tagline && h('p', { class: 'detail__tagline', text: m.tagline }),

          h('div', { class: 'detail__facts' },
            cert && h('span', { class: 'cert', text: cert }),
            fullDate(m.release_date) && h('span', { text: fullDate(m.release_date) }),
            runtime(m.runtime) && h('span', { text: runtime(m.runtime) }),
          ),

          genreRow(m.genres),
          scoreRing(m.vote_average, m.vote_count),

          m.overview && h('div', { class: 'detail__overview' },
            h('h2', { class: 'detail__subhead', text: 'Overview' }),
            h('p', { text: m.overview }),
          ),

          crewStrip(m.credits),
        ),
      ),
    ]),

    h('div', { class: 'page' },
      h('section', { class: 'section' },
        h('h2', { class: 'section__title', text: 'Watch' }),
        playerBlock({ type: 'movie', id, backdrop: d.backdrop, label: d.title }),
        playerControls(route),
      ),

      castSection(m.credits),

      h('section', { class: 'section' },
        h('h2', { class: 'section__title', text: 'Details' }),
        h('dl', { class: 'facts' },
          fact('Status', m.status),
          fact('Original title', m.original_title !== m.title ? m.original_title : null),
          fact('Original language', m.original_language ? m.original_language.toUpperCase() : null),
          fact('Budget', money(m.budget)),
          fact('Revenue', money(m.revenue)),
          fact('Production', (m.production_companies || []).map((c) => c.name).slice(0, 3).join(', ')),
        ),
      ),

      rail('More like this', recs, 'movie'),
    ),
  );

  document.title = `${d.title}${d.year ? ` (${d.year})` : ''} — LUMIÈRE`;
}

/** #/tv/{id} — series detail + season list. */
async function viewSeries(mount, id) {
  mount.replaceChildren(loading());

  let s;
  try {
    s = await getSeries(id);
  } catch (err) {
    console.error('[lumiere] Series detail failed:', err);
    mount.replaceChildren(errorState(
      err.status === 404 ? 'That series could not be found.' : 'Could not load this series.',
      () => route()));
    return;
  }

  const d = normalize(s, 'tv');
  const recs = (s.recommendations && s.recommendations.results) || [];

  // Specials (season 0) are hidden unless the show has literally nothing else.
  const allSeasons = s.seasons || [];
  const numbered = allSeasons.filter((x) => x.season_number > 0);
  const seasons = numbered.length ? numbered : allSeasons;

  const cert = (s.content_ratings?.results || []).find((r) => r.iso_3166_1 === 'US')?.rating || null;
  const airRange = [year(s.first_air_date), s.status === 'Ended' ? year(s.last_air_date) : '']
    .filter(Boolean);
  const airLabel = airRange.length === 2 && airRange[0] !== airRange[1]
    ? `${airRange[0]}–${airRange[1]}`
    : airRange[0] || '';

  mount.replaceChildren(
    detailHero(d, [
      breadcrumb([['Home', '#/'], [d.title, null]]),

      h('div', { class: 'detail__grid' },
        img(d.poster, d.title, { className: 'detail__poster', fallback: PLACEHOLDER.poster, eager: true }),

        h('div', { class: 'detail__info' },
          h('h1', { class: 'detail__title', text: d.title },
            airLabel && h('span', { class: 'detail__year', text: ` (${airLabel})` })),

          s.tagline && h('p', { class: 'detail__tagline', text: s.tagline }),

          h('div', { class: 'detail__facts' },
            cert && h('span', { class: 'cert', text: cert }),
            s.status && h('span', { text: s.status }),
            s.number_of_seasons && h('span', {
              text: `${s.number_of_seasons} season${s.number_of_seasons === 1 ? '' : 's'}`,
            }),
            s.number_of_episodes && h('span', { text: `${s.number_of_episodes} episodes` }),
            runtime((s.episode_run_time || [])[0]) && h('span', { text: runtime(s.episode_run_time[0]) }),
          ),

          genreRow(s.genres),
          scoreRing(s.vote_average, s.vote_count),

          s.overview && h('div', { class: 'detail__overview' },
            h('h2', { class: 'detail__subhead', text: 'Overview' }),
            h('p', { text: s.overview }),
          ),

          crewStrip(s.credits, s.created_by),
        ),
      ),
    ]),

    h('div', { class: 'page' },
      // Next-episode shortcut, when TMDB knows one.
      s.next_episode_to_air && h('section', { class: 'section' },
        h('div', { class: 'notice' },
          h('strong', { text: 'Next episode: ' }),
          `S${s.next_episode_to_air.season_number} E${s.next_episode_to_air.episode_number}`,
          s.next_episode_to_air.name ? ` — ${s.next_episode_to_air.name}` : '',
          s.next_episode_to_air.air_date ? ` · ${fullDate(s.next_episode_to_air.air_date)}` : '',
        ),
      ),

      h('section', { class: 'section' },
        h('h2', { class: 'section__title', text: 'Seasons' }),
        h('div', { class: 'seasons' },
          seasons.map((se) =>
            h('a', { class: 'season', href: `#/tv/${id}/season/${se.season_number}` },
              img(se.poster_path ? IMG.poster + se.poster_path : d.poster, se.name,
                  { className: 'season__poster', fallback: PLACEHOLDER.poster }),
              h('div', { class: 'season__body' },
                h('h3', { class: 'season__name', text: se.name || `Season ${se.season_number}` }),
                h('p', { class: 'season__meta',
                  text: [year(se.air_date), `${se.episode_count || 0} episodes`].filter(Boolean).join(' · ') }),
                se.overview && h('p', { class: 'season__overview', text: se.overview }),
              ),
            )
          ),
        ),
      ),

      castSection(s.credits, 'Series cast'),

      h('section', { class: 'section' },
        h('h2', { class: 'section__title', text: 'Details' }),
        h('dl', { class: 'facts' },
          fact('Original name', s.original_name !== s.name ? s.original_name : null),
          fact('First aired', fullDate(s.first_air_date)),
          fact('Last aired', fullDate(s.last_air_date)),
          fact('Type', s.type),
          fact('Networks', (s.networks || []).map((n) => n.name).slice(0, 3).join(', ')),
          fact('Original language', s.original_language ? s.original_language.toUpperCase() : null),
        ),
      ),

      rail('More like this', recs, 'tv'),
    ),
  );

  document.title = `${d.title} — LUMIÈRE`;
}

/** #/tv/{id}/season/{n} — season page with the full episode list. */
async function viewSeason(mount, id, seasonNumber) {
  mount.replaceChildren(loading());

  let series, season;
  try {
    // Series first (needed for title + season nav), then the season itself.
    // Both are 7-day cached, so revisiting a show is instant.
    [series, season] = await Promise.all([getSeries(id), getSeason(id, seasonNumber)]);
  } catch (err) {
    console.error('[lumiere] Season failed:', err);
    mount.replaceChildren(errorState(
      err.status === 404 ? 'That season could not be found.' : 'Could not load this season.',
      () => route()));
    return;
  }

  const d = normalize(series, 'tv');
  const episodes = season.episodes || [];
  const seasons = (series.seasons || []).filter((x) => x.season_number > 0);
  const seasonName = season.name || `Season ${seasonNumber}`;

  // Season switcher: a <select> stays usable at 20+ seasons where tabs do not.
  const switcher = h('select', {
    class: 'select',
    'aria-label': 'Jump to season',
    onChange: (e) => { location.hash = `#/tv/${id}/season/${e.target.value}`; },
  }, seasons.map((se) =>
    h('option', {
      value: se.season_number,
      selected: Number(se.season_number) === Number(seasonNumber),
      text: se.name || `Season ${se.season_number}`,
    })
  ));

  mount.replaceChildren(
    detailHero(d, [
      breadcrumb([['Home', '#/'], [d.title, `#/tv/${id}`], [seasonName, null]]),

      h('div', { class: 'detail__grid' },
        img(season.poster_path ? IMG.poster + season.poster_path : d.poster, seasonName,
            { className: 'detail__poster', fallback: PLACEHOLDER.poster, eager: true }),

        h('div', { class: 'detail__info' },
          h('h1', { class: 'detail__title', text: seasonName }),
          h('p', { class: 'detail__tagline', text: d.title }),

          h('div', { class: 'detail__facts' },
            year(season.air_date) && h('span', { text: year(season.air_date) }),
            h('span', { text: `${episodes.length} episodes` }),
            rating(season.vote_average) && h('span', { text: `★ ${rating(season.vote_average)}` }),
          ),

          season.overview && h('div', { class: 'detail__overview' },
            h('h2', { class: 'detail__subhead', text: 'Overview' }),
            h('p', { text: season.overview }),
          ),

          seasons.length > 1 && h('div', { class: 'switcher' },
            h('span', { class: 'switcher__label', text: 'Season' }), switcher),
        ),
      ),
    ]),

    h('div', { class: 'page' },
      h('section', { class: 'section' },
        h('h2', { class: 'section__title', text: 'Episodes' }),
        episodes.length === 0
          ? h('p', { class: 'state', text: 'No episode data available for this season yet.' })
          : h('ol', { class: 'episodes' },
              episodes.map((ep) =>
                h('li', { class: 'episode' },
                  h('a', {
                    class: 'episode__link',
                    href: `#/tv/${id}/season/${seasonNumber}/episode/${ep.episode_number}`,
                  },
                    h('div', { class: 'episode__still' },
                      img(ep.still_path ? IMG.still + ep.still_path : PLACEHOLDER.still, '',
                          { className: 'episode__img', fallback: PLACEHOLDER.still }),
                      h('span', { class: 'episode__num', text: `E${ep.episode_number}` }),
                    ),
                    h('div', { class: 'episode__body' },
                      h('h3', { class: 'episode__title', text: ep.name || `Episode ${ep.episode_number}` }),
                      h('p', { class: 'episode__meta',
                        text: [fullDate(ep.air_date), runtime(ep.runtime), rating(ep.vote_average) && `★ ${rating(ep.vote_average)}`]
                          .filter(Boolean).join(' · ') }),
                      ep.overview && h('p', { class: 'episode__overview', text: ep.overview }),
                    ),
                  ),
                )
              ),
            ),
      ),

      castSection(season.credits || series.credits, 'Season cast'),
    ),
  );

  document.title = `${d.title} — ${seasonName} — LUMIÈRE`;
}

/** #/tv/{id}/season/{n}/episode/{e} — episode page with the player. */
async function viewEpisode(mount, id, seasonNumber, episodeNumber) {
  mount.replaceChildren(loading());

  let series, season;
  try {
    [series, season] = await Promise.all([getSeries(id), getSeason(id, seasonNumber)]);
  } catch (err) {
    console.error('[lumiere] Episode failed:', err);
    mount.replaceChildren(errorState('Could not load this episode.', () => route()));
    return;
  }

  const d = normalize(series, 'tv');
  const episodes = season.episodes || [];
  const idx = episodes.findIndex((e) => Number(e.episode_number) === Number(episodeNumber));
  const ep = idx >= 0 ? episodes[idx] : null;
  const seasonName = season.name || `Season ${seasonNumber}`;

  // Prev/next stay inside the season; crossing a season boundary would need
  // another fetch, and a dead-end arrow is worse than no arrow.
  const prev = idx > 0 ? episodes[idx - 1] : null;
  const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;
  const epHref = (n) => `#/tv/${id}/season/${seasonNumber}/episode/${n}`;

  const title = ep ? ep.name || `Episode ${episodeNumber}` : `Episode ${episodeNumber}`;
  const still = ep && ep.still_path ? IMG.still + ep.still_path : d.backdrop;

  mount.replaceChildren(
    h('div', { class: 'page page--player' },
      breadcrumb([
        ['Home', '#/'],
        [d.title, `#/tv/${id}`],
        [seasonName, `#/tv/${id}/season/${seasonNumber}`],
        [`Episode ${episodeNumber}`, null],
      ]),

      h('h1', { class: 'page__title', text: title }),
      h('p', { class: 'page__sub',
        text: [`${d.title}`, `S${seasonNumber} · E${episodeNumber}`,
               ep && fullDate(ep.air_date), ep && runtime(ep.runtime)].filter(Boolean).join('  ·  ') }),

      playerBlock({ type: 'tv', id, season: seasonNumber, episode: episodeNumber, backdrop: still, label: title }),
      playerControls(route),

      h('nav', { class: 'epnav' },
        prev
          ? h('a', { class: 'btn btn--ghost', href: epHref(prev.episode_number),
                     text: `‹  E${prev.episode_number}  ${prev.name || ''}`.trim() })
          : h('span', { class: 'btn btn--ghost is-disabled', text: '‹  Start of season' }),
        h('a', { class: 'btn btn--ghost', href: `#/tv/${id}/season/${seasonNumber}`, text: 'All episodes' }),
        next
          ? h('a', { class: 'btn btn--ghost', href: epHref(next.episode_number),
                     text: `E${next.episode_number}  ${next.name || ''}  ›`.trim() })
          : h('span', { class: 'btn btn--ghost is-disabled', text: 'End of season  ›' }),
      ),

      ep && ep.overview && h('section', { class: 'section' },
        h('h2', { class: 'section__title', text: 'Overview' }),
        h('p', { class: 'prose', text: ep.overview }),
      ),

      ep && (ep.guest_stars || []).length > 0 &&
        castSection({ cast: ep.guest_stars }, 'Guest stars'),
    ),
  );

  document.title = `${d.title} S${seasonNumber}E${episodeNumber} — LUMIÈRE`;
}

/* ============================================================================
 * 7. ROUTER
 * ========================================================================== */

/** Parse `location.hash` into a route descriptor. */
function parseRoute() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const parts = raw.split('/').filter(Boolean);

  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'search') return { name: 'search', query: parts.slice(1).join('/') };
  if (parts[0] === 'movie' && parts[1]) return { name: 'movie', id: parts[1] };

  if (parts[0] === 'tv' && parts[1]) {
    if (parts[2] === 'season' && parts[3]) {
      if (parts[4] === 'episode' && parts[5]) {
        return { name: 'episode', id: parts[1], season: parts[3], episode: parts[5] };
      }
      return { name: 'season', id: parts[1], season: parts[3] };
    }
    return { name: 'series', id: parts[1] };
  }
  return { name: 'notfound' };
}

/** Render the current route. */
async function route() {
  const mount = el('#view');
  if (!mount) return;

  const r = parseRoute();
  state.route = r;
  state.player = null;

  // Keep the search box in sync with the URL, including on a fresh page load.
  const search = el('#search-input');
  if (search) search.value = r.name === 'search' ? r.query : '';

  // A new page starts at the top — the browser keeps the old scroll otherwise.
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  try {
    switch (r.name) {
      case 'home':    return await viewHome(mount);
      case 'search':  return r.query ? await viewSearch(mount, r.query) : await viewHome(mount);
      case 'movie':   return await viewMovie(mount, r.id);
      case 'series':  return await viewSeries(mount, r.id);
      case 'season':  return await viewSeason(mount, r.id, r.season);
      case 'episode': return await viewEpisode(mount, r.id, r.season, r.episode);
      default:
        mount.replaceChildren(errorState('Page not found.', () => { location.hash = '#/'; }));
    }
  } catch (err) {
    // Last-resort guard: a view that throws must not leave a blank screen.
    console.error('[lumiere] View crashed:', err);
    mount.replaceChildren(errorState('Something went wrong rendering this page.', () => route()));
  }
}

/* ============================================================================
 * 8. GLOBAL UI
 * ========================================================================== */

function wireChrome() {
  const search = el('#search-input');
  if (search) {
    const go = debounce((value) => {
      const q = value.trim();
      // replaceState, not a hash assignment: typing 8 characters should leave
      // ONE history entry, not eight for the Back button to chew through.
      const target = q ? `#/search/${encodeURIComponent(q)}` : '#/';
      history.replaceState(null, '', target);
      route();
    }, SEARCH_DEBOUNCE_MS);

    search.addEventListener('input', (e) => go(e.target.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = search.value.trim();
        location.hash = q ? `#/search/${encodeURIComponent(q)}` : '#/';
      }
      if (e.key === 'Escape') { search.value = ''; search.blur(); }
    });
  }

  // "/" focuses search, the way every media site behaves.
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      search?.focus();
    }
  });

  // Shrink the header once the page scrolls off the hero.
  const topbar = el('.topbar');
  if (topbar) {
    const onScroll = () => topbar.classList.toggle('is-stuck', window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}

/* ============================================================================
 * 9. BOOTSTRAP
 * ========================================================================== */

function init() {
  wireChrome();
  window.addEventListener('hashchange', route);
  route();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

/**
 * Switch to the next mirror and re-render. Iframes give no reliable
 * cross-origin load signal, so failover cannot be automatic — this is the
 * manual escape hatch: window.__player.nextSource()
 */
function nextSource() {
  vidsrcHostIndex = (vidsrcHostIndex + 1) % VIDSRC_HOSTS.length;
  console.info(`[lumiere] Player source → ${vidsrcBase()}`);
  route();
  return vidsrcBase();
}

if (typeof window !== 'undefined') {
  window.__player = {
    nextSource,
    current: () => vidsrcBase(),
    url: () => (state.player ? buildEmbedUrl({ ...state.player, tmdbId: state.player.id }) : null),
  };
}

export { fetchData, createMovieCard, buildEmbedUrl, nextSource, route, state };
