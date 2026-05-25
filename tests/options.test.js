/**
 * Tests for options.js UI logic
 */

describe("formatCalendarLabel", () => {
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

  test("formats basic calendar", () => {
    const calendar = { name: "Personal", type: "caldav" };
    expect(formatCalendarLabel(calendar)).toBe("Personal | caldav");
  });

  test("formats read-only calendar", () => {
    const calendar = { name: "Holidays", type: "ics", readOnly: true };
    expect(formatCalendarLabel(calendar)).toBe("Holidays | read-only | ics");
  });

  test("formats calendar without type", () => {
    const calendar = { name: "Local" };
    expect(formatCalendarLabel(calendar)).toBe("Local");
  });

  test("formats read-only calendar without type", () => {
    const calendar = { name: "Shared", readOnly: true };
    expect(formatCalendarLabel(calendar)).toBe("Shared | read-only");
  });
});

describe("getFilteredCalendars", () => {
  function getFilteredCalendars(calendars, query, selectedIds) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return calendars;
    }
    const selected = new Set(selectedIds);
    return calendars.filter(calendar => {
      if (selected.has(calendar.id)) {
        return true;
      }
      return calendar.name.toLowerCase().includes(normalizedQuery);
    });
  }

  const calendars = [
    { id: "1", name: "Personal" },
    { id: "2", name: "Work" },
    { id: "3", name: "Holidays" },
    { id: "4", name: "Personal Projects" },
  ];

  test("returns all calendars when query is empty", () => {
    const result = getFilteredCalendars(calendars, "", []);
    expect(result).toHaveLength(4);
  });

  test("filters calendars by name", () => {
    const result = getFilteredCalendars(calendars, "personal", []);
    expect(result).toHaveLength(2);
    expect(result.map(c => c.name)).toEqual(["Personal", "Personal Projects"]);
  });

  test("always includes selected calendars", () => {
    const result = getFilteredCalendars(calendars, "work", ["1"]);
    expect(result).toHaveLength(2);
    expect(result.map(c => c.id)).toContain("1");
    expect(result.map(c => c.id)).toContain("2");
  });

  test("case insensitive filtering", () => {
    const result = getFilteredCalendars(calendars, "WORK", []);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Work");
  });
});

describe("validateSelections", () => {
  function validateSelections(sourceId, targetId, calendars, autoSync, pastDays, futureDays) {
    if (!sourceId || !targetId) {
      return { error: "Select both a source and a target calendar." };
    }
    if (sourceId === targetId) {
      return { error: "Source and target must be different calendars." };
    }

    const targetCal = calendars.find(calendar => calendar.id === targetId);
    if (targetCal && targetCal.readOnly) {
      return { error: "Target calendar must be writable." };
    }

    if (!Number.isInteger(pastDays) || pastDays < 0 || !Number.isInteger(futureDays) || futureDays < 0) {
      return { error: "Sync window days must be whole numbers ≥ 0." };
    }

    return {
      options: {
        sourceCalendarId: sourceId,
        targetCalendarId: targetId,
        autoSync: autoSync,
        syncPastDays: pastDays,
        syncFutureDays: futureDays
      }
    };
  }

  const calendars = [
    { id: "1", name: "Personal", readOnly: false },
    { id: "2", name: "Holidays", readOnly: true },
  ];

  test("fails when source is not selected", () => {
    const result = validateSelections("", "1", calendars, true, 30, 0);
    expect(result.error).toBe("Select both a source and a target calendar.");
  });

  test("fails when target is not selected", () => {
    const result = validateSelections("1", "", calendars, true, 30, 0);
    expect(result.error).toBe("Select both a source and a target calendar.");
  });

  test("fails when source and target are the same", () => {
    const result = validateSelections("1", "1", calendars, true, 30, 0);
    expect(result.error).toBe("Source and target must be different calendars.");
  });

  test("fails when target is read-only", () => {
    const result = validateSelections("1", "2", calendars, true, 30, 0);
    expect(result.error).toBe("Target calendar must be writable.");
  });

  test("fails when past days is negative", () => {
    const result = validateSelections("2", "1", calendars, false, -5, 0);
    expect(result.error).toBe("Sync window days must be whole numbers ≥ 0.");
  });

  test("returns options when valid", () => {
    const result = validateSelections("2", "1", calendars, false, 30, 0);
    expect(result.options).toEqual({
      sourceCalendarId: "2",
      targetCalendarId: "1",
      autoSync: false,
      syncPastDays: 30,
      syncFutureDays: 0
    });
  });
});
