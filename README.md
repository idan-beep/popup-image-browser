# Popup Image Browser

A tool for browsing every `popup:*` image stored in a MongoDB collection, with filtering, a "next available id" lookup, and a raw-document inspector.

It's a plain Node/Express backend with a no-build, no-framework HTML/JS/CSS front end. It runs in two modes from the same code: **locally on your own machine** (the default — binds to `127.0.0.1` only, no login) or **hosted for a small team** behind a shared passphrase, with each logged-in person getting their own isolated database connection (see [Hosting](#hosting-for-a-team) below).

## Why

MongoDB documents in the `managers` collection store promotional popup configurations, each with one or more images. This tool gives you a fast visual way to browse, filter, and cross-check those images and their metadata without writing ad-hoc queries in Compass every time.

## Getting started

```bash
npm install
npm start
```

Then open `http://127.0.0.1:5177` and paste in your MongoDB connection URI. The URI is used only to open a connection for that session — it is **never** written to disk, logged, or persisted anywhere. Reloading the page clears it.

### One-click launchers

- **macOS, visible logs**: double-click `Open Popup Image Browser.command` — opens a Terminal window so you can see live server logs (useful for debugging).
- **macOS, no terminal window**: double-click `Popup Image Browser.app` — starts the server in the background and opens your browser, with no visible console window.
- **Windows**: `Open Popup Image Browser (Windows).bat` (visible console) or `Popup Image Browser.vbs` (hidden, double-click, no console window). The Windows launchers are untested on a real Windows machine — please report any issues.

All launchers install dependencies automatically on first run if `node_modules` is missing.

## Features

- **Grid and single-image views** — browse thumbnails in a responsive grid, or click one to see it full-size with its full raw MongoDB document, a copy-to-clipboard button for its `_id`, and arrow-key navigation between images.
- **Filters** — free-text search by id or filename, plus toggle-button filters for PO tier (1PO/2PO/3PO, derived from a `dynamicPrices` array length), sale category (Static/Dynamic), and popup type (General/BT/SC/GC). All filters combine with AND across groups, OR within a group.
- **Hide Duplicate Popups** — an opt-in checkbox to collapse entries that reference the exact same image file across different documents.
- **Next Available ID** — finds the lowest unused `popup:<N>` id (starting at 10000) so you know what to assign to a new popup.
- **Diagnostics** — if a search for a specific id comes up empty, the tool automatically checks whether that id is being hidden because it shares its image with another popup, and tells you which one.

## Requirements

- Node.js 18+
- A MongoDB connection string with read access to the target database

## Hosting for a team

The same server can run as a real hosted web app instead of a local-only tool. Two things change automatically the moment an `APP_PASSWORD` environment variable is set:

1. A login screen gates the entire app behind that shared passphrase.
2. Each logged-in browser session gets its **own isolated MongoDB connection** — one teammate connecting to database A can never see database B's data through another teammate's session, even if both are using the app at the same time. Sessions (and their connections) are automatically cleaned up after ~45 minutes of inactivity.

Nobody's database credentials are ever stored on the server — each person still pastes their own MongoDB URI after logging in, exactly like the local version, just now scoped safely to their own session instead of a shared global connection.

### Deploying to Render

`render.yaml` in this repo is a ready-to-use [Render](https://render.com) Blueprint:

1. In the Render dashboard, create a new **Blueprint** and point it at this repo.
2. Render will detect `render.yaml` and provision a free web service automatically. `SESSION_SECRET` is auto-generated; you'll be prompted to enter `APP_PASSWORD` yourself (it's marked `sync: false` deliberately, so it's never written into the repo or Render's blueprint file).
3. Once deployed, share the Render URL and the passphrase with your team.

The free tier spins the service down after inactivity (a ~30–60s cold start on the next request after idling); upgrade the plan in the Render dashboard if you want it always warm.

## Architecture

See [CLAUDE.md](CLAUDE.md) for a detailed breakdown of the server's aggregation pipeline, the data model quirks it accounts for, and the non-obvious constraints worth preserving if you modify it.
