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

async function safeCreate(targetCalendarId, sourceItem) {
  const format = sourceItem.format || "ical";
  return browser.calendar.items.create(targetCalendarId, {
    type: sourceItem.type,
    format,
    item: sourceItem.item
  });
}

async function safeUpdate(targetCalendarId, targetItemId, sourceItem) {
  const format = sourceItem.format || "ical";
  return browser.calendar.items.update(targetCalendarId, targetItemId, {
    format,
    item: sourceItem.item
  });
}

async function safeRemove(targetCalendarId, targetItemId) {
  await browser.calendar.items.remove(targetCalendarId, targetItemId);
}

function enqueueSync(task) {
  syncQueue = syncQueue.then(() => task()).catch(err => {
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
  const options = await getOptions();
  if (!force && !options.autoSync) {
    return;
  }
  ensureCalendarApi();
  const validation = await validateCalendars(options);
  if (!validation.ok) {
    if (validation.reason !== "missing") {
      logInfo("Sync skipped:", validation.reason);
    }
    return;
  }

  const map = await getMap(options);
  const sourceItems = await browser.calendar.items.query({
    calendarId: options.sourceCalendarId,
    returnFormat: "ical"
  });

  const seen = new Set();
  for (const rawItem of sourceItems) {
    const item = await ensureItemData(rawItem);
    seen.add(item.id);
    const mappedTargetId = map.items[item.id];

    if (mappedTargetId) {
      try {
        await safeUpdate(options.targetCalendarId, mappedTargetId, item);
        continue;
      } catch (err) {
        logError("Update failed, recreating item", item.id, err);
      }
    }

    try {
      const created = await safeCreate(options.targetCalendarId, item);
      map.items[item.id] = created.id;
    } catch (err) {
      logError("Create failed", item.id, err);
    }
  }

  for (const [sourceId, targetId] of Object.entries(map.items)) {
    if (!seen.has(sourceId)) {
      try {
        await safeRemove(options.targetCalendarId, targetId);
      } catch (err) {
        logError("Remove failed", targetId, err);
      }
      delete map.items[sourceId];
    }
  }

  await saveMap(map);
  logInfo("Full sync complete", reason || "");
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
    } catch (err) {
      logError("Update failed, recreating item", item.id, err);
      const created = await safeCreate(options.targetCalendarId, item);
      map.items[item.id] = created.id;
    }
  } else {
    const created = await safeCreate(options.targetCalendarId, item);
    map.items[item.id] = created.id;
  }

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
    await enqueueSync(() => doFullSync("manual", true));
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
    enqueueSync(async () => {
      const options = await getOptions();
      if (options.autoSync) {
        await doFullSync("options_changed", false);
      }
    });
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
