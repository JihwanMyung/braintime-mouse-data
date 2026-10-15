# Experiment history and source drafts

Experiments has two distinct layers. **Source history** preserves recovered observations and their workbook, sheet and cell references. **Managed experiments** are editable records. An imported source draft is a managed record with status `unreviewed`; it does not establish a completed experiment, a unique biological event or confirmed animal participation.

When no managed experiments exist, the page opens Source history. A mouse-specific view shows confirmed experiment or sample links first, otherwise possible source matches. Summary labels distinguish managed experiments, confirmed animals, imported records and possible source matches. A restricted source archive is shown as **Restricted**, never as an empty archive.

## Review and identity

- Exact SID, tag and alternate-ID matches are candidates only. Reused identifiers can match several animals; review the dated source before confirming a participant.
- Specimen identifiers marked `sample_label` are never matched as animal IDs. Group, pooled-material and control labels are not expanded into guessed animals.
- Opening or saving an unreviewed draft does not mark its source reviewed. Review its evidence and explicitly set the appropriate experiment status. A source already linked to a draft opens that record instead of creating another.
- Context supplements clarify block boundaries, timing or row labels. They link to affected original observations without deleting or invalidating the whole observation.

Compact drafts hold a source ID, fingerprint and minimal source metadata. The detail view retrieves full original values and provenance from the immutable archive when access permits. Missing, inconsistent or restricted references are reported explicitly; editing a draft does not copy hydrated raw evidence back into its payload.

## Timing and scope

Decapitation, exact sampling, preparation and later assay times remain separate. Source labels and raw times are preserved. Generated drafts leave normalized timestamps, ZT/CT and entrainment references null until reviewed; a date, backup timestamp or ambiguous clock value does not supply an exact sampling time or circadian phase.

The offline generator admits only its supported source kinds with recorded sample, measurement or result evidence. Unsupported layouts, context-only observations, blank templates and planned or cancelled procedures without result evidence remain in Source history. Historical storage does not establish current specimen stock. The process creates no specimen inventory, confirmed animal links, cage changes or animal end events.

`scripts/append-experiment-evidence.py` appends unreviewed context while preserving the existing archive prefixes and source catalog. `scripts/prepare-experiment-drafts.mjs` prepares deterministic, source-linked drafts; `scripts/prepare-experiment-draft-import.mjs` prepares guarded, create-only imports. All generated data and SQL remain in private output directories. Local preparation and tests are not evidence that a hosted import has completed.

See [source import](experiment-source-import.md) for archive publication and [experiment records](experiment-records.md) for manual experiment and specimen workflows.
