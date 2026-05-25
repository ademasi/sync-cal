# Calendar Sync Bridge — BB140 Modernize & Harden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one-way calendar sync reliable on Betterbird/Thunderbird 140 against Google CalDAV — eliminate the create-timeout hang and the duplicate/UID/echo bugs, and bound sync to a configurable date window.

**Architecture:** Keep the existing two-domain design (sandboxed `background.js` + privileged `experiments/calendar` scripts, options↔background via `storage.local`). Extract pure, bug-prone helpers into a testable `helpers.js`. Fix create resolution in the experiment layer (resolve from the `onAddItem` observer). Make writes idempotent in `background.js` by persisting the assigned target UID before writing.

**Tech Stack:** WebExtension MV2 (Thunderbird/Betterbird), vanilla JS, Jest, ESLint.

**Reference spec:** `docs/superpowers/specs/2026-05-25-calendar-sync-bb140-modernize-design.md`

**Conventions for every task:** 2-space indent, double quotes, semicolons (ESLint enforced). Run `npm run lint` and `npm test` before each commit. Commit messages end with the trailer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `helpers.js` | Pure iCal/date helpers shared by background + tests (UMD) | Create |
| `tests/helpers.test.js` | Unit tests for helpers | Create |
| `background.html` | Load `helpers.js` before `background.js` | Modify |
| `background.js` | Sync logic: idempotent upsert, window, pacing, honest status, no `isSyncing` | Modify |
| `experiments/calendar/parent/ext-calendar-items.js` | Reliable create via observer; defensive guard; trim dead API | Modify |
| `experiments/calendar/ext-calendar-utils.js` (+`.sys.mjs`) | Guard `convertItem` | Modify |
| `experiments/calendar/parent/ext-calendar-calendars.js` | Trim dead API | Modify |
| `experiments/calendar/schema/calendar-items.json` | Remove trimmed functions/events | Modify |
| `experiments/calendar/schema/calendar-calendars.json` | Remove trimmed functions/events | Modify |
| `options.html` / `options.css` / `options.js` | Window fields + honest status | Modify |
| `manifest.json` / `package.json` | `strict_min_version` 140, version bump, packaging | Modify |
| `.eslintrc.json` | `helpers.js` env + `SyncCalHelpers` global | Modify |
| `README.md` / `CLAUDE.md` | Docs | Modify |

---

## Task 1: Pure helpers module (`helpers.js`) with tests

**Files:**
- Create: `helpers.js`
- Create: `tests/helpers.test.js`
- Modify: `.eslintrc.json`

- [ ] **Step 1: Write failing tests** — Create `tests/helpers.test.js`:

```js
const {
  unfoldIcal,
  rewriteUid,
  extractEventInfo,
  extractUid,
  computeSyncRange,
} = require("../helpers.js");

const VEVENT_WITH_TZ =
  "BEGIN:VCALENDAR\r\n" +
  "BEGIN:VTIMEZONE\r\nTZID:Europe/Zurich\r\n" +
  "BEGIN:STANDARD\r\nDTSTART:18530716T000000\r\nEND:STANDARD\r\n" +
  "END:VTIMEZONE\r\n" +
  "BEGIN:VEVENT\r\nUID:src-123@exchange\r\nSUMMARY:Kick-off\r\n" +
  "DTSTART;TZID=Europe/Zurich:20260301T100000\r\nEND:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

describe("extractEventInfo", () => {
  test("reads the VEVENT start, not the VTIMEZONE transition date", () => {
    expect(extractEventInfo(VEVENT_WITH_TZ)).toEqual({
      title: "Kick-off",
      dtstart: "20260301T100000",
    });
  });
  test("returns nulls for non-string", () => {
    expect(extractEventInfo(null)).toEqual({ title: null, dtstart: null });
  });
});

describe("rewriteUid", () => {
  test("rewrites a simple UID", () => {
    const out = rewriteUid("BEGIN:VEVENT\r\nUID:old@x\r\nEND:VEVENT\r\n", "new@sync-cal");
    expect(out).toContain("UID:new@sync-cal\r\n");
    expect(out).not.toContain("old@x");
  });
  test("unfolds an RFC5545-folded long UID before rewriting", () => {
    const folded = "BEGIN:VEVENT\r\nUID:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST\r\n uvwxyz@exchange\r\nSUMMARY:x\r\nEND:VEVENT\r\n";
    const out = rewriteUid(folded, "new@sync-cal");
    expect(out).toContain("UID:new@sync-cal\r\n");
    expect(out).not.toContain("uvwxyz@exchange");
  });
  test("rewrites ALL UIDs (recurrence master + exception)", () => {
    const ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:src@x\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:src@x\r\nRECURRENCE-ID:20260301T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const out = rewriteUid(ical, "new@sync-cal");
    expect(out.match(/UID:new@sync-cal/g)).toHaveLength(2);
    expect(out).not.toContain("src@x");
  });
  test("passes through non-string items unchanged", () => {
    const obj = { some: "jcal" };
    expect(rewriteUid(obj, "new")).toBe(obj);
  });
});

describe("extractUid", () => {
  test("returns the (unfolded) UID", () => {
    expect(extractUid(VEVENT_WITH_TZ)).toBe("src-123@exchange");
  });
});

describe("computeSyncRange", () => {
  const now = new Date("2026-05-25T12:00:00.000Z");
  test("past window produces an iCal UTC rangeStart, null end when future unbounded", () => {
    expect(computeSyncRange(now, 30, 0)).toEqual({
      rangeStart: "20260425T120000Z",
      rangeEnd: null,
    });
  });
  test("bounded future window produces a rangeEnd", () => {
    const { rangeEnd } = computeSyncRange(now, 30, 10);
    expect(rangeEnd).toBe("20260604T120000Z");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/helpers.test.js`
