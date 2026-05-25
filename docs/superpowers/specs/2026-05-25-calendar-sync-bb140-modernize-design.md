# Calendar Sync Bridge — Betterbird 140 Modernize & Harden

- **Date:** 2026-05-25
- **Status:** Approved (design) — pending implementation plan
- **Scope decision:** Modernize + harden (keep the proven architecture; do not rewrite from scratch)
- **Branch:** `bb140-modernize-harden`

## 1. Problem

The add-on worked on Thunderbird 128 but stopped working after the user moved to
**Betterbird 140.11.0esr-bb23** (built on the Thunderbird 140 ESR codebase). The
add-on is still installed and the experiment `browser.calendar.*` API still loads,
but sync fails in practice.

Environment (confirmed from the profile at `~/.thunderbird/fk352yb7.default-release`):

| Calendar | Type | Role |
| --- | --- | --- |
| **UNIGE** | `storage` (local, populated by TbSync/Exchange-EAS) | **source** |
| **Gmail** | `caldav` (Google) | **target** (writable) |

Observed symptom (Error Console): repeated
`[sync-cal] Create failed … Error: Create timed out for …` from `withTimeout`
(`background.js:87`), interleaved with duplicate-detection logging that prints
nonsensical dates (`18531231`, `18831118`, `18950201`).

## 2. Root cause

Two layers compound into the failure:

### 2.1 The create hang (why it stopped working)

A create into Google CalDAV performs a `PUT`, then a **follow-up multiget
`REPORT`** to read the item back (`CalDavCalendar.adoptItem` → `doAdoptItem` →
`getUpdatedItem` → `CalDavMultigetSyncHandler`). The `adoptItem` promise only
resolves when that second request notifies the operation listener. On BB/TB 140,
when the follow-up request fails at the channel level (Google OAuth/throttling
during rapid bulk writes), the failure path does **not** notify the listener — the
promise is orphaned and **never resolves or rejects**. The `PUT` already
committed, so the event appears in Google Calendar, but our code waits the full
30 s and declares failure.

This is consistent with every observed fact: items show up in the target (PUT
succeeded), yet every create "times out," and re-runs then *find* those items as
duplicates.

### 2.2 Amplifiers and downstream bugs (why it becomes chaos)

- **No date window.** `doFullSync` queries the source with no `rangeStart`/
  `rangeEnd`, so it writes the **entire history** of UNIGE to Google in a tight
  loop → maximises throttling → maximises hangs.
- **No idempotency on timeout.** When a create times out, the source→target
  mapping is never saved, so the next sync recreates the (already committed) item
  → duplicates accumulate (`background.js` `doFullSync`/`syncOneItem`).
- **Broken duplicate detection.** `extractEventInfo`'s `/^DTSTART…/m` matches the
  first `DTSTART` in the serialized iCal, which lives in the **VTIMEZONE** block
  (historical transition dates like 1853/1883), not the `VEVENT`. So the safety
  net keys off the timezone, not the event.
- **Fragile UID rewriting.** `rewriteUid` does not unfold RFC 5545 folded lines
  (Exchange UIDs are routinely >75 chars → folded), and replaces only the *first*
  `UID:` (recurring events with `RECURRENCE-ID` exceptions then fail with
  "Exception does not relate to parent item").
- **Echo guard drops real edits.** The `isSyncing` counter is held for the whole
  full sync; source edits arriving during that window are silently dropped (never
  queued). Echo suppression is also unreliable for async CalDAV (the `finally`
  decrements before the observer fires) — and is redundant with the existing
  `calendarId !== sourceCalendarId` filter.
- **False "success."** `manualSyncForUi` returns `{ok:true}` even when individual
  items failed; the UI shows "Sync complete."

## 3. Goals / Non-goals

**Goals**

1. Sync reliably on Betterbird/Thunderbird 140 against Google CalDAV.
2. Stop creating duplicates; make create idempotent and recoverable.
3. Only sync a bounded, user-configurable date window (default: past 1 month +
   all future).
