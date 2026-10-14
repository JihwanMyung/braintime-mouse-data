# Experiments and specimen history

The Experiment section records LumiCycle, IMG (imaging), qPCR, WB, IF/IHC, CSF sampling, and tissue storage. An animal can participate in multiple experiments, and an experiment can use several animals or previously collected specimens. Specimen records keep donor identity, tissue, collection time, storage temperature and location, and subsequent use together. A recorded storage temperature is preserved; a new-record default must not overwrite historical values.

## Source evidence and reviewed records

Imported spreadsheet observations remain read-only evidence until reviewed. A source row is not proof that an experiment was completed, and a mouse tag is not a stable database identity. Source review selects the experiment details and confirms an animal by its database SID. Ambiguous labels remain unresolved. Creating an experiment never silently changes an animal's living status, cage or genotype.

Historical tags can be reused. Confirm identity against the dated source, sex, birth date and other supporting records. A source tag match supplies a candidate only. Tissue labels, channel labels, cage positions and unnamed pooled samples must not be converted into individual mouse identities. Unknown dates, temperatures, quantities and animal links remain unknown.

## Read-only source acquisition

The acquisition workflow searches accessible Google Drive metadata, enumerates every tab, and exports each selected workbook as XLSX into a private directory outside the published application. Downloads are verified against returned byte counts and ZIP CRCs. Original XLSX files preserve source formatting and embedded objects. Cell values, formulas and hyperlinks are also retained in a compressed raw-row archive. Google Sheets export may sanitize tab names, so the extractor maps exported tabs by their order to the live metadata's exact sheet IDs and titles.

The initial acquisition covered 32 Experiment and related workbooks containing 698 tabs. Of those tabs, 222 produced structured or review observations; 476 were preserved as archive-only tabs. Archive-only tabs include schedules, administrative content, results and layouts without a supported animal-level parser. The extraction is not a claim that all 698 tabs have become validated experiments. Existing Animal Sheet history supplies a separate set of dated usage and contextual observations with its own source references.

The archive covers current workbooks and accessible historical workbook copies. It does not represent every Google Sheets edit revision. A revision listing and a CSV revision probe do not provide a complete, all-tab edit history.

## Extraction and duplicate handling

`scripts/import-experiment-sources.py` reads private XLSX exports and their metadata. It creates review observations for instrument channels, tissue sampling rows, assay runs and CSF sample columns. Other relevant matrices remain explicitly marked for source review. All original tabs remain available in the source archives regardless of parser coverage.

Only actual merged cells supply missing contextual values. Unmerged blank dates are not filled from preceding rows. Ambiguous date ranges retain their raw text and do not become a single inferred date. Instrument preparation blocks remain separate from per-channel tissue information. Original animal and sample fields are preserved even when recognizable tag text is extracted for candidate search.

Identical observation content across workbook copies is coalesced while every source reference is retained. Changed observations remain separate. Repeated identical observations within a sheet are retained separately. This is evidence deduplication, not a determination that two tissue samples or procedures are the same biological event.

## Private archive format

The complete extraction contains `sources`, `observations`, `coverage` and `caveats`. An observation includes its stable `source_id`, raw identifiers, assay labels, date or unknown date, tissue, storage, raw values and source provenance. It never supplies a confirmed mouse SID.

The compact application bundle additionally contains `contexts`. Repeated preparation metadata is stored once in this catalog and referenced by `context_id`. Each observation's `provenance_refs` contains tuples of `[source_catalog_index, sheet_id, sheet_name, range]`. The source catalog supplies the workbook ID, title, URL, snapshot date and archive checksum. Catalog order is significant and must be preserved. Source details and full references are expanded when the user opens or reviews an observation.

Application table mapping:

| Bundle field | Table |
| --- | --- |
| `observations` | `experiment_sources` |
| `sources` | `experiment_source_catalog` |
| `contexts` | `experiment_source_contexts` |
| `coverage` | `experiment_source_coverage` (one record) |

Source bundles, raw rows and XLSX files contain private research data. They belong in authenticated storage or local private archives, never in the public GitHub Pages assets. Reviewed experiments and specimens use the existing versioned husbandry-event storage, while source evidence remains additive and immutable.

## Validation

The focused Python tests cover ambiguous dates, merged-cell boundaries, animal versus sample labels, checkbox-only template rows, channel-specific tissues and preservation of recorded storage temperatures. Run them using the maintained Python interpreter with `openpyxl` installed:

```sh
python -m unittest discover -s tests -p test_import_experiment_sources.py
```

The source parser does not need to be installed into the public website. Browser-side tests separately verify experiment validation, participant links, specimen derivation, source review and access-controlled export.
