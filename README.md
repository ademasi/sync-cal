# Calendar Sync Bridge

A Thunderbird add-on that provides one-way synchronization from a source calendar to a target calendar.

## Features

- **One-way sync**: Copies events and tasks from source to target calendar
- **Real-time sync**: Automatically syncs when items are created, updated, or deleted
- **Manual sync**: Trigger a full sync on demand
- **Calendar filtering**: Filter calendars by name in the options UI
- **Configurable sync window**: Limit how far back/forward events are synced (default: past 30 days plus all future events)

## Requirements

- Betterbird or Thunderbird 140 or newer
- `extensions.experiments.enabled` must be set to `true` in Config Editor

## Installation

### From XPI (recommended)

1. Download the latest `sync-cal.xpi` from releases
2. Open Thunderbird → Add-ons and Themes
3. Click the gear icon → Install Add-on From File
4. Select the downloaded XPI file

### Development (temporary)

1. Clone this repository
2. Open Thunderbird → Add-ons and Themes
3. Open the Add-ons Manager tools menu → Debug Add-ons
4. Click **Load Temporary Add-on** and select `manifest.json`

## Usage

1. Open the add-on options page (Add-ons → Calendar Sync Bridge → Options)
2. Select a **Source calendar** (where events come from)
3. Select a **Target calendar** (where events are copied to - must be writable)
4. Enable **Auto-sync changes** for real-time synchronization
5. Click **Save** to store settings and start syncing

### Notes

- Sync is one-way only: source → target
- Target calendar must be writable (not read-only)
- Deleting an event from the source will delete the synced copy from the target
- The add-on maintains a mapping between source and target items
- The sync window is configurable in Options via **Sync past days** / **Sync future days** (default: past 30 days plus all future events; setting future days to `0` means unlimited future)

## Building

Create an XPI package:

```bash
zip -r sync-cal.xpi manifest.json background.html background.js helpers.js \
  options.html options.js options.css icons/ experiments/ \
  -x "*.sys.mjs"
```

## Development

### Project Structure

```
sync-cal/
├── manifest.json           # Add-on manifest
├── background.html         # Background page
├── background.js           # Sync logic and event handling
├── helpers.js              # Pure shared helpers (UID/iCal parsing, sync range)
├── options.html            # Options UI
├── options.js              # Options page logic
├── options.css             # Options styling
├── icons/
│   └── sync.svg            # Add-on icon
└── experiments/
    └── calendar/
        ├── ext-calendar-utils.js           # Shared calendar utilities
        ├── parent/
        │   ├── ext-calendar-calendars.js   # Calendar API implementation
        │   └── ext-calendar-items.js       # Calendar items API implementation
        └── schema/
            ├── calendar-calendars.json     # Calendar API schema
            └── calendar-items.json         # Items API schema
```

### Linting

```bash
npm install
npm run lint
```

### Testing

```bash
npm test
```

## How Sync Works

1. **Startup**: Performs a full sync if auto-sync is enabled
2. **Real-time**: Listens for `onCreated`, `onUpdated`, `onRemoved` events on calendar items
3. **Item mapping**: Maintains a map of source item IDs to target item IDs in local storage
4. **Full sync**: Queries all source items, creates/updates in target, removes orphaned items

## License

MPL-2.0