Expected: FAIL — "Cannot find module '../helpers.js'".

- [ ] **Step 3: Implement `helpers.js`**

```js
/*
 * Pure, side-effect-free helpers shared by background.js and the unit tests.
 * Loaded as a plain script in background.html (sets globalThis.SyncCalHelpers)
 * and required directly by Jest (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SyncCalHelpers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // RFC 5545 §3.1: a CRLF (or LF) followed by a space or tab is line folding.
  function unfoldIcal(icalString) {
    return icalString.replace(/\r?\n[ \t]/g, "");
  }

  function rewriteUid(icalString, newUid) {
    if (typeof icalString !== "string") {
      return icalString;
    }
    // Unfold first so long (Exchange) UIDs match; rewrite every component's UID
    // (recurrence master + exceptions legitimately share one UID).
    return unfoldIcal(icalString).replace(/^UID:[^\r\n]+(\r?\n)/gm, `UID:${newUid}$1`);
  }

  // Read SUMMARY/DTSTART from the first VEVENT/VTODO block only, so a
  // VTIMEZONE's DTSTART (a historical transition date) is never matched.
  function extractEventInfo(icalString) {
    if (typeof icalString !== "string") {
      return { title: null, dtstart: null };
    }
    const unfolded = unfoldIcal(icalString);
    const block = unfolded.match(/BEGIN:(?:VEVENT|VTODO)[\s\S]*?END:(?:VEVENT|VTODO)/);
    const scope = block ? block[0] : "";
    const summaryMatch = scope.match(/^SUMMARY[^:]*:(.+)$/m);
    const dtstartMatch = scope.match(/^DTSTART[^:]*:(.+)$/m);
    return {
      title: summaryMatch ? summaryMatch[1].trim() : null,
      dtstart: dtstartMatch ? dtstartMatch[1].trim() : null,
    };
  }

  function extractUid(icalString) {
    if (typeof icalString !== "string") {
      return null;
    }
    const m = unfoldIcal(icalString).match(/^UID:(.+)$/m);
    return m ? m[1].trim() : null;
  }

  // iCalendar UTC date-time string, e.g. "20260525T120000Z" (cal.createDateTime
  // in the experiment expects this format, NOT ISO-8601 with separators).
  function toIcalUtc(date) {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  function computeSyncRange(now, pastDays, futureDays) {
    const dayMs = 86400000;
    const rangeStart = toIcalUtc(new Date(now.getTime() - pastDays * dayMs));
    const rangeEnd = futureDays > 0
      ? toIcalUtc(new Date(now.getTime() + futureDays * dayMs))
      : null;
    return { rangeStart, rangeEnd };
  }

  return { unfoldIcal, rewriteUid, extractEventInfo, extractUid, toIcalUtc, computeSyncRange };
});
```

- [ ] **Step 4: Add ESLint support** — In `.eslintrc.json`, add `"SyncCalHelpers": "readonly"` to the top-level `globals` object, and add this object to the `overrides` array:

```json
{
  "files": ["helpers.js"],
  "env": { "browser": true, "node": true }
}
```

- [ ] **Step 5: Run tests + lint**

Run: `npm test -- tests/helpers.test.js` → Expected: PASS (all cases).
Run: `npm run lint` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add helpers.js tests/helpers.test.js .eslintrc.json
git commit -m "Add tested pure helpers (UID rewrite, VEVENT-scoped extract, sync range)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire `helpers.js` into the background page and packaging

**Files:**
- Modify: `background.html`
- Modify: `background.js:91-108` (remove local `rewriteUid` + `extractEventInfo`; use helpers)
- Modify: `package.json` (build script includes `helpers.js`)

- [ ] **Step 1: Load helpers before background** — In `background.html`, change the body scripts to:

```html
    <script src="helpers.js"></script>
    <script src="background.js"></script>
```

