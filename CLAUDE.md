# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tool for browsing every `popup:*` image stored in a MongoDB Atlas "stage" database, with filtering, a "next available id" lookup, and a raw-document inspector. It's a plain Node/Express backend with a no-build, no-framework HTML/JS/CSS front end (`public/`). It runs in two modes from the same codebase — see "Two run modes" below.

## Commands

```bash
npm install       # install deps (express, express-session, express-rate-limit, mongodb)
npm start         # run the server on :5177 (or $PORT), node server.js
APP_PASSWORD=devpass npm start   # exercise hosted mode locally: login screen, 0.0.0.0 bind, per-session isolation — without deploying to Render
```

There is no lint step, no build step, and no test suite in this repo.

One-click launchers, local mode only (all just run `npm install` if needed, start `node server.js`, and open the browser to `http://127.0.0.1:5177`):
- `Open Popup Image Browser.command` — macOS, opens in a visible Terminal window (use this one when you need to see live server logs).
- `Popup Image Browser.app` — macOS, no visible terminal window. Its `Contents/MacOS/launcher` script explicitly prepends `/usr/local/bin:/opt/homebrew/bin:/opt/local/bin` to `PATH` — GUI-launched apps get a much sparser `PATH` than a Terminal session, so without this `node` isn't found. If this app's icon doesn't refresh after editing `Contents/Resources/AppIcon.icns`, that's a Finder icon-cache issue, not a bundle problem — `touch` the bundle and re-run `lsregister -f`.
- `Popup Image Browser.vbs` / `Open Popup Image Browser (Windows).bat` — Windows equivalents (untested on real Windows; written by hand-verifying VBScript/batch quoting since no Windows environment was available to run them).

Server logs go to stdout when run via `npm start`/`.command`, or to `server.log` next to `server.js` when launched via the hidden launchers.

## Two run modes

The same `server.js` behaves differently depending on whether `APP_PASSWORD` is set, controlled by the single `AUTH_ENABLED` flag at the top of the file:

- **Local mode** (`APP_PASSWORD` unset — the default for anyone running this on their own machine): no login screen, binds to `127.0.0.1` only, behaves exactly like the original single-user tool.
- **Hosted mode** (`APP_PASSWORD` set — used for the Render deployment, see `render.yaml`): a login screen gates the whole app behind a shared team passphrase, the server binds to `0.0.0.0` (required for a cloud host's proxy to reach it), and every MongoDB connection is isolated per browser session (see below) instead of one shared global connection.

**Never decouple the bind address from `AUTH_ENABLED`.** The `HOST` constant is deliberately derived from it (`AUTH_ENABLED ? '0.0.0.0' : '127.0.0.1'`) so it's structurally impossible to widen the bind address without auth also being on.

## Architecture

**`server.js`** — single-file Express app. There is **no shared global `client`/`db`** — each browser session gets its own entry in an in-memory `connections` `Map`, keyed by `express-session` id: `{ client, db, lastUsed }`. A `requireDb` middleware looks up the caller's own entry and 400s with "Not connected yet" if there isn't one; nothing ever falls back to another session's connection. A periodic sweep (`SESSION_SWEEP_INTERVAL_MS`) closes and evicts any session's connection after `SESSION_IDLE_MS` of inactivity. `DB_NAME` is hardcoded to `'sweepStakes'` server-side (not client-configurable) — the connect form only asks for the MongoDB URI.

In hosted mode, a `requireAuth` middleware (checking `req.session.authenticated`, set by `POST /api/login` against `process.env.APP_PASSWORD`) gates every route below except the static frontend files and `/api/login` itself. `POST /api/logout` destroys the session and closes that session's MongoDB connection. In local mode `requireAuth` is a no-op — see "Two run modes".

Routes:
- `GET /api/session` — `{ authEnabled, authenticated }`, polled by the frontend on load to decide whether to show the login screen.
- `POST /api/login` / `POST /api/logout` — passphrase check (rate-limited via `express-rate-limit`) and session teardown. No-ops in local mode.
- `POST /connect` — `{ uri }` only. Opens a fresh `MongoClient` scoped to the caller's session, pings `sweepStakes`, stores it in `connections`, closes that same session's previous client if reconnecting. The URI is never logged, written to disk, or echoed back.
- `GET /api/images` — the main aggregation (see below). Returns `{ results, truncated }`, capped at `RESULT_CAP` (20000).
- `GET /api/next-available-id` — finds the lowest unused `popup:<N>` at/above 10000 (ported from a sibling standalone finder tool's `computeAvailability` function). Powers the "Next Available ID" modal.
- `GET /api/manager/:id` — raw `findOne` by `_id`, plus `resolvedPrizes` (see below). Backs the viewer's "Full document" panel and its prize icons/amounts.
- `GET /api/explain/:id` — diagnoses why a given `_id` isn't showing (floor rule, missing image, duplicate-image collision with another doc) — the engine behind the filter box's "shared with N other popup(s)" hint.
- `GET /api/debug` — collection existence/count sanity check, surfaced automatically when a query returns zero results.

**The `/api/images` aggregation pipeline is the core piece of business logic** — every rule below was reverse-engineered from real documents over the course of development, not designed upfront, so don't assume a rule is obviously "right" without checking history:
1. Only documents whose `_id` matches `^popup:` are considered at all.
2. **Floor rule**: if digits appear immediately after `popup:` (with or without a trailing separator, e.g. both `popup:10514` and `popup:10023-Name` match), that number must be `>= 10000` (`MIN_FLOOR_NUMBER`) or the doc is excluded entirely. IDs with no leading digits (e.g. `popup:BC_Bonanza-Streak...`) are exempt from this rule, not excluded.
3. **`poTier`** (the 1PO/2PO/3PO filter) = `dynamicPrices.length`, clamped to 1–3 else `null`. It is *not* related to any `showFormatter` field (there's an unrelated deeply-nested field with that name — ignore it).
4. **`saleCategory`** (Static/Dynamic filter) = `saleType` mapped through `STATIC_SALE_TYPES` (`po1`/`po1h`/`po2`/`po3`) or `DYNAMIC_SALE_TYPES` (`1`/`2`/`3`); anything else is `null` ("unclassified" — still shown under no filter, but excluded by any active Static/Dynamic toggle).
5. **`popupType`** (General/BT/SC/GC filter) = the raw `type` field (`general`/`boxTokensMultiple`/`coinsMultiple`/`gcMultiple`).
6. **`monitorSalesType`** = `monitor.salesType` (often absent — not every doc's `monitor` sub-object carries it). Searchable via the filter box (OR'd with the existing `_id`/`src` substring match) and shown in the viewer caption as "Sales Type (monitor.salesType)"; `null` when absent, never excludes a doc from the results on its own. `monitor.name` (a separate, older field on some docs) is not surfaced anywhere — it was searched/displayed here previously but was deliberately replaced by `monitor.salesType`, not added alongside it.
7. **Images live in two different places depending on the document's `type`** — some popups put images in `designList[].image.src` (array or single object), others put a single image directly at top-level `image.src`, with no `designList` at all. The pipeline unions both sources (`_topLevelImageItems` concatenated onto `designList`) before unwinding — checking only `designList` was the single biggest bug in this project's history (see `/api/explain`'s `hasTopLevelImage` field, added specifically to diagnose this).
8. **No server-side deduplication** — every `(docId, src)` pair is returned as its own row, even if two different documents (of either image-source shape) reference the exact same `src`. Deduping is a client-side, opt-in toggle (see below), not a server default.

**Prize resolution (`resolveAvailablePrizes` in `server.js`)** — a popup document's `availablePrizesByGroupId` (`{groupKey: [prizeId, ...]}`) cross-references prize ids into three separate catalog documents in the same `managers` collection, each holding a top-level `availablePrizes[]` array of `{id, giftType, iconUrl, ...amount fields}`: `managerAvailablePrizes`, `managerAvailablePrizes:100`, and `managerAvailablePrizesCards:0` (`AVAILABLE_PRIZES_CATALOG_IDS`, in that precedence order — if the same `id` exists in more than one, the earlier-listed catalog wins). A prize's display amount is computed via `GIFT_TYPE_AMOUNT_RULES`, a lookup table keyed by `giftType` giving which field holds the quantity and whether it's cents-denominated (÷100) — this table was built entirely from real worked examples, not a spec, so don't assume an unlisted `giftType` is a bug; it just means "icon only, no amount" (`computePrizeAmount` returns `null`). The function returns one **cluster per tier**, each `{ group, prizes, enpItems }`. Internally, groups are resolved in ascending numeric order (group `"1"` before `"2"`, `"10"`, etc.) since that's what the positional pairing with `dynamicPrices` (see below) depends on — but the final array is reversed before returning, so the **highest**-numbered tier/group displays first in the UI. Catalogs are re-fetched (never cached) on every `/api/manager/:id` call since the team can edit them while the tool is in use.

**ENP placeholder entries** — some `dynamicPrices` array entries are the string `"ENP"` (or `"ENP+1"`, `"ENP+2"`, etc.) instead of a real numeric price, meaning that tier's actual reward isn't resolvable through `availablePrizesByGroupId`/the catalogs at all. `dynamicPrices` lines up **by position** with the sorted groups (`dynamicPrices[0]` is the lowest group, `dynamicPrices[1]` the next, etc. — same ordering `poTier` already relies on). Whenever `typeof dynamicPrices[i] === 'string'`, that tier's cluster gets `enpItems`, each paired with the raw placeholder text. Unlike every other icon in the app, these are **hardcoded** (pointing at the production CDN) rather than resolved from a catalog — there's no reliable catalog-backed source for them, so this is a deliberate stopgap, not an oversight; don't "fix" it by wiring in a giftType lookup without checking with the team first. Most popup types get two items (`ENP_ICON_URLS`: GC then SC), but this is conditioned on the popup's raw `type` (same field `popupType` derives from): `boxTokensMultiple` gets just one (`ENP_TOKENS_ICON_URL`, tokens), and `gcMultiple` gets just one (`ENP_ICON_URLS[0]`, GC only) — both reward a single currency rather than two. This is additive: a tier can have both a resolved catalog prize (icon + amount) and ENP item(s) at the same time.

**`public/`** — single page, two view modes toggled via `state.mode` (`'grid'` | `'viewer'`), no router, no framework:
- `index.html` / `style.css` — `boot()` in `app.js` calls `GET /api/session` on load and shows the login screen only if `authEnabled && !authenticated` (always false in local mode, so the login screen never appears there); otherwise goes straight to the connect screen, then a sticky toolbar (search + 1PO/2PO/3PO + Static/Dynamic + General/BT/SC/GC + "Hide Duplicate Popups" checkbox + "Next Available ID" + "Log Out" when auth is enabled) above either the thumbnail grid or the single-image viewer.
- `app.js` — `state.all` holds every raw row from `/api/images`; `applyFilter()` derives `state.filtered` by: optionally deduping client-side via `dedupeBySrc()` (only when the "Hide Duplicate Popups" checkbox is checked — **unchecked by default**, so duplicates show by default) using "lowest `_id` wins" as the tie-break, then AND-ing the text search (matches `_id`, `src`, or `monitorSalesType` — OR'd together) with whichever filter-button groups are active (multiple buttons within one group are OR'd together). If a search matching `popup:` prefix returns zero results, it debounces a call to `/api/explain/:id` and — deliberately terse — shows *only* a "shared with N other popup(s): ..." line if that's the reason, and stays silent for every other reason (by design, not a bug).
- Grid thumbnails lazy-load via a shared `IntersectionObserver`. The viewer screen fetches the full raw document (`/api/manager/:id`) on every navigation and shows it in a `<pre>`, plus a Copy-to-clipboard button next to the `_id`.
- **`applyFilter()` while in viewer mode never just resets to index 0.** It captures the currently-viewed row *by object reference* before recomputing `state.filtered`, then looks that same reference up in the new array: still present → stay on it, just update `state.index` to its new position (so arrow-key nav stays correct); no longer present → `backToGrid()`. This only works because `state.all`/`dedupeBySrc`/`.filter()` never clone row objects — if you ever change that to return copies, this identity check silently breaks and viewing mode will start jumping to unrelated images again on every filter change. `backToGrid()` always calls `renderGrid()` (not just toggling visibility) for the same reason — the grid's DOM can be stale from before the filter changed.
- The "Next Available ID" button opens a small modal (`#next-id-modal-backdrop`) — closeable via its ✕ button, a backdrop click, or Escape; this is the one place in the app with a modal/overlay pattern.
- The viewer's `.image-with-prizes` wrapper lays `.image-frame` and the resolved-prizes list (`#prizes-row`, `.prizes-column`) side by side, `align-items: stretch` so the column spans the full image height; `.prizes-column` then uses `justify-content: space-between` to spread its `.prize-cluster` elements (one per tier, in whatever order the server already sorted them in — the frontend does no sorting of its own) evenly from top to bottom, approximating each tier's position without needing the design's real pixel coordinates. Inside a cluster, resolved catalog-prize rows (bare icon+amount, no group label in the UI) stack tightly above an optional `.prize-enp-row` (the tier's hardcoded-icon ENP item(s) — one or two depending on popup type, see above — when that tier's `dynamicPrices` entry is a placeholder string). A cluster with nothing to show is omitted entirely so it doesn't throw off the even spacing.

## Non-obvious constraints to preserve

- **Never decouple the bind address from `AUTH_ENABLED`.** Binding to all interfaces is only safe because every route is also gated behind login in that same mode — don't widen `HOST` independently of it.
- **Never go back to a shared global `client`/`db`.** Every route must resolve its database through the caller's own session (`requireDb`/`connections`), never a module-level variable — that's the whole fix for one user's connection leaking into another's requests. If you add a new route that touches MongoDB, route it through `requireDb`, not a fresh global.
- **Never persist the URI** anywhere (disk, `localStorage`, logs) — it lives only in the browser's in-memory form field for the duration of one `/connect` call, and server-side only in that session's in-memory `connections` entry (never written to disk).
- **Never store `APP_PASSWORD`/`SESSION_SECRET` in the repo** — they're set as environment variables/secrets on the hosting platform (see `render.yaml`, which marks `APP_PASSWORD` as `sync: false` deliberately).
- Every MongoDB query that can run on a large collection has an explicit `maxTimeMS` and a client-side `AbortController` timeout (`fetchWithTimeout` in `app.js`) — this app was built against a slow/large real collection, and a past regression here silently made things "look stuck" with no error. Don't remove these without replacing them with something equivalent.
