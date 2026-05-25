/*
 * Calendar Sync Bridge
 * One-way sync from a source calendar to a target calendar.
 */

const { rewriteUid, extractEventInfo, computeSyncRange } = globalThis.SyncCalHelpers;

const DEFAULT_OPTIONS = {
  sourceCalendarId: "",
  targetCalendarId: "",
  autoSync: true,
  syncPastDays: 30,
  syncFutureDays: 0
};

let cachedOptions = null;
let cachedMap = null;
let syncQueue = Promise.resolve();
let cacheRefreshInFlight = false;

function isCalendarApiAvailable() {
  return !!(browser.calendar && browser.calendar.calendars && browser.calendar.items);
}

function ensureCalendarApi() {
  if (!isCalendarApiAvailable()) {
    throw new Error("Calendar API unavailable in this Thunderbird build.");
  }
}

function logInfo(...args) {
  console.log("[sync-cal]", ...args);
}

function logError(...args) {
  console.error("[sync-cal]", ...args);
}

async function getOptions() {
  if (cachedOptions) {
    return cachedOptions;
  }
  const stored = await browser.storage.local.get("options");
  cachedOptions = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };
  return cachedOptions;
}

function resetOptionsCache() {
  cachedOptions = null;
}

function mapForOptions(map, options) {
  if (!map || map.sourceCalendarId !== options.sourceCalendarId || map.targetCalendarId !== options.targetCalendarId) {
    return {
      sourceCalendarId: options.sourceCalendarId,
      targetCalendarId: options.targetCalendarId,
      items: {}
    };
  }
  if (!map.items || typeof map.items !== "object") {
    map.items = {};
  }
  return map;
}

async function getMap(options) {
  if (cachedMap) {
    return mapForOptions(cachedMap, options);
  }
  const stored = await browser.storage.local.get("syncMap");
  cachedMap = mapForOptions(stored.syncMap, options);
  return cachedMap;
}

async function saveMap(map) {
  cachedMap = map;
  await browser.storage.local.set({ syncMap: map });
}

async function ensureItemData(item) {
  if (item && item.format && item.item) {
    return item;
  }
  return browser.calendar.items.get(item.calendarId, item.id, { returnFormat: "ical" });
}

function withTimeout(promise, ms, errorMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ]);
}

function generateUid() {
  return crypto.randomUUID() + "@sync-cal";
}

const CALDAV_PACING_MS = 200;
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function targetIndexKey(icalString) {
  const info = extractEventInfo(icalString);
  return info.title && info.dtstart ? `${info.title}\0${info.dtstart}` : null;
}

async function findDuplicateInTarget(targetCalendarId, sourceItem) {
  const sourceInfo = extractEventInfo(sourceItem.item);
  if (!sourceInfo.title || !sourceInfo.dtstart) {
    return null; // Can't match without title and start date
  }

  logInfo("Checking for duplicate:", sourceInfo.title, sourceInfo.dtstart);

  try {
    const targetItems = await browser.calendar.items.query({
      calendarId: targetCalendarId,
      returnFormat: "ical"
    });

    for (const targetItem of targetItems) {
      const itemData = await ensureItemData(targetItem);
      if (typeof itemData.item !== "string") continue;

      const targetInfo = extractEventInfo(itemData.item);
      if (targetInfo.title === sourceInfo.title && targetInfo.dtstart === sourceInfo.dtstart) {
        logInfo("Found duplicate:", targetItem.id);
        return targetItem.id;
      }
    }
  } catch (err) {
    logError("Error checking for duplicates", err);
  }

  return null;
}

