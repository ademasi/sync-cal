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

  function targetIndexKey(icalString) {
    const info = extractEventInfo(icalString);
    return info.title && info.dtstart ? `${info.title}\0${info.dtstart}` : null;
  }

  function computeSyncRange(now, pastDays, futureDays) {
    const dayMs = 86400000;
    const rangeStart = toIcalUtc(new Date(now.getTime() - pastDays * dayMs));
    const rangeEnd = futureDays > 0
      ? toIcalUtc(new Date(now.getTime() + futureDays * dayMs))
      : null;
    return { rangeStart, rangeEnd };
  }

  return { unfoldIcal, rewriteUid, extractEventInfo, extractUid, toIcalUtc, computeSyncRange, targetIndexKey };
});