4. Correctly handle Exchange-EAS source items (long UIDs, recurring events with
   exceptions).
5. Report partial failures honestly in the UI.
6. Reduce maintenance/breakage surface (trim dead experiment API; update version
   metadata).

**Non-goals**

- Full rewrite from scratch (explicitly rejected — would discard hard-won EAS/
  CalDAV knowledge).
- Two-way sync (remains one-way: source → target).
- Migrating to a native `browser.calendar` API (none exists in BB/TB 140; the
  experiment approach stays).
- A one-time cleanup of *pre-existing* duplicates already in Gmail (tracked as an
  optional follow-up in §6, not part of this work).

## 4. Design

The architecture is unchanged: sandboxed `background.js` holds sync logic;
privileged experiment scripts implement `browser.calendar.*`; options ↔ background
communicate via `storage.local` + `storage.onChanged`. Changes are targeted.

### 4.1 Reliable create (experiment layer) — `ext-calendar-items.js`

Make `items.create` resolve on the **`onAddItem` observer** rather than trusting
the `adoptItem` promise alone. Before calling `adoptItem`, register a one-shot
`calIObserver` on the calendar; resolve when an added item matches the expected
calendar id **and** UID; also resolve/reject if the `adoptItem` promise itself
settles first; tear down the observer in all paths. Keep the `modifyItem` path for
`#cache` calendars.

Add defensive guards in the create/convert path:

- After resolution, verify the value is a real item
  (`typeof createdItem.isEvent === "function"`); otherwise throw a clear
  `ExtensionError` (turns a silent null into a catchable error).
- In `convertItem`, guard `item.calendar?.superCalendar?.id ?? item.calendar?.id`.

(Module import paths under `resource:///modules/…` are still valid on TB 140 and
are left as-is; the in-progress `moz-src` migration is noted as a future risk, not
changed now.)

### 4.2 Write pacing (background layer)

Serialize writes (already sequential) and add a small pacing delay between CalDAV
writes during `doFullSync` to stay under Google's per-minute quota. Pace only when
the target is a network calendar; local writes need no delay. Exact delay tuned in
the plan (order of ~150–250 ms).

### 4.3 Sync window — bounded, configurable

- Add options `syncPastDays` (default `30`) and `syncFutureDays` (default `0` =
  unbounded future). Expose both in the Options UI with sensible validation.
- `doFullSync` passes `rangeStart = now - syncPastDays` and, when
  `syncFutureDays > 0`, `rangeEnd = now + syncFutureDays` to
  `browser.calendar.items.query` (the experiment `query` already supports
  `rangeStart`/`rangeEnd`).
- **Orphan removal must respect the window:** the existing "delete target items no
  longer in source" pass must not delete items that merely fell outside the window.
  Scope removal to mapped items whose source counterpart is *within the window* but
  now absent — items that aged out of the window are left untouched (and pruned
  from the map without deleting on the target). This is an explicit correctness
  requirement for the plan.

### 4.4 Idempotency — assign-UID-then-persist-then-write

Replace "create, hope it returns, then record" with:

1. Generate the unique target UID (`crypto.randomUUID()@sync-cal`).
2. Record the intended mapping `map.items[sourceId] = targetUid` **and persist**
   *before* the write.
3. Write with that UID (CalDAV item id == UID).
4. On success, keep the mapping. On timeout/error, **leave the mapping** — because
   the next sync will see it and take the `update` path, which is idempotent
   (a `PUT` to the same href overwrites in place). Retries reuse the **same** UID,
   so they never create a second copy.

This makes heuristic duplicate detection a *fallback*, not the primary defense.

### 4.5 Duplicate detection — UID-first, VEVENT-scoped fallback

