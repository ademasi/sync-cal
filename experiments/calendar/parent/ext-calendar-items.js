/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.log("[sync-cal] ext-calendar-items.js loading...");

var { ExtensionCommon: { ExtensionAPI, EventManager } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils: { ExtensionError } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");

console.log("[sync-cal] ext-calendar-items.js importing calUtils...");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
console.log("[sync-cal] ext-calendar-items.js imports complete");

// CalDAV's adoptItem promise can hang when the post-PUT multiget fails to
// notify the operation listener (observed on TB/BB 140 with Google CalDAV).
// Resolve from the onAddItem observer, which fires when the item actually
// lands in the calendar, and race it against adoptItem's own settlement.
function adoptItemReliably(calendar, item) {
  const expectedUid = item.id;
  const setTimeoutFn = typeof setTimeout === "function" ? setTimeout : null;
  const clearTimeoutFn = typeof clearTimeout === "function" ? clearTimeout : null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const observer = cal.createAdapter(Ci.calIObserver, {
      onAddItem(addedItem) {
        if (!settled && addedItem && addedItem.id === expectedUid) {
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
        // adoptItem may resolve with undefined on some CalDAV providers; resolve
        // null so the non-item guard in create() throws a recoverable error
        // rather than silently accepting a non-item value.
        result => finish(() => resolve(result || null)),
        err => finish(() => reject(err))
      );
  });
}

this.calendar_items = class extends ExtensionAPI {
  getAPI(context) {
    let baseURI = context.extension.rootURI.spec;
    if (!baseURI.endsWith("/")) {
      baseURI += "/";
    }
    const utilsPath = `${baseURI}experiments/calendar/ext-calendar-utils.js`;
    console.log("[sync-cal] calendar_items loading utils from:", utilsPath);

    const utils = {};
    try {
      Services.scriptloader.loadSubScript(utilsPath, utils);
      console.log("[sync-cal] calendar_items utils loaded successfully");
    } catch (e) {
      console.error("[sync-cal] calendar_items failed to load utils:", e);
      throw e;
    }

    const { getResolvedCalendarById, getCachedCalendar, isCachedCalendar, isOwnCalendar, propsToItem, convertItem, convertAlarm } = utils;

    return {
      calendar: {
        items: {
          async query(queryProps) {
            let calendars = [];
            if (typeof queryProps.calendarId == "string") {
              calendars = [getResolvedCalendarById(context.extension, queryProps.calendarId)];
            } else if (Array.isArray(queryProps.calendarId)) {
              calendars = queryProps.calendarId.map(calendarId => getResolvedCalendarById(context.extension, calendarId));
            } else {
              calendars = cal.manager.getCalendars().filter(calendar => !calendar.getProperty("disabled"));
            }


            let calendarItems;
            if (queryProps.id) {
              calendarItems = await Promise.all(calendars.map(calendar => calendar.getItem(queryProps.id)));
            } else {
              calendarItems = await Promise.all(calendars.map(async calendar => {
                let filter = Ci.calICalendar.ITEM_FILTER_COMPLETED_ALL;
                if (queryProps.type == "event") {
                  filter |= Ci.calICalendar.ITEM_FILTER_TYPE_EVENT;
                } else if (queryProps.type == "task") {
                  filter |= Ci.calICalendar.ITEM_FILTER_TYPE_TODO;
                } else {
                  filter |= Ci.calICalendar.ITEM_FILTER_TYPE_ALL;
                }

                if (queryProps.expand) {
                  filter |= Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
                }

                const rangeStart = queryProps.rangeStart ? cal.createDateTime(queryProps.rangeStart) : null;
                const rangeEnd = queryProps.rangeEnd ? cal.createDateTime(queryProps.rangeEnd) : null;

                return calendar.getItemsAsArray(filter, queryProps.limit ?? 0, rangeStart, rangeEnd);
              }));
            }

            return calendarItems.flat().map(item => convertItem(item, queryProps, context.extension));
          },
          async get(calendarId, id, options) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);
            const item = await calendar.getItem(id);
            return convertItem(item, options, context.extension);
          },
          async create(calendarId, createProperties) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);
            const item = propsToItem(createProperties);
            item.calendar = calendar.superCalendar;

            if (createProperties.metadata && isOwnCalendar(calendar, context.extension)) {
              const cache = getCachedCalendar(calendar);
              cache.setMetaData(item.id, JSON.stringify(createProperties.metadata));
            }

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
          },
          async update(calendarId, id, updateProperties) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);

            const oldItem = await calendar.getItem(id);
            if (!oldItem) {
              throw new ExtensionError("Could not find item " + id);
            }
            if (oldItem.isEvent()) {
              updateProperties.type = "event";
            } else if (oldItem.isTodo()) {
              updateProperties.type = "task";
            } else {
              throw new ExtensionError(`Encountered unknown item type for ${calendarId}/${id}`);
            }

            const newItem = propsToItem(updateProperties);
            newItem.calendar = calendar.superCalendar;

            if (updateProperties.metadata && isOwnCalendar(calendar, context.extension)) {
              // TODO merge or replace?
              const cache = getCachedCalendar(calendar);
              cache.setMetaData(newItem.id, JSON.stringify(updateProperties.metadata));
            }

            const modifiedItem = await calendar.modifyItem(newItem, oldItem);
            return convertItem(modifiedItem, updateProperties, context.extension);
          },
          async move(fromCalendarId, id, toCalendarId) {
            if (fromCalendarId == toCalendarId) {
              return;
            }

            const fromCalendar = cal.manager.getCalendarById(fromCalendarId);
            const toCalendar = cal.manager.getCalendarById(toCalendarId);
            const item = await fromCalendar.getItem(id);

            if (!item) {
              throw new ExtensionError("Could not find item " + id);
            }

            if (isOwnCalendar(toCalendar, context.extension) && isOwnCalendar(fromCalendar, context.extension)) {
              // TODO doing this first, the item may not be in the db and it will fail. Doing this
              // after addItem, the metadata will not be available for the onCreated listener
              const fromCache = getCachedCalendar(fromCalendar);
              const toCache = getCachedCalendar(toCalendar);
              toCache.setMetaData(item.id, fromCache.getMetaData(item.id));
            }
            await toCalendar.addItem(item);
            await fromCalendar.deleteItem(item);
          },
          async remove(calendarId, id) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);

            const item = await calendar.getItem(id);
            if (!item) {
              throw new ExtensionError("Could not find item " + id);
            }
            await calendar.deleteItem(item);
          },

          async getCurrent(options) {
            try {
              // TODO This seems risky, could be null depending on remoteness
              const item = context.browsingContext.embedderElement.ownerGlobal.calendarItem;
              return convertItem(item, options, context.extension);
            } catch (e) {
              console.error(e);
              return null;
            }
          },

          onCreated: new EventManager({
            context,
            name: "calendar.items.onCreated",
            register: (fire, options) => {
              const observer = cal.createAdapter(Ci.calIObserver, {
                onAddItem: item => {
                  fire.sync(convertItem(item, options, context.extension));
                },
              });

              cal.manager.addCalendarObserver(observer);
              return () => {
                cal.manager.removeCalendarObserver(observer);
              };
            },
          }).api(),

          onUpdated: new EventManager({
            context,
            name: "calendar.items.onUpdated",
            register: (fire, options) => {
              const observer = cal.createAdapter(Ci.calIObserver, {
                onModifyItem: (newItem, _oldItem) => {
                  // TODO calculate changeInfo
                  const changeInfo = {};
                  fire.sync(convertItem(newItem, options, context.extension), changeInfo);
                },
              });

              cal.manager.addCalendarObserver(observer);
              return () => {
                cal.manager.removeCalendarObserver(observer);
              };
            },
          }).api(),

          onRemoved: new EventManager({
            context,
            name: "calendar.items.onRemoved",
            register: fire => {
              const observer = cal.createAdapter(Ci.calIObserver, {
                onDeleteItem: item => {
                  fire.sync(item.calendar.id, item.id);
                },
              });

              cal.manager.addCalendarObserver(observer);
              return () => {
                cal.manager.removeCalendarObserver(observer);
              };
            },
          }).api(),

          onAlarm: new EventManager({
            context,
            name: "calendar.items.onAlarm",
            register: (fire, options) => {
              const observer = {
                QueryInterface: ChromeUtils.generateQI(["calIAlarmServiceObserver"]),
                onAlarm(item, alarm) {
                  fire.sync(convertItem(item, options, context.extension), convertAlarm(item, alarm));
                },
                onRemoveAlarmsByItem(_item) {},
                onRemoveAlarmsByCalendar(_calendar) {},
                onAlarmsLoaded(_calendar) {},
              };

              const alarmsvc = Cc["@mozilla.org/calendar/alarm-service;1"].getService(
                Ci.calIAlarmService
              );

              alarmsvc.addObserver(observer);
              return () => {
                alarmsvc.removeObserver(observer);
              };
            },
          }).api(),
        },
      },
    };
  }
};