// Upsert one source item into the target. Persists the assigned target UID
// BEFORE writing so a timed-out-but-committed write reconciles as an update
// next pass instead of duplicating. Returns "created" | "updated" | "failed".
async function pushItem(options, map, item, targetIndex = null) {
  let targetUid = map.items[item.id];

  if (!targetUid) {
    // Link to a pre-existing copy (e.g. created by older builds) if we can find one.
    // Prefer the pre-built in-memory index (full sync) to avoid a CalDAV query
    // per item; fall back to a single target query on the single-item path.
    let existingUid;
    if (targetIndex) {
      const key = targetIndexKey(item.item);
      existingUid = key ? (targetIndex.get(key) || null) : null;
    } else {
      existingUid = await findDuplicateInTarget(options.targetCalendarId, item);
    }
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

async function safeUpdate(targetCalendarId, targetItemId, sourceItem) {
  const format = sourceItem.format || "ical";
  // Rewrite the UID to match the target item's UID. Without this,
  // the source UID overwrites the target's generated UID, causing
  // remote providers (CalDAV, Exchange) to create a duplicate.
  const modifiedIcal = typeof sourceItem.item === "string"
    ? rewriteUid(sourceItem.item, targetItemId)
    : sourceItem.item;
  return withTimeout(
    browser.calendar.items.update(targetCalendarId, targetItemId, {
      format,
      item: modifiedIcal
    }),
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

function enqueueSync(task, propagateError = false) {
  const promise = syncQueue.then(() => task());
  if (propagateError) {
    syncQueue = promise.catch(err => {
      logError("Sync failed", err);
    });
    return promise;
  }
  syncQueue = promise.catch(err => {
    logError("Sync failed", err);
  });
  return syncQueue;
}

async function validateCalendars(options) {
  ensureCalendarApi();
  if (!options.sourceCalendarId || !options.targetCalendarId) {
    return { ok: false, reason: "missing" };
  }
  if (options.sourceCalendarId === options.targetCalendarId) {
    return { ok: false, reason: "same" };
  }
  let source = null;
  let target = null;
  try {
    source = await browser.calendar.calendars.get(options.sourceCalendarId);
    target = await browser.calendar.calendars.get(options.targetCalendarId);
  } catch (err) {
    logError("Calendar not found", err);
    return { ok: false, reason: "missing" };
  }
  if (!source) {
    return { ok: false, reason: "missing" };
  }
  if (!target || target.readOnly) {
    return { ok: false, reason: "target_read_only" };
  }
  return { ok: true, source, target };
}

async function doFullSync(reason, force) {
  logInfo("doFullSync starting", { reason, force });
  const options = await getOptions();
  logInfo("Options:", { source: options.sourceCalendarId, target: options.targetCalendarId, autoSync: options.autoSync });
  if (!force && !options.autoSync) {
    logInfo("Sync skipped: autoSync disabled and not forced");
    return { created: 0, updated: 0, removed: 0, failed: 0 };
  }
  ensureCalendarApi();
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

  // Pre-fetch the target once and index by SUMMARY+DTSTART so we link to any
  // pre-existing copies without issuing a CalDAV query per source item.
  const targetIndex = new Map();
  const existingTargetItems = await browser.calendar.items.query({
    calendarId: options.targetCalendarId,
    returnFormat: "ical"
  });
  for (const rawTarget of existingTargetItems) {
    const targetData = await ensureItemData(rawTarget);
    if (typeof targetData.item !== "string") {
      continue;
    }
    const key = targetIndexKey(targetData.item);
    if (key) {
      targetIndex.set(key, rawTarget.id);
    }
  }

  const seen = new Set();
  let created = 0, updated = 0, failed = 0;
  for (const rawItem of sourceItems) {
    const item = await ensureItemData(rawItem);
    seen.add(item.id);
    const result = await pushItem(options, map, item, targetIndex);
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
      logError("Source probe failed (keeping target copy)", sourceId, err);
      stillInSource = true;
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
}

async function syncOneItem(rawItem) {
  const options = await getOptions();
  if (!isCalendarApiAvailable()) {
    return;
  }
  const validation = await validateCalendars(options);
  if (!validation.ok) {
    return;
  }
  if (!options.autoSync) {
    return;
  }
  if (rawItem.calendarId !== options.sourceCalendarId) {
    return;
  }

  const map = await getMap(options);
  const item = await ensureItemData(rawItem);
  await pushItem(options, map, item);
}

async function removeOneItem(calendarId, itemId) {
  const options = await getOptions();
  if (!isCalendarApiAvailable()) {
    return;
  }
  const validation = await validateCalendars(options);
  if (!validation.ok) {
    return;
  }
  if (!options.autoSync) {
    return;
  }
  if (calendarId !== options.sourceCalendarId) {
    return;
  }

  const map = await getMap(options);
  const mappedTargetId = map.items[itemId];
  if (!mappedTargetId) {
    return;
  }

  try {
    await safeRemove(options.targetCalendarId, mappedTargetId);
  } catch (err) {
    logError("Remove failed", mappedTargetId, err);
  }
  delete map.items[itemId];
  await saveMap(map);
}

function setupListeners() {
  if (!isCalendarApiAvailable()) {
    logError("Calendar API unavailable; listeners not registered.");
    return;
  }
  browser.calendar.items.onCreated.addListener(item => {
    enqueueSync(() => syncOneItem(item));
  }, { returnFormat: "ical" });

  browser.calendar.items.onUpdated.addListener(item => {
    enqueueSync(() => syncOneItem(item));
  }, { returnFormat: "ical" });

  browser.calendar.items.onRemoved.addListener((calendarId, id) => {
    enqueueSync(() => removeOneItem(calendarId, id));
  });
}

async function listCalendarsForUi() {
  if (!isCalendarApiAvailable()) {
    return { ok: false, error: "Calendar API unavailable in this Thunderbird build." };
  }
  try {
    const calendars = await browser.calendar.calendars.query({});
    return { ok: true, calendars };
  } catch (err) {
    logError("List calendars failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
}

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

async function refreshCalendarCache() {
  if (cacheRefreshInFlight) {
    return;
  }
  cacheRefreshInFlight = true;
  try {
    logInfo("Refreshing calendar cache...");
    const response = await listCalendarsForUi();
    logInfo("Calendar list response:", response);
    const payload = {
      updatedAt: Date.now(),
      ok: response.ok,
      error: response.error || null,
      calendars: response.calendars || []
    };
    await browser.storage.local.set({ calendarCache: payload });
    logInfo("Calendar cache updated");
  } catch (err) {
    logError("refreshCalendarCache failed:", err);
    await browser.storage.local.set({
      calendarCache: {
        updatedAt: Date.now(),
        ok: false,
        error: err?.message || String(err),
        calendars: []
      }
    });
  } finally {
    cacheRefreshInFlight = false;
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.options) {
    resetOptionsCache();
    cachedMap = null;
    // Skip the options_changed sync when a manual sync is also requested
    // in the same change event (the manual sync with force=true covers it).
    if (!changes.manualSyncRequest) {
      enqueueSync(async () => {
        const options = await getOptions();
        if (options.autoSync) {
          await doFullSync("options_changed", false);
        }
      });
    }
  }
  if (changes.calendarCacheRefresh) {
    refreshCalendarCache().catch(err => logError("Calendar cache refresh failed", err));
  }
  if (changes.manualSyncRequest) {
    manualSyncForUi()
      .then(result => browser.storage.local.set({ manualSyncStatus: { ...result, updatedAt: Date.now() } }))
      .catch(err => browser.storage.local.set({
        manualSyncStatus: { ok: false, error: err?.message || String(err), updatedAt: Date.now() }
      }));
  }
  if (changes.syncMap) {
    cachedMap = null;
  }
});

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }
  if (message.type === "syncNow") {
    manualSyncForUi().then(sendResponse);
    return true;
  }
  if (message.type === "listCalendars") {
    listCalendarsForUi().then(sendResponse);
    return true;
  }
  return false;
});

globalThis.syncCalBridge = {
  listCalendars: listCalendarsForUi,
  manualSync: manualSyncForUi
};

logInfo("Background script loaded");
logInfo("Calendar API available:", isCalendarApiAvailable());
if (browser.calendar) {
  logInfo("browser.calendar exists, calendars:", !!browser.calendar.calendars, "items:", !!browser.calendar.items);
}
setupListeners();
enqueueSync(() => doFullSync("startup", false));
refreshCalendarCache().catch(err => logError("Initial calendar cache refresh failed", err));
