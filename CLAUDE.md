# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, single-user tool for browsing every `popup:*` image stored in a MongoDB Atlas "stage" database, with filtering, a "next available id" lookup, and a raw-document inspector. It's a plain Node/Express backend with a no-build, no-framework HTML/JS/CSS front end (`public/`). Everything runs on `127.0.0.1` only.

## Commands

```bash
npm install       # install deps (express, mongodb)
npm start         # run the server on :5177 (or $PORT), node server.js
```

There is no lint step, no build step, and no test suite in this repo.

One-click launchers (all just run `npm install` if needed, start `node server.js`, and open the browser to `http://127.0.0.1:5177`):
- `Open Popup Image Browser.command` — macOS, opens in a visible Terminal window (use this one when you need to see live server logs).
- `Popup Image Browser.app` — macOS, no visible terminal window. Its `Contents/MacOS/launcher` script explicitly prepends `/usr/local/bin:/opt/homebrew/bin:/opt/local/bin` to `PATH` — GUI-launched apps get a much sparser `PATH` than a Terminal session, so without this `node` isn't found. If this app's icon doesn't refresh after editing `Contents/Resources/AppIcon.icns`, that's a Finder icon-cache issue, not a bundle problem — `touch` the bundle and re-run `lsregister -f`.
- `Popup Image Browser.vbs` / `Open Popup Image Browser (Windows).bat` — Windows equivalents (untested on real Windows; written by hand-verifying VBScript/batch quoting since no Windows environment was available to run them).

Server logs go to stdout when run via `npm start`/`.command`, or to `server.log` next to `server.js` when launched via the hidden launchers.

## Architecture

**`server.js`** — single-file Express app. Holds a **module-level `client`/`db`** (not per-session, not pooled) — one browser tab's `/connect` call replaces the connection for the whole process. `DB_NAME` is hardcoded to `'sweepStakes'` server-side (not client-configurable) — the connect form only asks for the MongoDB URI. All routes 400 with "Not connected yet" until `/connect` succeeds.

Routes:
- `POST /connect` — `{ uri }` only. Opens a fresh `MongoClient`, pings `sweepStakes`, swaps it in, closes the previous client. The URI is never logged, written to disk, or echoed back.
- `GET /api/images` — the main aggregation (see below). Returns `{ results, truncated }`, capped at `RESULT_CAP` (20000).
- `GET /api/next-available-id` — finds the lowest unused `popup:<N>` at/above 10000 (ported from a sibling standalone finder tool's `computeAvailability` function). Powers the "Next Available ID" modal.
- `GET /api/manager/:id` — raw `findOne` by `_id`, backs the viewer's "Full document" panel.
- `GET /api/explain/:id` — diagnoses why a given `_id` isn't showing (floor rule, missing image, duplicate-image collision with another doc) — the engine behind the filter box's "shared with N other popup(s)" hint.
- `GET /api/debug` — collection existence/count sanity check, surfaced automatically when a query returns zero results.

**The `/api/images` aggregation pipeline is the core piece of business logic** — every rule below was reverse-engineered from real documents over the course of development, not designed upfront, so don't assume a rule is obviously "right" without checking history:
1. Only documents whose `_id` matches `^popup:` are considered at all.
2. **Floor rule**: if digits appear immediately after `popup:` (with or without a trailing separator, e.g. both `popup:10514` and `popup:10023-Name` match), that number must be `>= 10000` (`MIN_FLOOR_NUMBER`) or the doc is excluded entirely. IDs with no leading digits (e.g. `popup:BC_Bonanza-Streak...`) are exempt from this rule, not excluded.
3. **`poTier`** (the 1PO/2PO/3PO filter) = `dynamicPrices.length`, clamped to 1–3 else `null`. It is *not* related to any `showFormatter` field (there's an unrelated deeply-nested field with that name — ignore it).
4. **`saleCategory`** (Static/Dynamic filter) = `saleType` mapped through `STATIC_SALE_TYPES` (`po1`/`po1h`/`po2`/`po3`) or `DYNAMIC_SALE_TYPES` (`1`/`2`/`3`); anything else is `null` ("unclassified" — still shown under no filter, but excluded by any active Static/Dynamic toggle).
5. **`popupType`** (General/BT/SC/GC filter) = the raw `type` field (`general`/`boxTokensMultiple`/`coinsMultiple`/`gcMultiple`).
6. **Images live in two different places depending on the document's `type`** — some popups put images in `designList[].image.src` (array or single object), others put a single image directly at top-level `image.src`, with no `designList` at all. The pipeline unions both sources (`_topLevelImageItems` concatenated onto `designList`) before unwinding — checking only `designList` was the single biggest bug in this project's history (see `/api/explain`'s `hasTopLevelImage` field, added specifically to diagnose this).
7. **No server-side deduplication** — every `(docId, src)` pair is returned as its own row, even if two different documents (of either image-source shape) reference the exact same `src`. Deduping is a client-side, opt-in toggle (see below), not a server default.

**`public/`** — single page, two view modes toggled via `state.mode` (`'grid'` | `'viewer'`), no router, no framework:
- `index.html` / `style.css` — connect screen, then a sticky toolbar (search + 1PO/2PO/3PO + Static/Dynamic + General/BT/SC/GC + "Hide Duplicate Popups" checkbox + "Next Available ID") above either the thumbnail grid or the single-image viewer.
- `app.js` — `state.all` holds every raw row from `/api/images`; `applyFilter()` derives `state.filtered` by: optionally deduping client-side via `dedupeBySrc()` (only when the "Hide Duplicate Popups" checkbox is checked — **unchecked by default**, so duplicates show by default) using "lowest `_id` wins" as the tie-break, then AND-ing the text search with whichever filter-button groups are active (multiple buttons within one group are OR'd together). If a search matching `popup:` prefix returns zero results, it debounces a call to `/api/explain/:id` and — deliberately terse — shows *only* a "shared with N other popup(s): ..." line if that's the reason, and stays silent for every other reason (by design, not a bug).
- Grid thumbnails lazy-load via a shared `IntersectionObserver`. The viewer screen fetches the full raw document (`/api/manager/:id`) on every navigation and shows it in a `<pre>`, plus a Copy-to-clipboard button next to the `_id`.
- The "Next Available ID" button opens a small modal (`#next-id-modal-backdrop`) — closeable via its ✕ button, a backdrop click, or Escape; this is the one place in the app with a modal/overlay pattern.

## Non-obvious constraints to preserve

- **Never widen the server bind address** beyond `127.0.0.1` — it accepts a raw MongoDB URI over HTTP with no auth of its own.
- **Never persist the URI** anywhere (disk, `localStorage`, logs) — it lives only in the browser's in-memory form field for the duration of one `/connect` call.
- Every MongoDB query that can run on a large collection has an explicit `maxTimeMS` and a client-side `AbortController` timeout (`fetchWithTimeout` in `app.js`) — this app was built against a slow/large real collection, and a past regression here silently made things "look stuck" with no error. Don't remove these without replacing them with something equivalent.
