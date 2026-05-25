const sourceSelect = document.getElementById("source-calendar");
const targetSelect = document.getElementById("target-calendar");
const filterInput = document.getElementById("calendar-filter");
const autoSyncToggle = document.getElementById("auto-sync");
const statusEl = document.getElementById("status");
const refreshButton = document.getElementById("refresh");
const saveButton = document.getElementById("save");
const syncButton = document.getElementById("sync-now");
const swapButton = document.getElementById("swap");
const pastDaysInput = document.getElementById("sync-past-days");
const futureDaysInput = document.getElementById("sync-future-days");

let calendars = [];
let selectedSource = "";
let selectedTarget = "";

function setStatus(message, isError) {
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#a23b2a" : "";
}

function formatCalendarLabel(calendar) {
  const bits = [calendar.name];
  if (calendar.readOnly) {
    bits.push("read-only");
  }
  if (calendar.type) {
    bits.push(calendar.type);
  }
  return bits.join(" | ");
}

function buildOptions(selectEl, list, options = {}) {
  const { disableReadOnly = false, selectedId = "" } = options;
  selectEl.textContent = "";

  for (const calendar of list) {
    const option = document.createElement("option");
    option.value = calendar.id;
    option.textContent = formatCalendarLabel(calendar);
    if (disableReadOnly && calendar.readOnly) {
      option.disabled = true;
    }
    selectEl.appendChild(option);
  }

  if (selectedId) {
    selectEl.value = selectedId;
  }
}

function getFilteredCalendars() {
  const query = filterInput.value.trim().toLowerCase();
  if (!query) {
    return calendars;
  }
  const selected = new Set([sourceSelect.value, targetSelect.value]);
  return calendars.filter(calendar => {
    if (selected.has(calendar.id)) {
      return true;
    }
    return calendar.name.toLowerCase().includes(query);
  });
}

function renderCalendars() {
  const filtered = getFilteredCalendars();
  const currentSource = sourceSelect.value || selectedSource;
  const currentTarget = targetSelect.value || selectedTarget;
  buildOptions(sourceSelect, filtered, { selectedId: currentSource });
  buildOptions(targetSelect, filtered, {
    selectedId: currentTarget,
    disableReadOnly: true
  });
}

async function loadCalendars() {
  setStatus("Loading calendars...");
  try {
    calendars = await fetchCalendars();
  } catch (err) {
    if ((err?.message || "").includes("cache not available")) {
      setStatus("Waiting for calendar cache...");
      return;
    }
    throw err;
  }
  if (!Array.isArray(calendars)) {
    throw new Error("Calendar API returned no list.");
  }
  calendars.sort((a, b) => a.name.localeCompare(b.name));
  renderCalendars();
  setStatus("Ready.");
}

async function fetchCalendars() {
  const stored = await browser.storage.local.get("calendarCache");
  const cache = stored.calendarCache;
  console.log("[sync-cal options] calendarCache:", cache);
  if (!cache) {
    throw new Error("Calendar cache not available yet.");
  }
  if (!cache.ok) {
    throw new Error(cache.error || "Calendar API not available.");
  }
  return cache.calendars || [];
}

async function loadOptions() {
  const stored = await browser.storage.local.get("options");
  const options = stored.options || {};
  selectedSource = options.sourceCalendarId || "";
  selectedTarget = options.targetCalendarId || "";
  autoSyncToggle.checked = options.autoSync !== false;
  pastDaysInput.value = Number.isInteger(options.syncPastDays) ? options.syncPastDays : 30;
  futureDaysInput.value = Number.isInteger(options.syncFutureDays) ? options.syncFutureDays : 0;
}

function validateSelections() {
  const sourceId = sourceSelect.value;
  const targetId = targetSelect.value;

  if (!sourceId || !targetId) {
    setStatus("Select both a source and a target calendar.", true);
    return null;
  }
  if (sourceId === targetId) {
    setStatus("Source and target must be different calendars.", true);
    return null;
  }

  const targetCal = calendars.find(calendar => calendar.id === targetId);
  if (targetCal && targetCal.readOnly) {
    setStatus("Target calendar must be writable.", true);
    return null;
  }

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
}

async function saveOptions() {
  const options = validateSelections();
  if (!options) {
    return;
  }

  await browser.storage.local.set({ options });
  selectedSource = options.sourceCalendarId;
  selectedTarget = options.targetCalendarId;
  setStatus("Saved. Changes will sync automatically.");
}

async function syncNow() {
  const options = validateSelections();
  if (!options) {
    return;
  }
  setStatus("Syncing...");
  // Write both in a single call to avoid triggering separate
  // options_changed and manual sync (which caused double full syncs).
  await browser.storage.local.set({ options, manualSyncRequest: Date.now() });
}

function swapCalendars() {
  const currentSource = sourceSelect.value;
  const currentTarget = targetSelect.value;
  sourceSelect.value = currentTarget;
  targetSelect.value = currentSource;
}

filterInput.addEventListener("input", () => {
  renderCalendars();
});

saveButton.addEventListener("click", () => {
  saveOptions().catch(err => {
    setStatus(`Failed to save options: ${err?.message || err}`, true);
    console.error(err);
  });
});

syncButton.addEventListener("click", () => {
  syncNow().catch(err => {
    setStatus(`Sync failed: ${err?.message || err}`, true);
    console.error(err);
  });
});

swapButton.addEventListener("click", () => {
  swapCalendars();
});

sourceSelect.addEventListener("change", () => {
  selectedSource = sourceSelect.value;
});

targetSelect.addEventListener("change", () => {
  selectedTarget = targetSelect.value;
});

async function init() {
  const manifest = browser.runtime.getManifest();
  document.getElementById("version").textContent = `v${manifest.version}`;

  await loadOptions();
  const stored = await browser.storage.local.get("calendarCache");
  if (!stored.calendarCache) {
    await browser.storage.local.set({ calendarCacheRefresh: Date.now() });
  }
  await loadCalendars();
}

init().catch(err => {
  setStatus(`Failed to load calendars: ${err?.message || err}`, true);
  console.error(err);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.calendarCache) {
    loadCalendars().catch(err => {
      setStatus(`Failed to refresh calendars: ${err?.message || err}`, true);
      console.error(err);
    });
  }
  if (changes.manualSyncStatus) {
    const status = changes.manualSyncStatus.newValue;
    if (!status) {
      return;
    }
    if (status.ok) {
      const c = status.counts;
      setStatus(c ? `Sync complete (${c.created} created, ${c.updated} updated, ${c.removed} removed).` : "Sync complete.");
    } else {
      setStatus(`Sync failed: ${status.error || "Unexpected error."}`, true);
    }
  }
});

refreshButton.addEventListener("click", () => {
  setStatus("Refreshing calendar list...");
  browser.storage.local.set({ calendarCacheRefresh: Date.now() }).catch(err => {
    setStatus(`Failed to refresh calendars: ${err?.message || err}`, true);
    console.error(err);
  });
});
