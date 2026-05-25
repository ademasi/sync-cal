/*
 * Calendar Sync Bridge
 * One-way sync from a source calendar to a target calendar.
 */

const DEFAULT_OPTIONS = {
  sourceCalendarId: "",
  targetCalendarId: "",
  autoSync: true
};

let cachedOptions = null;
let cachedMap = null;
let syncQueue = Promise.resolve();
let cacheRefreshInFlight = false;
let isSyncing = 0;

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

function rewriteUid(icalString, newUid) {
  // Replace UID line in iCal with a new one
  return icalString.replace(/^UID:[^\r\n]+(\r?\n)/m, `UID:${newUid}$1`);
}

function extractEventInfo(icalString) {
  // Extract SUMMARY (title) and DTSTART from iCal for duplicate detection
  const summaryMatch = icalString.match(/^SUMMARY[^:]*:(.+)$/m);
  const dtstartMatch = icalString.match(/^DTSTART[^:]*:(.+)$/m);
  return {
    title: summaryMatch ? summaryMatch[1].trim() : null,
    dtstart: dtstartMatch ? dtstartMatch[1].trim() : null
  };
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

async function safeCreate(targetCalendarId, sourceItem) {
  const format = sourceItem.format || "ical";
  // Generate a new UID to avoid conflicts with Exchange/TbSync style IDs
  const newUid = generateUid();
  const modifiedIcal = typeof sourceItem.item === "string"
    ? rewriteUid(sourceItem.item, newUid)
    : sourceItem.item;

  logInfo("Creating item", sourceItem.id, "->", newUid, "type:", sourceItem.type);
  isSyncing++;
  try {
    const result = await withTimeout(
      browser.calendar.items.create(targetCalendarId, {
        type: sourceItem.type,
        format,
        item: modifiedIcal
      }),
      30000,
      `Create timed out for ${sourceItem.id}`
    );
    logInfo("Created item", sourceItem.id, "->", result.id);
    return result;
  } finally {
    isSyncing--;
  }
}

async function safeUpdate(targetCalendarId, targetItemId, sourceItem) {
  const format = sourceItem.format || "ical";
  // Rewrite the UID to match the target item's UID. Without this,
  // the source UID overwrites the target's generated UID, causing
  // remote providers (CalDAV, Exchange) to create a duplicate.
  const modifiedIcal = typeof sourceItem.item === "string"
    ? rewriteUid(sourceItem.item, targetItemId)
    : sourceItem.item;
  isSyncing++;
  try {
    return await withTimeout(
      browser.calendar.items.update(targetCalendarId, targetItemId, {
        format,
        item: modifiedIcal
      }),
      30000,
      `Update timed out for ${targetItemId}`
    );
  } finally {
    isSyncing--;
  }
}

async function safeRemove(targetCalendarId, targetItemId) {
  isSyncing++;
  try {
    await withTimeout(
      browser.calendar.items.remove(targetCalendarId, targetItemId),
      30000,
      `Remove timed out for ${targetItemId}`
    );
  } finally {
    isSyncing--;
  }
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
  return { ok: true };
}

async function doFullSync(reason, force) {
  logInfo("doFullSync starting", { reason, force });
  const options = await getOptions();
  logInfo("Options:", { source: options.sourceCalendarId, target: options.targetCalendarId, autoSync: options.autoSync });
  if (!force && !options.autoSync) {
    logInfo("Sync skipped: autoSync disabled and not forced");
    return;
  }
  ensureCalendarApi();
  const validation = await validateCalendars(options);
  if (!validation.ok) {
    logInfo("Sync skipped:", validation.reason);
    if (validation.reason !== "missing") {
      throw new Error(`Calendar validation failed: ${validation.reason}`);
    }
    return;
  }

  const map = await getMap(options);
  const sourceItems = await browser.calendar.items.query({
    calendarId: options.sourceCalendarId,
    returnFormat: "ical"
  });
  logInfo(`Found ${sourceItems.length} source items`);

  const seen = new Set();
  let created = 0, updated = 0, failed = 0;
  for (const rawItem of sourceItems) {
    const item = await ensureItemData(rawItem);
    seen.add(item.id);
    const mappedTargetId = map.items[item.id];

    if (mappedTargetId) {
      try {
        await safeUpdate(options.targetCalendarId, mappedTargetId, item);
        updated++;
        continue;
      } catch (err) {
        logError("Update failed, will check for duplicate or recreate", item.id, err);
      }
    }

    // Check for existing duplicate in target calendar before creating
    const existingId = await findDuplicateInTarget(options.targetCalendarId, item);
    if (existingId) {
      logInfo("Found existing item, linking instead of creating", item.id, "->", existingId);
      map.items[item.id] = existingId;
      try {
        await safeUpdate(options.targetCalendarId, existingId, item);
        updated++;
      } catch (err) {
        logError("Update of existing duplicate failed", existingId, err);
        failed++;
      }
      continue;
    }

    try {
      const createdItem = await safeCreate(options.targetCalendarId, item);
      map.items[item.id] = createdItem.id;
      created++;
    } catch (err) {
      logError("Create failed", item.id, err);
      failed++;
    }
  }

  let removed = 0;
  for (const [sourceId, targetId] of Object.entries(map.items)) {
    if (!seen.has(sourceId)) {
      try {
        await safeRemove(options.targetCalendarId, targetId);
        removed++;
      } catch (err) {
        logError("Remove failed", targetId, err);
      }
      delete map.items[sourceId];
    }
  }

  await saveMap(map);
  logInfo("Full sync complete", { reason, created, updated, removed, failed });
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
  const mappedTargetId = map.items[item.id];

  if (mappedTargetId) {
    try {
      await safeUpdate(options.targetCalendarId, mappedTargetId, item);
      await saveMap(map);
      return;
    } catch (err) {
      logError("Update failed, will check for duplicate or recreate", item.id, err);
    }
  }

  // Check for existing duplicate before creating
  const existingId = await findDuplicateInTarget(options.targetCalendarId, item);
  if (existingId) {
    logInfo("Found existing item, linking instead of creating", item.id, "->", existingId);
    map.items[item.id] = existingId;
    try {
      await safeUpdate(options.targetCalendarId, existingId, item);
    } catch (err) {
      logError("Update of existing duplicate failed", existingId, err);
    }
    await saveMap(map);
    return;
  }

  const created = await safeCreate(options.targetCalendarId, item);
  map.items[item.id] = created.id;
  await saveMap(map);
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
    if (isSyncing > 0) return;
    enqueueSync(() => syncOneItem(item));
  }, { returnFormat: "ical" });

  browser.calendar.items.onUpdated.addListener(item => {
    if (isSyncing > 0) return;
    enqueueSync(() => syncOneItem(item));
  }, { returnFormat: "ical" });

  browser.calendar.items.onRemoved.addListener((calendarId, id) => {
    if (isSyncing > 0) return;
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
    await enqueueSync(() => doFullSync("manual", true), true);
    return { ok: true };
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