- [ ] **Step 2: Reference helpers in background.js** — At the top of `background.js` (after the file header comment, before `const DEFAULT_OPTIONS`), add (import only what background uses, or ESLint `no-unused-vars` will fire):

```js
const { rewriteUid, extractEventInfo, computeSyncRange } = globalThis.SyncCalHelpers;
```

Then DELETE the now-duplicated local definitions: `rewriteUid` (`background.js:95-98`) and `extractEventInfo` (`background.js:100-108`). Leave `generateUid` in place.

- [ ] **Step 3: Update the build script** — In `package.json`, set:

```json
"build": "zip -r sync-cal.xpi manifest.json background.html background.js helpers.js options.html options.js options.css icons/ experiments/ -x '*.sys.mjs'"
```

- [ ] **Step 4: Lint + test**

Run: `npm run lint` → Expected: no errors (note: `SyncCalHelpers` global now allowed from Task 1).
Run: `npm test` → Expected: existing suites pass (the `rewriteUid`/`extractEventInfo` copies still living in `tests/background.test.js` are unaffected; they will be reconciled in Task 9).

- [ ] **Step 5: Commit**

```bash
git add background.html background.js package.json
git commit -m "Use shared helpers in background; package helpers.js

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Reliable create in the experiment layer (observer-based)

**Files:**
- Modify: `experiments/calendar/parent/ext-calendar-items.js` (add `adoptItemReliably`; use it + guard in `create`)
- Modify: `experiments/calendar/ext-calendar-utils.js:179` and the `.sys.mjs` mirror (guard `convertItem`)

This layer cannot be unit-tested (requires Thunderbird). Verify manually per Step 5.

- [ ] **Step 1: Add `adoptItemReliably`** — In `ext-calendar-items.js`, after the imports block (after line 12, `imports complete`), add a module-level helper:

```js
// CalDAV's adoptItem promise can hang when the post-PUT multiget fails to
// notify the operation listener (observed on TB/BB 140 with Google CalDAV).
// Resolve from the onAddItem observer, which fires when the item actually
// lands in the calendar, and race it against adoptItem's own settlement.
function adoptItemReliably(calendar, item) {
  const expectedUid = item.id;
  const calendarId = calendar.id;
  const setTimeoutFn = typeof setTimeout === "function" ? setTimeout : null;
  const clearTimeoutFn = typeof clearTimeout === "function" ? clearTimeout : null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const observer = cal.createAdapter(Ci.calIObserver, {
      onAddItem(addedItem) {
        if (!settled && addedItem && addedItem.id === expectedUid &&
            addedItem.calendar && addedItem.calendar.id === calendarId) {
          finish(() => resolve(addedItem));
        }
      },
    });
    function finish(action) {
      if (settled) {
        return;
      }
      settled = true;
      if (timer && clearTimeoutFn) {
        clearTimeoutFn(timer);
      }
      cal.manager.removeCalendarObserver(observer);
      action();
    }
    cal.manager.addCalendarObserver(observer);
    if (setTimeoutFn) {
      // Backstop so a never-arriving observer cannot leak forever; background.js
      // also wraps the whole call in a 30s timeout.
      timer = setTimeoutFn(
        () => finish(() => reject(new ExtensionError(`Create observer timed out for ${expectedUid}`))),
        28000
      );
    }
    Promise.resolve()
      .then(() => calendar.adoptItem(item))
      .then(
        result => finish(() => resolve(result || null)),
        err => { if (!settled) { finish(() => reject(err)); } }
      );
  });
}
```

- [ ] **Step 2: Use it + guard in `create`** — In `ext-calendar-items.js`, replace the create body's `else`/return (current lines 90-97) so it reads:

```js
            let createdItem;
            if (isCachedCalendar(calendarId)) {
              createdItem = await calendar.modifyItem(item, null);
            } else {
              createdItem = await adoptItemReliably(calendar, item);
            }

            if (!createdItem || typeof createdItem.isEvent !== "function") {
              throw new ExtensionError(`create resolved with a non-item value for ${calendarId}`);
            }
            return convertItem(createdItem, createProperties, context.extension);
```

- [ ] **Step 3: Guard `convertItem`** — In `experiments/calendar/ext-calendar-utils.js`, change line 179 from `props.calendarId = item.calendar.superCalendar.id;` to:

```js
  props.calendarId = item.calendar?.superCalendar?.id ?? item.calendar?.id;
