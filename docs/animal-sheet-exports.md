# Current Animal Sheet exports

`web/animal-sheet-export.js` projects a supplied normalized dataset without changing it or making network requests. Fetch the authorized, fresh current-housing export before calling it in cloud mode. Pass the server's `captured_at` as `capturedAt`; the function does not know whether local data is current.

```js
const projection = projectAnimalSheet(dataset, {
  capturedAt: response.captured_at,
  roomId: '', rackId: '', cageIds: [], mouseIds: [],
  entityTypes: ['mice', 'cages', 'locations', 'light_events']
});
const xlsx = createAnimalSheetXlsx(projection); // Blob, real OOXML .xlsx
const html = animalSheetPrintHTML(projection, {logoUrl});
```

The return value has `title`, `capturedAt`, `scope`, `counts`, `warnings`, `rows`, `groups` and `sheets`. Counts distinguish real room/rack IDs from display groups, including the unassigned group. `sheets` is the same normalized input accepted by the generic workbook writer.

Current occupancy uses nonarchived Stock mice only. Historical cage rosters and source candidate IDs never become assignments. Missing cage records can produce explicitly labeled derived cages. Inactive cages linked to retained positions remain visible; dangling, archived or conflicting parent references are flagged. Empty app-created positions and unlinked source positions retain distinct labels. Selected mouse IDs intersect the other filters; selected uncaged animals remain visible unless a room/rack/cage filter excludes them. Cage manager resolution and total occupancy use all current residents even when only selected mice are printed.

The form retains sorted recorded row/column coordinates in two-column panels. A sparse grid gap says “No position record”, rather than asserting an empty physical position. Missing coordinates use a separate section. Empty rooms/racks remain visible in unfiltered exports. Printed cohorts continue in cards of at most eight mice.

Light applicability uses the capture timestamp in each recorded time zone, with Asia/Taipei as the default and explicitly flagged invalid-zone fallback. Inclusive and exclusive end-date semantics are preserved. Undated schedules do not establish current lighting. Overlaps, planned schedules, zero-valued quantities and unverified exposure remain explicit.

Optional `dateFrom`/`dateTo` limit supporting tables by documented domain dates only, never import or modification timestamps. They do not change the current map or reconstruct past occupancy. Rooms/racks/positions are reference tables and have no domain-date filter. The cloud current-housing endpoint intentionally does not accept historical date filters. Use the separate authorized records endpoint for historical exports.

## Generic record workbooks and print previews

```js
createWorkbookXlsx({
  title: 'Selected records', capturedAt,
  sheets: [{name: 'Records', rows: [headers, ...rows]}]
});
animalSheetPrintHTML({title, capturedAt, sheets}, {logoUrl});
```

`createWorkbookXlsx` is also exported by `web/workbook-export.js`. Sheets accept scalar cell values plus JSON-serializable objects, `widths`, `rowHeights` (zero-based arrays), `merges` (A1 ranges), `cellStyles` (A1 keys, style IDs 0–5), `frozenRows` and `autoFilter`. Style IDs are body, header, section, note, title and warning. Sheet names are sanitized and deduplicated. Strings, including numeric IDs and formula-like text, remain literal inline strings; numbers and booleans retain their types. Invalid XML controls are removed. Values exceeding Excel's 32,767-character cell limit and oversized rows/columns produce an error directing the caller to JSON, not silent truncation.

The workbook is a standards-based ZIP package using stored entries and CRC32, generated locally with no remote library. The HTML is a print preview; a PDF is created by the browser's native Print → Save as PDF action. It is not a direct PDF serializer. No export helper downloads, prints, uploads or transmits a record on its own.
