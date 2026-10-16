# Physical cage placement

Cage and animal SIDs are permanent. A move changes the cage's recorded position, room and rack; its displayed cage tag follows the destination position label. A swap updates both cages and their current Stock animals' cage tags in one save. Previous animal records and source observations are retained. Removing a cage from a rack clears only physical placement, retaining its tag and animals.

`planCageMove` and `planCageRemoval` in `web/cage-movement.js` return cell drafts, a summary and the involved IDs. They never mutate the dataset. Before applying drafts to fresh records, call `validateCageMovementOccupancy`; then use the existing `applyCageSheetDrafts` validation and `saveDataset` version-checked atomic save. Missing, archived or inconsistent room/rack/position references and ambiguous current occupancy require review. Source-listed animal or cage labels never establish occupancy.

Apply `supabase/cage-position-guard.sql` after the base schema. It adds independent triggers and does not replace domain permission or export functions. A same-colony lock and deferred final-state check allow a complete atomic swap but reject a newly occupied destination. A no-value-change colony row write also prevents an administrative repeatable-read transaction from committing against obsolete placement. Existing ambiguous placements remain untouched, and unrelated edits to them remain possible. New placement, restoration, reactivation, or a Stock animal newly making an ended cage current is checked. Ended/inactive cages without Stock residents do not count as current occupancy.

## Staged mouse moves

`planMouseMove(dataset, mouseSid, destinationCageSid, options)` is a pure planner. It returns a `mouse_move` or `noop`, the old and new cage SIDs, a summary, `readDependencies`, and one `mice.cage_sid` assignment plus any source-field fills described below. Options are `sourceCageSid` (an optional check of the actual old assignment), `effectiveDate` (`YYYY-MM-DD`, or `null` to use the save date in Taipei), and an optional exact `sourceMatch:{locationId,tag,sourceCell}`. The draft's `mouseMove` proof retains schema version 1, permanent mouse SID, old/new cage SIDs, and the original `physical_tag`, `sex`, and `date_of_birth`. A changed comment, genotype, or manager does not invalidate that identity proof.

The mouse must be a unique, real, unarchived Stock record. The target must be a registered Active/Occupied cage with valid current housing, or an active cage explicitly off the rack. Missing, derived, archived, withdrawn, ambiguous, or historical targets require review. Historical dataset projections cannot be edited. No label similarity, numeric suffix, genotype, or source-only animal creates an identity.

A current literal source observation may identify a unique Stock record whose old cage SID is unregistered or legacy. This route must carry `sourceMatch`, which is rechecked against the retained source cell and current identifier matching. The event retains the mouse's actual prior recorded cage SID; the source cell never silently establishes an old managed cage assignment.

An explicit source-matched move also stages known earmark, DOB and source note into the mouse's corresponding **blank** fields. These `sourceFill:true` companion drafts have ordinary field CAS, the same source match and `overrideSource:true`. Already recorded values and intentionally cleared override fields are retained. The fresh source value must still match before Save; it is never inferred. Returning to the original cage removes unchanged automatic-fill drafts. The movement event retains the sanitized source cell, tag, location, earmark, DOB and note in `source_observation`, even where an existing mouse note was preserved instead of replaced. No source record is modified.

`planMouseMoveToPosition(dataset, mouseSid, locationId, options)` targets a physical position. It uses its existing current cage when there is one. Otherwise the caller supplies one stable `cageSid`, and the planner prepends this creation descriptor:

```js
{type:'cages', id:cageSid, field:'$create', base:null,
 value:{cage_sid:cageSid, cage_tag:position.label, state:'Active',
        record_origin:'app_created', location_id:position.location_id,
        room_id:position.room_id, rack_id:position.rack_id,
        cage_sheet_source_location_id:position.location_id}}
```

Only the dragged mouse is assigned. Other observations remain unassigned. The marker permits the source-observation overlay at that creation position without adding source occupants to ordinary registered cages. Keep unsaved cage details and whole-cage movement disabled until Save; reuse its stable creation descriptor when staging additional mice into it.

Before saving, load fresh data and call `validateMouseMoveDrafts(fresh, allDrafts)`. It validates creation schema, SID uniqueness, final destination occupancy, staged cage positions, mouse identity, old cage CAS, and current source matches. Existing exact-created records and already-applied mouse assignments are idempotent; the completed-move exception requires the same target and an explicit saved `cage_sheet_overrides.cage_sid:true` marker before an old source observation can be absent. Keep original identity/base guards when other fields are edited or a mouse is dragged again before Save.

The applying layer requires both mouse and housing/cage permissions, derives `cage_tag` from the final target, sets `cage_sheet_overrides.cage_sid:true`, and appends `buildMouseMoveEvent(before, after, mouseDraft, {at,eventId?})`. The helper returns `null` for an already-applied move. Otherwise it records old/new cage IDs and housing labels, one valid effective date no earlier than DOB or later than the save date, and unchanged source evidence. A missing old cage yields an unknown old housing path, not an invented location.

Use `getMouseMoveReadDependencies(fresh, allDrafts)` for unchanged source/target cage, position, rack, room, mouse and source-match dependencies. It also covers whole-cage old/new paths and source locations for ordinary matched note/ear/DOB edits. Send those expected-version dependencies with the changed cage, mouse and husbandry records in the same atomic `saveDataset(next,{readDependencies})` call. The newly created cage is guarded by its creation write, not an existing-record dependency. Source evidence and earlier events are never rewritten. A failed validation or save leaves the draft available for review.

Verification: `node --test tests/cage-movement.test.mjs` on the repository's current Node runtime (web `.js` files use ESM syntax). Tests cover registered and unlinked positions, exact and ambiguous matches, concurrent changes, staged cage moves, creation collisions, dated events, history preservation and idempotent retries.