```

Apply the identical change in `experiments/calendar/ext-calendar-utils.sys.mjs` (keep the two in sync).

- [ ] **Step 4: Lint**

Run: `npm run lint` → Expected: no errors (`MatchPattern`/`MatchGlob` overrides already cover experiments; `setTimeout`/`clearTimeout`/`cal`/`Ci`/`ExtensionError` resolve in the experiment scope).

- [ ] **Step 5: Manual verification (record result in commit)**

Build (`npm run build`), install `sync-cal.xpi` in Betterbird 140, set `extensions.experiments.enabled=true`, configure UNIGE→Gmail, click "Sync now", open Error Console (Ctrl+Shift+J). Expected: creates complete WITHOUT `Create timed out`; new events appear once in Gmail.

- [ ] **Step 6: Commit**

```bash
git add experiments/calendar/parent/ext-calendar-items.js experiments/calendar/ext-calendar-utils.js experiments/calendar/ext-calendar-utils.sys.mjs
git commit -m "Resolve CalDAV create via onAddItem observer; guard convertItem

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Idempotent upsert in `background.js`

Replaces the duplicated create/update/dup-detect blocks in `doFullSync` and `syncOneItem` with one `pushItem` that persists the assigned target UID **before** writing, so a timed-out-but-committed write becomes a harmless update next pass.

**Files:**
- Modify: `background.js` (`safeCreate` signature; new `pushItem`; `findDuplicateInTarget` uses helpers)
- Modify: `tests/background.test.js` (add `pushItem` idempotency tests via the inline-copy pattern)

- [ ] **Step 1: Write failing idempotency tests** — Append to `tests/background.test.js`:

```js
describe("pushItem idempotency (logic copy)", () => {
  // Mirrors background.js pushItem; keep in sync with the source.
  function makePushItem({ safeCreate, safeUpdate, findDuplicateInTarget, saveMap, generateUid }) {
    return async function pushItem(options, map, item) {
      let targetUid = map.items[item.id];
      if (!targetUid) {
        const existingUid = await findDuplicateInTarget(options.targetCalendarId, item);
        if (existingUid) {
          map.items[item.id] = existingUid;
          await saveMap(map);
          try { await safeUpdate(options.targetCalendarId, existingUid, item); return "updated"; }
          catch { return "failed"; }
        }
        targetUid = generateUid();
        map.items[item.id] = targetUid;
        await saveMap(map);
        try { await safeCreate(options.targetCalendarId, targetUid, item); return "created"; }
        catch { return "failed"; }
      }
      try { await safeUpdate(options.targetCalendarId, targetUid, item); return "updated"; }
      catch {
        try { await safeCreate(options.targetCalendarId, targetUid, item); return "created"; }
        catch { return "failed"; }
      }
    };
  }

  const options = { targetCalendarId: "tgt" };

  test("timed-out create keeps the mapping (so next run can reconcile)", async () => {
    const map = { items: {} };
    const pushItem = makePushItem({
      safeCreate: jest.fn().mockRejectedValue(new Error("Create timed out")),
      safeUpdate: jest.fn(),
      findDuplicateInTarget: jest.fn().mockResolvedValue(null),
      saveMap: jest.fn(),
      generateUid: () => "uid-1@sync-cal",
    });
    const result = await pushItem(options, map, { id: "src-1", item: "ICAL" });
    expect(result).toBe("failed");
    expect(map.items["src-1"]).toBe("uid-1@sync-cal"); // mapping persisted before write
  });

  test("existing mapping takes the update path and reuses the same UID", async () => {
    const map = { items: { "src-1": "uid-1@sync-cal" } };
    const safeUpdate = jest.fn().mockResolvedValue({});
    const safeCreate = jest.fn();
    const pushItem = makePushItem({
      safeCreate, safeUpdate,
      findDuplicateInTarget: jest.fn(),
      saveMap: jest.fn(),
      generateUid: () => "SHOULD-NOT-BE-USED",
    });
    const result = await pushItem(options, map, { id: "src-1", item: "ICAL" });
    expect(result).toBe("updated");
    expect(safeUpdate).toHaveBeenCalledWith("tgt", "uid-1@sync-cal", expect.anything());
    expect(safeCreate).not.toHaveBeenCalled();
  });

  test("update failure on existing mapping recreates with the SAME UID (no duplicate)", async () => {
    const map = { items: { "src-1": "uid-1@sync-cal" } };
    const safeCreate = jest.fn().mockResolvedValue({});
    const pushItem = makePushItem({
      safeCreate,
      safeUpdate: jest.fn().mockRejectedValue(new Error("not found")),
      findDuplicateInTarget: jest.fn(),
      saveMap: jest.fn(),
      generateUid: () => "SHOULD-NOT-BE-USED",
    });
    const result = await pushItem(options, map, { id: "src-1", item: "ICAL" });
    expect(result).toBe("created");
    expect(safeCreate).toHaveBeenCalledWith("tgt", "uid-1@sync-cal", expect.anything());
  });
});
```

- [ ] **Step 2: Run tests to verify they pass against the copy**

Run: `npm test -- tests/background.test.js` → Expected: PASS (the copy under test is self-contained). This locks the intended behavior before editing source.

- [ ] **Step 3: Change `safeCreate` signature in `background.js`** — Replace `safeCreate` (current lines 141-166) with a version that takes the target UID explicitly (no internal `generateUid`):

