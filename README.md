# LUMIÈRE

A movie and TV streaming front-end built on the [TMDB](https://www.themoviedb.org/) API.
No framework, no build step — three files of vanilla ES modules.

## Features

- **Hash-routed pages** — every view is deep-linkable and survives a refresh
- **Movie pages** — cast, crew, genres, runtime, certification, budget/revenue, user score, recommendations
- **Series pages** — creators, networks, air range, per-season grid, next-episode notice
- **Season pages** — full episode list with stills, air dates, runtimes and per-episode ratings
- **Episode pages** — player, prev/next navigation, guest stars
- **Search** — 500 ms debounce, out-of-order response guard
- **Persistent cache layer** — TTL'd localStorage with LRU eviction (see below)
- **Responsive** — fluid layout from 320 px to ultrawide, plus reduced-motion and print styles

## Routes

| Route | Page |
| --- | --- |
| `#/` | Home — hero and trending rails |
| `#/search/{query}` | Search results |
| `#/movie/{id}` | Movie detail + player |
| `#/tv/{id}` | Series detail + season list |
| `#/tv/{id}/season/{n}` | Season detail + episode list |
| `#/tv/{id}/season/{n}/episode/{e}` | Episode detail + player |

## Files

| File | Role |
| --- | --- |
| `index.html` | Static shell — header, `#view` mount, footer |
| `app.js` | Router, views, components, TMDB data layer |
| `cache.js` | Cache-aware `fetch` wrapper — TTL, LRU eviction, request dedupe |
| `styles.css` | Everything visual |

## Running it

Any static server. ES modules will not load from `file://`, so open it over HTTP:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

## The cache layer

`cachedFetch(url, options, ttlInMinutes)` is a drop-in for `fetch` — it returns a real
`Response`, so `res.ok` and `res.json()` behave normally. Cache hits carry an `x-cache: HIT` header.

Default TTLs by content type:

| Content | TTL |
| --- | --- |
| Trending, popular, top rated, discover | 12 hours |
| Search results | 1 hour |
| Movie / series / season details | 7 days |
| Anything else | 1 hour |

It also deduplicates in-flight requests (five simultaneous calls for the same URL cost one
round trip), strips credential params from cache keys, never caches error responses, and
evicts least-recently-used entries when `localStorage` fills up. If `localStorage` is
unavailable — private browsing, disabled site data — it falls back to an in-memory store
and the app behaves identically.

Debug helpers, available in the browser console:

```js
window.__cache.stats()          // backend, entry count, bytes, expired count
window.__cache.clear()          // wipe everything
window.__cache.invalidate('/search/')

window.__player.url()           // the embed URL currently loaded
window.__player.nextSource()    // rotate to the next provider mirror
```

## API credentials

The TMDB token in `app.js` carries the `api_read` scope only — it cannot write anything, and
like every credential in a client-side app it is visible to anyone who loads the page. It is
not a secret. If you fork this, swap in your own token from
[TMDB API settings](https://www.themoviedb.org/settings/api).

Anything write-capable would need a server-side proxy; do not put such a key here.

## Playback

Video is served by third-party embed providers (`vidsrc.to` and mirrors). This project hosts
no media and has no affiliation with those services.

The player iframe is sandboxed, and the protection lies in the tokens deliberately *not*
granted. Three modes sit under every player:

| Mode | Withholds | Result |
| --- | --- | --- |
| Strict | popups, top-navigation, modals, downloads | Maximum protection. `vidsrc.to` refuses to load under it. |
| Balanced (default) | top-navigation, popup-escape | Provider **cannot redirect your page**. Pop-up tabs may still open, but inherit the sandbox. |
| Off | nothing | No protection. Last resort. |

`vidsrc.to` detects a full sandbox and bails with "This content can't be embedded in a
sandboxed frame" — its probe appears to be `window.open()` returning `null`, which only
happens when `allow-popups` is withheld. Balanced grants that one token so the check passes,
while still withholding `allow-top-navigation`, which is what actually stops the page hijack.

Ads *inside* the frame cannot be removed. It is a cross-origin document — no script on this
page can read or modify a single node inside it. That is the same-origin policy, not a
missing feature.

Two controls sit under every player:

- **Source** — switch provider mirror
- **Pop-up blocking** — toggles the sandbox, remembered per browser

Some providers detect a sandbox and refuse to play. If a video stays black, change source
first; disable the shield only as a last resort. Cross-origin iframes report nothing to the
parent page, so a dead player cannot be detected automatically — hence the manual levers.

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
