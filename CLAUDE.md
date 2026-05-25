# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dev deps (eslint, jest)
npm test             # run all Jest tests
npm run lint         # eslint .
npm run lint:fix     # eslint --fix
npm run build        # zip into sync-cal.xpi (excludes *.sys.mjs)
```

Run a single test file or test name:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/background.test.js
node --experimental-vm-modules node_modules/jest/bin/jest.js -t "pushItem idempotency"
```

There is no automated dev-reload. To run the add-on, load `manifest.json` via Thunderbird → Add-ons → Debug Add-ons → Load Temporary Add-on. Betterbird or Thunderbird 140+ is required, and `extensions.experiments.enabled` must be `true` in Config Editor.

## Architecture

This is a Thunderbird MailExtension (manifest v2) doing **one-way calendar sync** (source → target). It runs across two privilege domains:

- **`background.js`** — the sandboxed extension context. Holds all sync logic but can only touch `browser.*`. It has no direct access to Thunderbird's calendar internals.
- **`helpers.js`** — pure, side-effect-free helpers (UID/iCal parsing, sync-range math). Loaded as a plain script in `background.html` **before** `background.js`, where it exposes `globalThis.SyncCalHelpers`; it also `module.exports` the same API so Jest can `require()` it directly (see `tests/helpers.test.js`).
- **`experiments/calendar/parent/*.js`** — privileged "parent" scripts (WebExtension Experiment APIs) that run with chrome privileges and implement `browser.calendar.calendars` and `browser.calendar.items` on top of Thunderbird's internal `calUtils` / `cal.manager`. Registered in `manifest.json` under `experiment_apis`. These are adapted from Thunderbird's own calendar WebExtension API proposal and expose far more surface (create/update/move/remove, observers, alarms) than this add-on uses.

The two API surfaces background.js actually relies on: `calendar.calendars.query/get` and `calendar.items.query/get/create/update/remove` plus the `items.onCreated/onUpdated/onRemoved` observers.

### Experiment files are NOT ES modules

`experiments/calendar/ext-calendar-utils.js` is loaded by both parent scripts via `Services.scriptloader.loadSubScript`, so its functions are `var foo = function(){}` at script scope (not `import`/`export`). The `.sys.mjs` sibling is the ESM-export version of the same code, kept as reference only — `npm run build` excludes `*.sys.mjs`, so the `.js` variant is what ships. Keep the two in sync when editing, but the `.js` is authoritative. Editing any experiment script requires a full Thunderbird restart (no live reload).

### Background ↔ Options communication is via storage, not messages

`background.js` registers a `runtime.onMessage` handler, but the options page does **not** use it. Instead `options.js` and `background.js` coordinate through `browser.storage.local` + `storage.onChanged`:

- Options writes timestamped sentinel keys to trigger work: `calendarCacheRefresh`, `manualSyncRequest`, and `options` itself.
- Background does the work and writes results back: `calendarCache` (calendar list for the dropdowns) and `manualSyncStatus`.
- Writing `options` alone triggers an `options_changed` full sync; `syncNow()` writes `options` + `manualSyncRequest` together in one `set()` so only the forced manual sync runs (avoids a double full-sync).

When adding cross-context behavior, follow this storage-key convention rather than adding message types.

### Sync correctness invariants (read before touching sync logic)

These exist because of real failures with CalDAV/Exchange/Google — don't remove them casually:

- **Reliable create** (`adoptItemReliably` in `ext-calendar-items.js`): CalDAV's `adoptItem` promise can hang on TB/BB 140 (the post-PUT multiget can fail to notify the listener), so create resolves from the `onAddItem` observer (matched by the assigned UID) raced against `adoptItem`, with a backstop timer.
- **Idempotent writes** (`pushItem` in `background.js`): the assigned target UID is written into the sync map and persisted (`saveMap`) *before* the create call. A create that times out but actually committed is therefore reconciled as an `update` on the next pass (same UID = idempotent CalDAV PUT) instead of duplicating. Retries reuse the same UID.
- **UID rewriting** (`rewriteUid` in `helpers.js`): on create the source iCal's UID is rewritten to a fresh `crypto.randomUUID()@sync-cal`; on update it's rewritten to the mapped target UID (otherwise the source UID overwrites the target's and remote providers duplicate). The helper unfolds RFC 5545 folded lines and rewrites every component's UID (recurrence master + exceptions).
- **Duplicate linking** (fallback): the sync map is the primary link. When an item has no mapping, `doFullSync` consults an in-memory index of the target (built from a single pre-fetch) keyed by `SUMMARY`+`DTSTART`; `extractEventInfo` scopes to the first `VEVENT`/`VTODO` block so it reads the event start, not a `VTIMEZONE` transition date. `syncOneItem` (single item) uses `findDuplicateInTarget` directly.
- **Echo suppression** via the calendar-ID filter: our writes go to the *target*, and `syncOneItem`/`removeOneItem` ignore events whose `calendarId !== sourceCalendarId`. (There is no `isSyncing` counter anymore.)
- **Bounded sync window**: `doFullSync` only queries the source within `[now - syncPastDays, now + syncFutureDays]` (defaults 30 / 0=unbounded-future), which also limits CalDAV write volume. Orphan removal is window-aware: a mapped source item missing from the window is probed via `items.get`; if it still exists it aged out (target copy kept), only a genuine source deletion removes the target copy.
- **Write pacing**: CalDAV targets get a small delay between writes during a full sync to stay under provider rate limits.
- **Serialized queue** (`enqueueSync` / `syncQueue`): every sync operation chains onto a single promise so concurrent triggers can't race.
- **In-memory caches** (`cachedOptions`, `cachedMap`): invalidated by the `storage.onChanged` listener.

The **sync map** (`storage.local.syncMap`) maps source item ID → target item UID and is scoped to a `(sourceCalendarId, targetCalendarId)` pair; changing either calendar discards the map (`mapForOptions`).

The manifest version (`manifest.json`) is the authoritative add-on version and may differ from `package.json`.

## Testing convention (important gotcha)

There are two patterns in `tests/`:

- **Pure logic lives in `helpers.js`** and is tested **directly** via `tests/helpers.test.js` (`require("../helpers")`) — no copying. `rewriteUid`, `extractEventInfo`, `extractUid`, `unfoldIcal`, `toIcalUtc`, and `computeSyncRange` are authoritatively tested there.
- **Integration logic** that's entangled with `browser.*` or DOM still uses the **inline-copy pattern**: `background.js` and `options.js` are plain extension scripts, not importable modules, so the Jest tests **re-define the function under test inline** (a copy of the real function) and assert against the copy. This applies to `pushItem` (`tests/background.test.js`), `validateSelections` and `mapForOptions` (`tests/options.test.js` / `tests/background.test.js`). When you change one of these, you must update its duplicated copy in `tests/*.test.js` or the test will silently pass against stale logic.

Prefer extracting new pure logic into `helpers.js` (tested directly) rather than adding new inline copies.