```js
async function safeCreate(targetCalendarId, targetUid, sourceItem) {
  const format = sourceItem.format || "ical";
  const modifiedIcal = typeof sourceItem.item === "string"
    ? rewriteUid(sourceItem.item, targetUid)
    : sourceItem.item;

  logInfo("Creating item", sourceItem.id, "->", targetUid, "type:", sourceItem.type);
  const result = await withTimeout(
    browser.calendar.items.create(targetCalendarId, {
      type: sourceItem.type,
      format,
      item: modifiedIcal
    }),
    30000,
    `Create timed out for ${sourceItem.id}`
  );
  logInfo("Created item", sourceItem.id, "->", targetUid);
  return result;
}
```

(Note: the `isSyncing++/--` wrapping is removed here — `isSyncing` is deleted entirely in Task 6.)

- [ ] **Step 4: Update `findDuplicateInTarget`** — It already calls `extractEventInfo` (now from helpers). Confirm it returns the target item id. No code change needed beyond Task 2's helper wiring; verify it reads `targetItem.id` as the linkable UID.

- [ ] **Step 5: Add `pushItem` to `background.js`** — Insert after `findDuplicateInTarget` (before `safeCreate` or near the other sync functions):

```js
// Upsert one source item into the target. Persists the assigned target UID
// BEFORE writing so a timed-out-but-committed write reconciles as an update
// next pass instead of duplicating. Returns "created" | "updated" | "failed".
async function pushItem(options, map, item) {
  let targetUid = map.items[item.id];

  if (!targetUid) {
    // Link to a pre-existing copy (e.g. created by older builds) if we can find one.
    const existingUid = await findDuplicateInTarget(options.targetCalendarId, item);
    if (existingUid) {
      logInfo("Linking to existing target item", item.id, "->", existingUid);
      map.items[item.id] = existingUid;
      await saveMap(map);
      try {
        await safeUpdate(options.targetCalendarId, existingUid, item);
        return "updated";
      } catch (err) {
        logError("Update of linked item failed", existingUid, err);
        return "failed";
      }
    }
    targetUid = generateUid();
    map.items[item.id] = targetUid;
    await saveMap(map); // persist intent before the write
    try {
      await safeCreate(options.targetCalendarId, targetUid, item);
      return "created";
    } catch (err) {
      logError("Create failed (mapping kept for next run)", item.id, err);
      return "failed";
    }
  }

  // Known mapping: update; if the target item is gone, recreate with the SAME UID.
  try {
    await safeUpdate(options.targetCalendarId, targetUid, item);
    return "updated";
  } catch (err) {
    logError("Update failed, recreating with same UID", item.id, err);
    try {
      await safeCreate(options.targetCalendarId, targetUid, item);
      return "created";
    } catch (err2) {
      logError("Recreate failed (mapping kept)", item.id, err2);
      return "failed";
    }
  }
}
```

- [ ] **Step 6: Lint + test**

Run: `npm run lint` → Expected: no errors.
Run: `npm test` → Expected: PASS. (`doFullSync`/`syncOneItem` still reference the old create flow until Task 5; if any reference to the old `safeCreate(target, item)` signature remains, it is rewired in Task 5. Confirm the project still lints by leaving the old call sites updated minimally OR proceed directly to Task 5 in the same working session before running the addon.)

> Implementation note: Tasks 4 and 5 touch the same functions; if executing with subagents, run them back-to-back and lint/test after Task 5. The commit below captures the helper addition.

- [ ] **Step 7: Commit**

```bash
git add background.js tests/background.test.js
git commit -m "Add idempotent pushItem (persist target UID before write)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Sync window, pacing, window-aware orphan removal, honest `doFullSync`

**Files:**
- Modify: `background.js` (`DEFAULT_OPTIONS`, `validateCalendars`, `doFullSync`, `syncOneItem`)

- [ ] **Step 1: Extend defaults** — In `background.js`, change `DEFAULT_OPTIONS` to:

```js
const DEFAULT_OPTIONS = {
  sourceCalendarId: "",
  targetCalendarId: "",
  autoSync: true,
  syncPastDays: 30,
  syncFutureDays: 0
};
```

- [ ] **Step 2: Return calendars from `validateCalendars`** — Change the success return (line 241) to `return { ok: true, source, target };` (leave failure returns as-is).

- [ ] **Step 3: Add a pacing helper** — Near the top helpers in `background.js`, add:

```js
const CALDAV_PACING_MS = 200;
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Rewrite `doFullSync`** — Leave the start of the function unchanged (`logInfo`, `getOptions`, the `!force && !options.autoSync` early-return, `ensureCalendarApi();`). Replace everything from the existing `const validation = await validateCalendars(options);` line through the end of the function with:

