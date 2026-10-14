#!/usr/bin/env python3
"""Append later imaging layouts to a frozen compact source bundle, never mutate it."""
import argparse
import collections
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('experiment_import', Path(__file__).with_name('import-experiment-sources.py'))
source_parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_parser)


def append_imaging(base_path, raw_rows_path, sheet_coverage_path, output_dir):
    base_path = Path(base_path)
    frozen_bytes = base_path.read_bytes()
    base = json.loads(frozen_bytes)
    result = copy.deepcopy(base)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = out/'experiment_sources_app.json'
    if target.exists() or target.resolve() == base_path.resolve():
        raise ValueError('Output must be a new file; frozen bundles cannot be replaced.')
    coverage = {(s['workbook_id'], s['sheet_id']): s for s in json.loads(Path(sheet_coverage_path).read_text())}
    tables = collections.defaultdict(list)
    with gzip.open(raw_rows_path, 'rt', encoding='utf-8') as stream:
        for line in stream:
            row = json.loads(line)
            if 'imaging' in row['sheet_name'].lower():
                tables[row['workbook_id'], row['sheet_id']].append(row)
    catalog = {s['file_id']: i for i, s in enumerate(base['sources'])}
    new_observations = {}
    contexts = {c['context_id']: c for c in base['contexts']}
    old_ids = {o['source_id'] for o in base['observations']}
    sheet_reports = []
    for (workbook, sheet_id), records in tables.items():
        title = records[0]['sheet_name']
        if workbook not in catalog:
            raise ValueError('Raw workbook is absent from the frozen catalog.')
        rows = [[] for _ in range(max(r['row'] for r in records))]
        for record in records:
            last = max((source_parser.column_index_from_string(c) for c in record['values']), default=0)
            row = [None] * last
            for col, value in record['values'].items():
                row[source_parser.column_index_from_string(col) - 1] = value
            rows[record['row'] - 1] = row
        resolved, _ = source_parser.merged_values(rows, coverage[workbook, sheet_id]['merged_ranges'])
        occurrences = collections.Counter()
        parsed = list(source_parser.parse_luc_imaging_blocks(title, rows, resolved))
        for cell_range, obs in parsed:
            fingerprint = source_parser.digest(obs)
            occurrences[fingerprint] += 1
            key = source_parser.digest(['imaging-layout-addendum-v1', title.strip(), fingerprint, occurrences[fingerprint]])
            source_id = 'experiment-source-' + key
            if source_id in old_ids:
                raise ValueError('Additive observation ID unexpectedly overlaps frozen observations.')
            ref = [catalog[workbook], sheet_id, title, cell_range]
            if source_id in new_observations:
                new_observations[source_id]['provenance_refs'].append(ref)
                continue
            preparation = obs['raw_values'].pop('preparation')
            context_id = source_parser.digest(preparation)
            contexts.setdefault(context_id, {'context_id': context_id, 'values': preparation})
            compact = {k: v for k, v in obs.items() if k not in ('animal_link_status', 'review_status') and v not in ('', None, [])}
            new_observations[source_id] = dict(source_id=source_id, workbook_id=workbook, sheet_id=sheet_id,
                sheet_name=title, range=cell_range, snapshot_date=base['sources'][catalog[workbook]]['snapshot_date'],
                **compact, context_id=context_id, provenance_refs=[ref])
        sheet_reports.append({'workbook_id': workbook, 'sheet_id': sheet_id, 'sheet_name': title,
                              'additive_observation_occurrences': len(parsed)})
    added = list(new_observations.values())
    result['observations'].extend(added)
    result['contexts'] = list(contexts.values())
    result['coverage'].update(unique_observations=len(result['observations']), preparation_contexts=len(contexts),
        observation_occurrences=base['coverage']['observation_occurrences'] + sum(r['additive_observation_occurrences'] for r in sheet_reports),
        observations_by_kind=dict(collections.Counter(o['kind'] for o in result['observations'])),
        imaging_layout_addendum={'unique_observations': len(added), 'source_sheets': len(sheet_reports),
                                 'observation_occurrences': sum(r['additive_observation_occurrences'] for r in sheet_reports)})
    result['caveats'].append('Later imaging blocks are appended as separate review evidence; decapitation, preparation, sample collection and donor identity are not inferred from each other.')
    prefix = len(base['observations'])
    assert result['observations'][:prefix] == base['observations']
    assert result['sources'] == base['sources']
    assert result['contexts'][:len(base['contexts'])] == base['contexts']
    assert len({o['source_id'] for o in result['observations']}) == len(result['observations'])
    assert base_path.read_bytes() == frozen_bytes
    data = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()
    target.write_bytes(data)
    with gzip.open(str(target)+'.gz', 'wb') as stream:
        stream.write(data)
    (out/'imaging_observations_addendum.json').write_text(json.dumps({'observations': added,
        'contexts': result['contexts'][len(base['contexts']):], 'sheets': sheet_reports}, ensure_ascii=False, separators=(',', ':')))
    report = {'base_sha256': hashlib.sha256(frozen_bytes).hexdigest(), 'expanded_sha256': hashlib.sha256(data).hexdigest(),
              'base_observations': prefix, 'added_observations': len(added), 'expanded_observations': len(result['observations']),
              'added_contexts': len(contexts) - len(base['contexts']), 'source_catalog_unchanged': True,
              'observation_prefix_unchanged': True, 'context_prefix_unchanged': True,
              'expanded_bytes': len(data), 'max_observation_bytes': max(len(json.dumps(o, ensure_ascii=False).encode()) for o in added),
              'added_occurrences': sum(r['additive_observation_occurrences'] for r in sheet_reports)}
    (out/'validation_report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return result, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True)
    parser.add_argument('--raw-rows', required=True)
    parser.add_argument('--sheet-coverage', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    append_imaging(args.base, args.raw_rows, args.sheet_coverage, args.output)
