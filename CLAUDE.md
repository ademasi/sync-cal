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
node --experimental-vm-modules node_modules/jest/bin/jest.js -t "rewrites source UID"
```

There is no automated dev-reload. To run the add-on, load `manifest.json` via Thunderbird → Add-ons → Debug Add-ons → Load Temporary Add-on. Thunderbird 128+ is required, and `extensions.experiments.enabled` must be `true` in Config Editor.

## Architecture

This is a Thunderbird MailExtension (manifest v2) doing **one-way calendar sync** (source → target). It runs across two privilege domains:

- **`background.js`** — the sandboxed extension context. Holds all sync logic but can only touch `browser.*`. It has no direct access to Thunderbird's calendar internals.
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

- **UID rewriting** (`safeCreate` / `safeUpdate`): on create, generate a fresh UID (`crypto.randomUUID()@sync-cal`) so the source's provider-specific ID can't collide in the target. On update, rewrite the source iCal's UID to the *target* item's ID — otherwise the source UID overwrites the target's and remote providers create a duplicate.
- **Duplicate detection** (`findDuplicateInTarget`): matches existing target items by `SUMMARY` + `DTSTART` so a failed/missing mapping links to the existing copy instead of duplicating.
- **Re-entrancy guard** (`isSyncing` counter): the add-on's own writes to the target fire the `onCreated/onUpdated/onRemoved` observers; while `isSyncing > 0` those events are ignored to prevent feedback loops.
- **Serialized queue** (`enqueueSync` / `syncQueue`): every sync operation chains onto a single promise so concurrent triggers can't race.
- **In-memory caches** (`cachedOptions`, `cachedMap`): invalidated by the `storage.onChanged` listener.

The **sync map** (`storage.local.syncMap`) maps source item ID → target item ID and is scoped to a `(sourceCalendarId, targetCalendarId)` pair; changing either calendar discards the map (`mapForOptions`).

The manifest version (`manifest.json`) is the authoritative add-on version and may differ from `package.json`.

## Testing convention (important gotcha)

`background.js` and `options.js` are plain extension scripts, not importable modules. The Jest tests therefore **re-define the functions under test inline** (a copy of the real function) and assert against the copy — they do not import the source. When you change a function like `rewriteUid`, `mapForOptions`, `validateSelections`, etc., you must also update its duplicated copy in `tests/*.test.js` or the test will silently pass against stale logic.
