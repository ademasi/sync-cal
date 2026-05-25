const {
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