- Primary: match by the assigned `@sync-cal` UID (query/scan target for an item
  whose `UID:` equals the mapping's target UID). Reliable and exact.
- Fallback (`extractEventInfo`): isolate the first `BEGIN:VEVENT…END:VEVENT`
  block before extracting `SUMMARY`/`DTSTART`, so it reads the event, not the
  timezone. Retained for recovery when the map is missing/stale.

### 4.6 Correct UID rewriting — `rewriteUid`

- Unfold RFC 5545 folded lines (`/\r?\n[ \t]/`) before matching.
- Use a global replace so **all** components (recurrence master + exceptions) get
  the same new UID (they legitimately share one UID).
- Preserve the non-string (jcal) passthrough.

### 4.7 Echo suppression — drop `isSyncing`

Remove the `isSyncing` counter and the listener guards. Rely on the existing
`rawItem.calendarId !== sourceCalendarId` filter (and the target-id check) to
ignore our own writes. This also fixes the dropped-edit bug: source edits during a
sync are enqueued normally and serialized by `syncQueue`.

### 4.8 Honest status reporting

- `doFullSync` returns `{created, updated, removed, failed}`.
- `manualSyncForUi` reports `ok:false` (or an explicit warning) when `failed > 0`,
  with a count.
- `options.js` surfaces the partial-failure message in `manualSyncStatus`.

### 4.9 Trim experiment API + version metadata

- Remove dead surface flagged by investigation: `items.move`, `items.getCurrent`,
  `items.onAlarm`, and **all** of `calendars.{create,update,remove,clear,
  synchronize}` and `calendars.{onCreated,onUpdated,onRemoved}`. Keep
  `items.{query,get,create,update,remove,onCreated,onUpdated,onRemoved}` and
  `calendars.{query,get}`. Update the matching JSON schemas.
- `manifest.json`: `strict_min_version` → `140.0`; bump `version`.
- `package.json`: bump `version` to match.
- README: update requirements (Betterbird/Thunderbird 140+) and the sync-window
  behavior.
- Keep `ext-calendar-utils.js` and its `.sys.mjs` reference variant in sync.

## 5. Testing strategy

The current tests duplicate logic inline (the source files aren't importable).
Where practical, refactor pure helpers (`extractEventInfo`, `rewriteUid`, window
range computation, map/idempotency transitions) so they can be tested directly,
and add unit tests for:

- `extractEventInfo`: a VEVENT with a full VTIMEZONE returns the **event** start,
  not the timezone transition date.
- `rewriteUid`: folded long UID is rewritten cleanly; multi-component VCALENDAR
  (master + exception) rewrites all UIDs; jcal passthrough unchanged.
- Window range computation for the four window modes.
- Idempotency: timed-out create leaves a usable mapping; next pass updates instead
  of creating.
- Orphan-removal scoping: an item that aged out of the window is not deleted on
  the target.

Manual verification on Betterbird 140 with the real UNIGE→Gmail setup: a clean
sync of the window with no duplicates and no 30 s timeouts; an edit and a delete
propagate; "Sync Now" reports accurate counts.

## 6. Risks & open items

- **Observer-based create resolution** must match the exact UID + calendar to
  avoid resolving on an unrelated add; needs a fallback timeout so a never-arriving
  observer can't hang forever.
- **Existing duplicates** already in Gmail are out of scope; optionally add a
  "scan & merge duplicates" maintenance action later (UID/summary+start based).
- **moz-src module migration** (TB bug 1979960/1985395) will eventually break the
  `resource:///modules/…` imports — track, don't fix now.
- **Betterbird vs Thunderbird** divergence in calendar internals is assumed
  minimal (BB tracks TB ESR); verify the create fix on BB140 specifically.

## 7. Build / rollout

- Build with `npm run build` (excludes `*.sys.mjs`) → `sync-cal.xpi`.
- Install over the existing add-on; ensure `extensions.experiments.enabled = true`.
- Land on `bb140-modernize-harden`; integrate per the user's preferred flow.