```js
  const validation = await validateCalendars(options);
  if (!validation.ok) {
    logInfo("Sync skipped:", validation.reason);
    if (validation.reason !== "missing") {
      throw new Error(`Calendar validation failed: ${validation.reason}`);
    }
    return { created: 0, updated: 0, removed: 0, failed: 0 };
  }

  const paceWrites = validation.target && validation.target.type === "caldav";
  const map = await getMap(options);
  const { rangeStart, rangeEnd } = computeSyncRange(new Date(), options.syncPastDays, options.syncFutureDays);
  const query = {
    calendarId: options.sourceCalendarId,
    returnFormat: "ical",
    rangeStart
  };
  if (rangeEnd) {
    query.rangeEnd = rangeEnd;
  }
  const sourceItems = await browser.calendar.items.query(query);
  logInfo(`Found ${sourceItems.length} source items in window`, { rangeStart, rangeEnd });

  const seen = new Set();
  let created = 0, updated = 0, failed = 0;
  for (const rawItem of sourceItems) {
    const item = await ensureItemData(rawItem);
    seen.add(item.id);
    const result = await pushItem(options, map, item);
    if (result === "created") { created++; }
    else if (result === "updated") { updated++; }
    else { failed++; }
    if (paceWrites && result !== "failed") {
      await delay(CALDAV_PACING_MS);
    }
  }

  // Orphan handling: a mapped source item not seen in the window is either
  // (a) deleted from source -> delete the target copy, or (b) aged out of the
  // window -> keep the target copy and the mapping. Probe source to tell apart.
  let removed = 0;
  for (const [sourceId, targetUid] of Object.entries(map.items)) {
    if (seen.has(sourceId)) {
      continue;
    }
    let stillInSource = false;
    try {
      const probe = await browser.calendar.items.get(options.sourceCalendarId, sourceId, { returnFormat: "ical" });
      stillInSource = !!probe;
    } catch (err) {
      logError("Source probe failed (treating as deleted)", sourceId, err);
      stillInSource = false;
    }
    if (stillInSource) {
      continue; // aged out of window; keep target copy + mapping
    }
    try {
      await safeRemove(options.targetCalendarId, targetUid);
      removed++;
    } catch (err) {
      logError("Remove failed", targetUid, err);
    }
    delete map.items[sourceId];
  }

  await saveMap(map);
  logInfo("Full sync complete", { reason, created, updated, removed, failed });
  return { created, updated, removed, failed };
```

- [ ] **Step 5: Simplify `syncOneItem` to use `pushItem`** — Replace the mapping/create/update body of `syncOneItem` (from `const map = await getMap(options);` to the end) with:

```js
  const map = await getMap(options);
  const item = await ensureItemData(rawItem);
  await pushItem(options, map, item);
}
```

(`removeOneItem` is unchanged except `targetId`→`targetUid` naming is cosmetic; leave as-is.)

- [ ] **Step 6: Lint + test**

Run: `npm run lint` → Expected: no errors.
Run: `npm test` → Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add background.js
git commit -m "Bound sync to a configurable window; pace CalDAV writes; window-aware orphan removal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Remove `isSyncing`; honest status reporting

**Files:**
- Modify: `background.js` (delete `isSyncing`; listeners; `safeUpdate`/`safeRemove` finally blocks; `manualSyncForUi`)
- Modify: `options.js` (surface partial-failure)

- [ ] **Step 1: Delete the counter** — Remove `let isSyncing = 0;` (line 16).

- [ ] **Step 2: Unwrap `safeUpdate` and `safeRemove`** — Remove the `isSyncing++; try { … } finally { isSyncing--; }` wrappers so each simply `return await withTimeout(...)` / `await withTimeout(...)`. Keep the `rewriteUid` call in `safeUpdate`:

```js
async function safeUpdate(targetCalendarId, targetItemId, sourceItem) {
  const format = sourceItem.format || "ical";
  const modifiedIcal = typeof sourceItem.item === "string"
    ? rewriteUid(sourceItem.item, targetItemId)
    : sourceItem.item;
  return withTimeout(
    browser.calendar.items.update(targetCalendarId, targetItemId, { format, item: modifiedIcal }),
    30000,
    `Update timed out for ${targetItemId}`
  );
}

async function safeRemove(targetCalendarId, targetItemId) {
  await withTimeout(
    browser.calendar.items.remove(targetCalendarId, targetItemId),
    30000,
    `Remove timed out for ${targetItemId}`
  );
}
```

- [ ] **Step 3: Drop the listener guards** — In `setupListeners`, remove the three `if (isSyncing > 0) return;` lines so each listener just enqueues. Echo from our own target writes is still ignored because `syncOneItem`/`removeOneItem` filter on `calendarId !== sourceCalendarId`.

- [ ] **Step 4: Honest manual sync** — Replace `manualSyncForUi` with:

