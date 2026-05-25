/**
 * Tests for background.js sync logic
 */

// Mock browser API
const mockStorage = {
  data: {},
  local: {
    get: jest.fn(async (keys) => {
      if (typeof keys === "string") {
        return { [keys]: mockStorage.data[keys] };
      }
      const result = {};
      for (const key of keys) {
        result[key] = mockStorage.data[key];
      }
      return result;
    }),
    set: jest.fn(async (items) => {
      Object.assign(mockStorage.data, items);
    }),
  },
  onChanged: {
    addListener: jest.fn(),
  },
};

const mockCalendar = {
  calendars: {
    get: jest.fn(),
    query: jest.fn(),
  },
  items: {
    query: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    onCreated: { addListener: jest.fn() },
    onUpdated: { addListener: jest.fn() },
    onRemoved: { addListener: jest.fn() },
  },
};

global.browser = {
  storage: mockStorage,
  calendar: mockCalendar,
  runtime: {
    onMessage: { addListener: jest.fn() },
  },
};

// Helper to reset mocks
function resetMocks() {
  mockStorage.data = {};
  jest.clearAllMocks();
}

describe("mapForOptions", () => {
  // Extract logic to test
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

  test("returns new map when map is null", () => {
    const options = { sourceCalendarId: "src-1", targetCalendarId: "tgt-1" };
    const result = mapForOptions(null, options);

    expect(result).toEqual({
      sourceCalendarId: "src-1",
      targetCalendarId: "tgt-1",
      items: {}
    });
  });

  test("returns new map when source calendar changes", () => {
    const existingMap = {
      sourceCalendarId: "src-old",
      targetCalendarId: "tgt-1",
      items: { "item-1": "mapped-1" }
    };
    const options = { sourceCalendarId: "src-new", targetCalendarId: "tgt-1" };
    const result = mapForOptions(existingMap, options);

    expect(result.sourceCalendarId).toBe("src-new");
    expect(result.items).toEqual({});
  });

  test("returns new map when target calendar changes", () => {
    const existingMap = {
      sourceCalendarId: "src-1",
      targetCalendarId: "tgt-old",
      items: { "item-1": "mapped-1" }
    };
    const options = { sourceCalendarId: "src-1", targetCalendarId: "tgt-new" };
    const result = mapForOptions(existingMap, options);

    expect(result.targetCalendarId).toBe("tgt-new");
    expect(result.items).toEqual({});
  });

  test("preserves existing map when calendars match", () => {
    const existingMap = {
      sourceCalendarId: "src-1",
      targetCalendarId: "tgt-1",
      items: { "item-1": "mapped-1", "item-2": "mapped-2" }
    };
    const options = { sourceCalendarId: "src-1", targetCalendarId: "tgt-1" };
    const result = mapForOptions(existingMap, options);

    expect(result).toBe(existingMap);
    expect(result.items).toEqual({ "item-1": "mapped-1", "item-2": "mapped-2" });
  });

  test("initializes items object if missing", () => {
    const existingMap = {
      sourceCalendarId: "src-1",
      targetCalendarId: "tgt-1",
    };
    const options = { sourceCalendarId: "src-1", targetCalendarId: "tgt-1" };
    const result = mapForOptions(existingMap, options);

    expect(result.items).toEqual({});
  });
});

describe("validateCalendars logic", () => {
  function validateCalendarsSync(options) {
    if (!options.sourceCalendarId || !options.targetCalendarId) {
      return { ok: false, reason: "missing" };
    }
    if (options.sourceCalendarId === options.targetCalendarId) {
      return { ok: false, reason: "same" };
    }
    return { ok: true };
  }

  test("fails when source is missing", () => {
    const result = validateCalendarsSync({ sourceCalendarId: "", targetCalendarId: "tgt-1" });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  test("fails when target is missing", () => {
    const result = validateCalendarsSync({ sourceCalendarId: "src-1", targetCalendarId: "" });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  test("fails when source and target are the same", () => {
    const result = validateCalendarsSync({ sourceCalendarId: "cal-1", targetCalendarId: "cal-1" });
    expect(result).toEqual({ ok: false, reason: "same" });
  });

  test("passes with valid different calendars", () => {
    const result = validateCalendarsSync({ sourceCalendarId: "src-1", targetCalendarId: "tgt-1" });
    expect(result).toEqual({ ok: true });
  });
});

describe("options storage", () => {
  beforeEach(resetMocks);

  test("getOptions returns defaults when nothing stored", async () => {
    const DEFAULT_OPTIONS = {
      sourceCalendarId: "",
      targetCalendarId: "",
      autoSync: true
    };

    mockStorage.data = {};
    const stored = await mockStorage.local.get("options");
    const options = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };

    expect(options).toEqual(DEFAULT_OPTIONS);
  });

  test("getOptions merges stored values with defaults", async () => {
    const DEFAULT_OPTIONS = {
      sourceCalendarId: "",
      targetCalendarId: "",
      autoSync: true
    };

    mockStorage.data = {
      options: { sourceCalendarId: "src-1", autoSync: false }
    };
    const stored = await mockStorage.local.get("options");
    const options = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };

    expect(options).toEqual({
      sourceCalendarId: "src-1",
      targetCalendarId: "",
      autoSync: false
    });
  });
});

describe("sync queue", () => {
  test("tasks execute sequentially", async () => {
    const order = [];
    let syncQueue = Promise.resolve();

    function enqueueSync(task) {
      syncQueue = syncQueue.then(() => task()).catch(() => {});
      return syncQueue;
    }

    enqueueSync(async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    enqueueSync(async () => {
      order.push(2);
    });
    enqueueSync(async () => {
      order.push(3);
    });

    await syncQueue;
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("pushItem idempotency (logic copy)", () => {
  // Mirrors background.js pushItem; keep in sync with the source.
  function makePushItem({ safeCreate, safeUpdate, findDuplicateInTarget, saveMap, generateUid }) {
    return async function pushItem(options, map, item, targetIndex = null) {
      let targetUid = map.items[item.id];
      if (!targetUid) {
        let existingUid;
        if (targetIndex) {
          existingUid = targetIndex.get(item.item) || null;
        } else {
          existingUid = await findDuplicateInTarget(options.targetCalendarId, item);
        }
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

  test("linked duplicate path saves mapping before updating", async () => {
    const callOrder = [];
    const map = { items: {} };
    const pushItem = makePushItem({
      safeCreate: jest.fn(),
      safeUpdate: jest.fn(async () => { callOrder.push("update"); }),
      findDuplicateInTarget: jest.fn().mockResolvedValue("existing-uid"),
      saveMap: jest.fn(async () => { callOrder.push("save"); }),
      generateUid: () => "SHOULD-NOT-BE-USED",
    });
    const result = await pushItem(options, map, { id: "src-1", item: "ICAL" });
    expect(result).toBe("updated");
    expect(map.items["src-1"]).toBe("existing-uid");
    expect(callOrder).toEqual(["save", "update"]);
  });
});
