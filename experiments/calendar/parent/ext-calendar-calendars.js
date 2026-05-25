/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.log("[sync-cal] ext-calendar-calendars.js loading...");

var { ExtensionCommon: { ExtensionAPI } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils: { ExtensionError } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");

console.log("[sync-cal] ext-calendar-calendars.js importing calUtils...");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
console.log("[sync-cal] ext-calendar-calendars.js imports complete");

this.calendar_calendars = class extends ExtensionAPI {
  getAPI(context) {
    let baseURI = context.extension.rootURI.spec;
    if (!baseURI.endsWith("/")) {
      baseURI += "/";
    }
    const utilsPath = `${baseURI}experiments/calendar/ext-calendar-utils.js`;
    console.log("[sync-cal] calendar_calendars loading utils from:", utilsPath);

    const utils = {};
    try {
      Services.scriptloader.loadSubScript(utilsPath, utils);
      console.log("[sync-cal] calendar_calendars utils loaded successfully");
    } catch (e) {
      console.error("[sync-cal] calendar_calendars failed to load utils:", e);
      throw e;
    }

    const { unwrapCalendar, isOwnCalendar, convertCalendar } = utils;

    return {
      calendar: {
        calendars: {
          async query({ type, url, name, color, readOnly, enabled, visible }) {
            console.log("[sync-cal] calendar.calendars.query called");
            try {
              const calendars = cal.manager.getCalendars();
              console.log("[sync-cal] Found", calendars.length, "calendars");

              let pattern = null;
              if (url) {
                try {
                  pattern = new MatchPattern(url, { restrictSchemes: false });
                } catch {
                  throw new ExtensionError(`Invalid url pattern: ${url}`);
                }
              }

              return calendars
                .filter(calendar => {
                  let matches = true;

                  if (type && calendar.type != type) {
                    matches = false;
                  }

                  if (url && !pattern.matches(calendar.uri)) {
                    matches = false;
                  }

                  if (name && !new MatchGlob(name).matches(calendar.name)) {
                    matches = false;
                  }

                  if (color && color != calendar.getProperty("color")) {
                    // TODO need to normalize the color, including null to default color
                    matches = false;
                  }

                  if (enabled != null && calendar.getProperty("disabled") == enabled) {
                    matches = false;
                  }

                  if (visible != null && calendar.getProperty("calendar-main-in-composite") != visible) {
                    matches = false;
                  }

                  if (readOnly != null && calendar.readOnly != readOnly) {
                    matches = false;
                  }

                  return matches;
                })
                .map(calendar => convertCalendar(context.extension, calendar));
            } catch (e) {
              console.error("[sync-cal] calendar.calendars.query error:", e);
              throw e;
            }
          },
          async get(id) {
            if (id.endsWith("#cache")) {
              const calendar = unwrapCalendar(cal.manager.getCalendarById(id.substring(0, id.length - 6)));
              const own = calendar.offlineStorage && isOwnCalendar(calendar, context.extension);
              return own ? convertCalendar(context.extension, calendar.offlineStorage) : null;
            }
            const calendar = cal.manager.getCalendarById(id);
            return convertCalendar(context.extension, calendar);
          },
        },
      },
    };
  }
};