```js
async function manualSyncForUi() {
  try {
    const counts = await enqueueSync(() => doFullSync("manual", true), true);
    const failed = counts && counts.failed ? counts.failed : 0;
    if (failed > 0) {
      return { ok: false, error: `Sync finished with ${failed} item(s) failing`, counts };
    }
    return { ok: true, counts };
  } catch (err) {
    logError("Manual sync failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
}
```

- [ ] **Step 5: Surface in options.js** — In the `manualSyncStatus` handler (`options.js:228-238`), change the success branch to show counts when present:

```js
    if (status.ok) {
      const c = status.counts;
      setStatus(c ? `Sync complete (${c.created} created, ${c.updated} updated, ${c.removed} removed).` : "Sync complete.");
    } else {
      setStatus(`Sync failed: ${status.error || "Unexpected error."}`, true);
    }
```

- [ ] **Step 6: Lint + test**

Run: `npm run lint` → Expected: no errors.
Run: `npm test` → Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add background.js options.js
git commit -m "Remove isSyncing race; report sync counts and partial failures

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Options UI — configurable sync window

**Files:**
- Modify: `options.html` (two number inputs)
- Modify: `options.css` (reuse `.field`; minor)
- Modify: `options.js` (refs, load, validate, save)

- [ ] **Step 1: Add inputs** — In `options.html`, inside `.actions` before the `.buttons` div (or in a new row above `.actions`), add:

```html
          <label class="field window-field">
            <span>Sync past days</span>
            <input id="sync-past-days" type="number" min="0" step="1" value="30">
          </label>
          <label class="field window-field">
            <span>Sync future days (0 = unlimited)</span>
            <input id="sync-future-days" type="number" min="0" step="1" value="0">
          </label>
```

- [ ] **Step 2: Style** — In `options.css`, add:

```css
.window-field {
  flex: 0 1 180px;
}
.window-field input {
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  font-size: 1rem;
}
```

- [ ] **Step 3: Wire refs + load** — In `options.js`, add after the existing `const` element refs:

```js
const pastDaysInput = document.getElementById("sync-past-days");
const futureDaysInput = document.getElementById("sync-future-days");
```

In `loadOptions`, after `autoSyncToggle.checked = ...`, add:

```js
  pastDaysInput.value = Number.isInteger(options.syncPastDays) ? options.syncPastDays : 30;
  futureDaysInput.value = Number.isInteger(options.syncFutureDays) ? options.syncFutureDays : 0;
```

- [ ] **Step 4: Validate + save** — In `validateSelections`, before the final `return`, parse the window and include it:

```js
  const pastDays = parseInt(pastDaysInput.value, 10);
  const futureDays = parseInt(futureDaysInput.value, 10);
  if (!Number.isInteger(pastDays) || pastDays < 0 || !Number.isInteger(futureDays) || futureDays < 0) {
    setStatus("Sync window days must be whole numbers ≥ 0.", true);
    return null;
  }

  return {
    sourceCalendarId: sourceId,
    targetCalendarId: targetId,
    autoSync: autoSyncToggle.checked,
    syncPastDays: pastDays,
    syncFutureDays: futureDays
  };
```

- [ ] **Step 5: Lint + test**

Run: `npm run lint` → Expected: no errors.
Run: `npm test` → Expected: PASS (options.test.js `validateSelections` copy is independent; leave it, reconcile note in Task 9).

- [ ] **Step 6: Commit**

```bash
git add options.html options.css options.js
git commit -m "Add configurable sync window to options UI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Trim dead experiment API surface

Removes API the add-on never calls (confirmed by investigation), shrinking breakage/maintenance surface. **Keep:** `items.{query,get,create,update,remove,onCreated,onUpdated,onRemoved}`, `calendars.{query,get}`.

**Files:**
- Modify: `experiments/calendar/parent/ext-calendar-items.js`
- Modify: `experiments/calendar/parent/ext-calendar-calendars.js`
- Modify: `experiments/calendar/schema/calendar-items.json`
- Modify: `experiments/calendar/schema/calendar-calendars.json`

- [ ] **Step 1: Remove item methods/events** — In `ext-calendar-items.js`, delete the `move` (lines 126-148), `getCurrent` (159-168), and `onAlarm` (223-246) blocks. The only destructure change on line 32 is removing `convertAlarm` (it was used solely by `onAlarm`); the result is `const { getResolvedCalendarById, getCachedCalendar, isCachedCalendar, isOwnCalendar, propsToItem, convertItem } = utils;`. In `calendar-items.json`, delete the `move` and `getCurrent` function entries, the `onAlarm` event entry, and the now-unused `CalendarItemAlarm` type.

- [ ] **Step 2: Remove calendar methods/events** — In `ext-calendar-calendars.js`, delete `create` (102-126), `update` (127-178), `remove` (179-186), `clear` (187-215), `synchronize` (217-242), and the `onCreated`/`onUpdated`/`onRemoved` event blocks (244-318). After this, `getResolvedCalendarById` is used only by the deleted `clear`, so change the destructure on line 32 to `const { unwrapCalendar, isOwnCalendar, convertCalendar } = utils;` (drop `getResolvedCalendarById`; `unwrapCalendar`+`isOwnCalendar` are still used by `get`, `convertCalendar` by `query`+`get`). In `calendar-calendars.json`, delete the matching `create`/`update`/`remove`/`clear`/`synchronize` functions and all three `events`, and remove the `CalendarChangeProps` type (only referenced by the deleted `onUpdated`). Keep `CalendarCapabilities` — the retained `Calendar` type still references it.

- [ ] **Step 3: Lint + JSON validity**

Run: `npm run lint` → Expected: no errors (no unused-var violations from removed destructures).
Run: `node -e "require('./experiments/calendar/schema/calendar-items.json'); require('./experiments/calendar/schema/calendar-calendars.json'); console.log('json ok')"` → Expected: `json ok`.

- [ ] **Step 4: Manual smoke (record in commit)** — Rebuild + reload in Betterbird; confirm options still lists calendars and a sync still runs (exercises the retained `calendars.query/get` + `items.*`).

- [ ] **Step 5: Commit**

```bash
git add experiments/calendar/parent/ext-calendar-items.js experiments/calendar/parent/ext-calendar-calendars.js experiments/calendar/schema/calendar-items.json experiments/calendar/schema/calendar-calendars.json
git commit -m "Trim unused experiment API (move/getCurrent/onAlarm; calendars CRUD + observers)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Version metadata, test reconciliation, and docs

**Files:**
- Modify: `manifest.json`, `package.json`
- Modify: `tests/background.test.js`, `tests/options.test.js` (reconcile copied logic with new behavior)
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Bump versions** — In `manifest.json` set `"strict_min_version": "140.0"` and `"version": "0.4.0"`. In `package.json` set `"version": "0.4.0"`.

- [ ] **Step 2: Reconcile test copies** — In `tests/background.test.js`, DELETE the now-stale inline `rewriteUid` describe block and the `safeUpdate UID rewriting` block that re-implement helper logic (these are covered authoritatively by `tests/helpers.test.js`). Keep `mapForOptions`, `validateCalendars logic`, `options storage`, `sync queue`, and the new `pushItem idempotency` blocks. In `tests/options.test.js`, update the `validateSelections` copy to include `syncPastDays`/`syncFutureDays` in its returned options object and add one case asserting negative days produce an error, matching Task 7.

- [ ] **Step 3: Update README** — In `README.md`: change Requirements to "Betterbird or Thunderbird 140 or newer"; document the sync window (default past 30 days + all future, configurable in Options); add `helpers.js` to the Project Structure and the build command.

- [ ] **Step 4: Update CLAUDE.md** — Update the "Testing convention" section to note that pure logic now lives in `helpers.js` and is tested directly via `tests/helpers.test.js` (no longer copied), while integration logic (`pushItem`, `validateSelections`) still uses the inline-copy pattern. Add `helpers.js` to the architecture description (loaded before `background.js` in `background.html`).

- [ ] **Step 5: Full lint + test + build**

Run: `npm run lint` → Expected: no errors.
Run: `npm test` → Expected: PASS (all suites).
Run: `npm run build` → Expected: `sync-cal.xpi` created including `helpers.js`.

- [ ] **Step 6: Commit**

```bash
git add manifest.json package.json tests/background.test.js tests/options.test.js README.md CLAUDE.md
git commit -m "Bump to 0.4.0 (min 140); reconcile tests; update docs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npm run lint` clean, `npm test` all green, `npm run build` produces `sync-cal.xpi` containing `helpers.js`.
- [ ] Manual on Betterbird 140 (UNIGE→Gmail): a full "Sync now" completes with **no** `Create timed out`; events appear **once**; an edit propagates; a source delete removes the target copy; only events within the window (past 30 days + future) are synced; status line shows accurate counts.
- [ ] Out of scope (tracked, not done): cleaning pre-existing duplicates already in Gmail; `moz-src` import migration.

## Spec coverage map

| Spec §  | Task |
| --- | --- |
| 4.1 Reliable create | Task 3 |
| 4.2 Write pacing | Task 5 |
| 4.3 Sync window + orphan scoping | Task 5, Task 7 |
| 4.4 Idempotency | Task 4 |
| 4.5 Duplicate detection (UID-first, VEVENT-scoped) | Task 1 (extract), Task 4 (use) |
| 4.6 UID rewriting | Task 1 |
| 4.7 Echo suppression (drop isSyncing) | Task 6 |
| 4.8 Honest status | Task 6 |
| 4.9 Trim API + versioning | Task 8, Task 9 |
| 5 Testing | Task 1, Task 4, Task 9 |
