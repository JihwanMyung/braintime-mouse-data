#!/usr/bin/env python3
"""Append bounded, unreviewed source context to a frozen Experiment archive.

Offline only. Does not create experiments, specimens, donors or animal events.
The original parser and published observation prefix are never changed.
"""
import argparse
import collections
import copy
import datetime as dt
import gzip
import hashlib
import json
import os
import re
from pathlib import Path

VERSION = 'experiment-evidence-completion-v1'
WARNING = ('Unreviewed source context, not confirmation of a completed experiment or animal identity. '
           'Preparation, decapitation, sampling, circadian phase and entrainment remain distinct. '
           'Blank unmerged dates and identities remain unknown.')
TABLE_NAMES = {'tst/fst/spt', 'tst/fst', 'culture', 'hydrocephalus mice', 'nanodrop (cdna)'}
AD_NAMES = {'sample', '(1)sp/lp/ep/ll study', '(2)ckd', '(3)summer/winter', 'current mouse', 'motality rate'}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def norm(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip().lower()


def meaningful(value):
    return value is not None and not isinstance(value, bool) and str(value).strip() != ''


def colnum(column):
    result = 0
    for char in column:
        result = result * 26 + ord(char) - 64
    return result


def colname(number):
    result = ''
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def bounds(value):
    match = re.fullmatch(r'([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?', value)
    if not match:
        raise ValueError('Invalid source range: ' + str(value))
    a, b, c, d = match.groups()
    return colnum(a), int(b), colnum(c or a), int(d or b)


def date_value(value):
    # Accept a complete date or source ISO datetime, never a range or guessed year.
    match = re.fullmatch(r'((?:19|20)\d\d)[-/.](\d{1,2})[-/.](\d{1,2})(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z)?)?', str(value or '').strip())
    if not match:
        return None
    try:
        return dt.date(*map(int, match.groups())).isoformat()
    except ValueError:
        return None


def resolved_rows(rows, merges):
    resolved = {number: dict(row['values']) for number, row in rows.items()}
    for ref in merges:
        c1, r1, c2, r2 = bounds(ref)
        anchor = rows.get(r1, {}).get('values', {}).get(colname(c1))
        if anchor is None:
            continue
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                resolved.setdefault(r, {}).setdefault(colname(c), anchor)
    return resolved


def source_rows(rows, start, end):
    return [{'offset': n - start, 'values': copy.deepcopy(rows[n]['values']),
             'formulas': copy.deepcopy(rows[n].get('formulas', {})),
             'hyperlinks': copy.deepcopy(rows[n].get('hyperlinks', {}))}
            for n in sorted(rows) if start <= n <= end]


def fields(headers, values):
    return {f'{column} · {headers.get(column) or "Column " + column}': value
            for column, value in sorted(values.items(), key=lambda item: colnum(item[0]))}


def field(headers, pattern):
    return next((c for c, label in headers.items() if re.search(pattern, norm(label))), None)


def overlaps(index, key, start, end):
    return sorted({source_id for lo, hi, source_id in index.get(key, []) if lo <= end and hi >= start})


def context(rows, headers_at, start, end, merges):
    relevant = [ref for ref in merges if bounds(ref)[1] <= end and bounds(ref)[3] >= start]
    anchors = {}
    for ref in relevant:
        c, r, _, _ = bounds(ref)
        if not start <= r <= end:
            anchors[f'{colname(c)}{r}'] = rows.get(r, {}).get('values', {}).get(colname(c))
    return {'Source header rows': [{'row': n, **copy.deepcopy(rows[n])} for n in headers_at if n in rows],
            'Source rows (offset from referenced range)': source_rows(rows, start, end),
            'Actual merged ranges': relevant, 'Outside-range merge anchors': anchors}


def instrument_evidence(sheet, rows, index):
    """Recover changed block boundaries and omitted tails, never a donor identity."""
    name = norm(sheet['sheet_name'])
    if not re.search(r'lumicycle|imaging|kronos', name):
        return
    header_at = next((n for n in sorted(rows) if n <= 12 and any(norm(v) == 'date (prep)' for v in rows[n]['values'].values())), None)
    if header_at is None:
        return
    headers = rows[header_at]['values']
    channels = [c for c, v in headers.items() if re.search(r'^\d+\s*\(\d+[a-z]\)|^imaging\s*\d|^kronos', norm(v))]
    if not channels:
        return
    datecol = field(headers, r'^date \(prep\)')
    labelcol = next((c for n in sorted(rows) for c, v in rows[n]['values'].items()
                     if header_at < n <= header_at + 12 and norm(v) in ('animal id', 'gender / #') and colnum(c) < min(map(colnum, channels))), None)
    if not labelcol:
        return
    merges = sheet.get('merged_ranges', [])
    resolved = resolved_rows(rows, merges)
    old_labels = {'animal id', 'gender / #', 'magnification', 'effective magnification'}
    variant = re.compile(r"^animal(?:\s+luc|\s+'\d{2}/\d{1,2}/\d{1,2}|\s+id\s*\((?:luc|wt)\))$")
    starts = []
    for n in sorted(rows):
        label = norm(rows[n]['values'].get(labelcol))
        if n <= header_at:
            continue
        if label in old_labels or (variant.fullmatch(label) and meaningful(rows[n]['values'].get(datecol))):
            starts.append(n)
    key = sheet['workbook_id'], sheet['sheet_id']
    for i, start in enumerate(starts):
        end = starts[i + 1] - 1 if i + 1 < len(starts) else max(rows)
        label = norm(rows[start]['values'].get(labelcol))
        if label in ('magnification', 'effective magnification'):
            # The earlier dedicated imaging addendum already handles these blocks.
            continue
        channel_data = {}
        for column in channels:
            labels = {}
            for n in sorted(rows):
                if not start <= n <= end:
                    continue
                title = rows[n]['values'].get(labelcol)
                value = resolved.get(n, {}).get(column)
                if meaningful(title) and meaningful(value):
                    labels[f'{title} (block row {n-start+1})'] = value
            if labels:
                channel_data[str(headers[column])] = labels
        # A temperature device/configuration alone is not a biological sample block.
        biological = any(re.search(r'tissue', norm(k)) and meaningful(v) for labels in channel_data.values() for k, v in labels.items())
        if not biological:
            continue
        old_start = label in {'animal id', 'gender / #'}
        old_ranges = [(lo, hi) for lo, hi, _ in index.get(key, []) if lo == start]
        conflated = old_start and any(hi > end for _, hi in old_ranges)
        tail = any(n >= start + 15 and any(meaningful(v) for c, v in row['values'].items() if c in channels)
                   for n, row in rows.items() if n <= end)
        if old_start and not conflated and not tail:
            continue
        corrections = overlaps(index, key, start, end)
        raw = {'Evidence title': 'Recovered instrument block context', 'Review warning': WARNING,
               'Block boundary reason': 'Variant animal heading' if not old_start else 'Prior range crossed a later block' if conflated else 'Timing or sample fields beyond the prior 15-row limit',
               'Preparation fields': fields(headers, {c: v for c, v in resolved.get(start, {}).items() if c not in channels and c != labelcol}),
               'Channel fields with row positions': channel_data}
        yield start, end, 'instrument_block_recovery', raw, context(rows, [header_at], start, end, merges), {
            'date': date_value(resolved.get(start, {}).get(datecol)),
            'contextual_correction_for_source_ids': corrections,
            'requires_manual_block_review': True,
        }


def table_profile(title, workbook_title, rows):
    low = norm(title)
    candidates = [(n, rows[n]['values']) for n in sorted(rows) if n <= 12]
    if low in {'tst/fst/spt', 'tst/fst'}:
        return next(((n, h, 'behavior_session_context', [field(h, r'animal.*id'), field(h, r'^start date'), field(h, r'^end date'), field(h, r'^tst')], field(h, r'animal.*id'), field(h, r'^start date'))
                     for n, h in candidates if field(h, r'animal.*id') and field(h, r'^start date')), None)
    if low == 'culture':
        return next(((n, h, 'culture_context', [field(h, r'^tissues'), field(h, r'^date \(prep\)'), field(h, r'animal box')], field(h, r'animal box'), field(h, r'^date \(prep\)'))
                     for n, h in candidates if field(h, r'^tissues') and field(h, r'^date \(prep\)')), None)
    if low == 'hydrocephalus mice':
        return next(((n, h, 'specimen_context', [field(h, r'^samples$')], field(h, r'^name$'), field(h, r'^date of sampling'))
                     for n, h in candidates if field(h, r'^samples$') and field(h, r'^date of sampling')), None)
    if low == 'nanodrop (cdna)':
        return next(((n, h, 'sample_processing_context', [field(h, r'^sample id$'), field(h, r'^concentration$')], field(h, r'^sample id$'), field(h, r'^date$'))
                     for n, h in candidates if field(h, r'^sample id$') and field(h, r'^concentration$')), None)
    if norm(workbook_title) == 'ad sample' and low in AD_NAMES:
        pattern = r'^mouse (?:name|no\.)$|^name$'
        return next(((n, h, 'cohort_context', [c for c, v in h.items() if re.search(pattern, norm(v))], None, None)
                     for n, h in candidates if any(re.search(pattern, norm(v)) for v in h.values())), None)
    return None


def table_evidence(sheet, rows, workbook_title, index):
    profile = table_profile(sheet['sheet_name'], workbook_title, rows)
    if profile is None:
        return
    header_at, headers, kind, signals, idcol, datecol = profile
    merges = sheet.get('merged_ranges', [])
    resolved = resolved_rows(rows, merges)
    key = sheet['workbook_id'], sheet['sheet_id']
    for n in sorted(rows):
        if n <= header_at:
            continue
        values = rows[n]['values']
        signals_present = [values.get(c) for c in signals if c and meaningful(values.get(c))]
        if not signals_present:
            continue
        if kind == 'cohort_context':
            # Group labels (WT) and comma/range/multiline labels remain raw group
            # evidence. Never expand them into guessed individual participants.
            subjects = [v for v in signals_present if not re.search(r'experiment terminated|convert to|^\s*(?:note|plan)\b', str(v), re.I)]
            if not any(re.search(r'\d', str(v)) or norm(v) in {'wt', 'wild type', 'ad'} for v in subjects):
                continue
        if all(norm(v) in {norm(h) for h in headers.values()} for v in signals_present):
            continue
        labeled = fields(headers, resolved.get(n, values))
        raw = {'Evidence title': sheet['sheet_name'] + ' · source row context', 'Review warning': WARNING, 'Recorded fields': labeled}
        if kind == 'sample_processing_context':
            raw['Review warning'] += ' Blank/control wells are retained as controls, never animals.'
        extra = {'date': date_value(resolved.get(n, {}).get(datecol)) if datecol else None}
        if idcol and meaningful(resolved.get(n, {}).get(idcol)):
            extra['raw_identifiers'] = [str(resolved[n][idcol]).strip()]
            if kind == 'sample_processing_context':
                extra['identifier_kind'] = 'sample_label'
        corrections = overlaps(index, key, n, n)
        if corrections:
            extra['contextual_correction_for_source_ids'] = corrections
        header_rows = [r for r in rows if r <= header_at]
        if kind == 'cohort_context':
            # Preserve explicit plan/termination notes with their exact source
            # positions. They are context, never a status applied to every row.
            header_rows += [r for r in rows if r > header_at and any(re.search(r'experiment terminated|convert to', str(v), re.I) for v in rows[r]['values'].values())]
        yield n, n, kind, raw, context(rows, header_rows, n, n, merges), extra


def append_evidence(base_path, raw_path, coverage_path, output_dir):
    base_path, raw_path, coverage_path = map(Path, (base_path, raw_path, coverage_path))
    frozen = base_path.read_bytes()
    base = json.loads(frozen)
    for key in ('sources', 'contexts', 'observations'):
        if not isinstance(base.get(key), list):
            raise ValueError('Frozen bundle is missing ' + key)
    if base.get('coverage', {}).get('evidence_completion', {}).get('version') == VERSION:
        raise ValueError('This supplement is already present; reuse its immutable output.')
    catalog = {s['file_id']: i for i, s in enumerate(base['sources'])}
    if len(catalog) != len(base['sources']):
        raise ValueError('Duplicate source catalog identity')
    index = collections.defaultdict(list)
    ids = set()
    for obs in base['observations']:
        if obs['source_id'] in ids:
            raise ValueError('Duplicate frozen source ID')
        ids.add(obs['source_id'])
        for ref in obs.get('provenance_refs', []):
            if len(ref) != 4 or not isinstance(ref[0], int) or not 0 <= ref[0] < len(base['sources']):
                raise ValueError('Invalid frozen provenance catalog reference')
            _, lo, _, hi = bounds(ref[3])
            index[base['sources'][ref[0]]['file_id'], ref[1]].append((lo, hi, obs['source_id']))
    sheets = json.loads(coverage_path.read_text())
    selected = {}
    for s in sheets:
        if s['workbook_id'] not in catalog:
            raise ValueError('Coverage workbook is absent from frozen catalog')
        title = base['sources'][catalog[s['workbook_id']]]['title']
        if norm(s['sheet_name']) in TABLE_NAMES or (norm(title) == 'ad sample' and norm(s['sheet_name']) in AD_NAMES) or re.search(r'lumicycle|imaging|kronos', norm(s['sheet_name'])):
            key = s['workbook_id'], s['sheet_id']
            if key in selected:
                raise ValueError('Duplicate sheet identity')
            selected[key] = s
    grouped = collections.defaultdict(dict)
    with gzip.open(raw_path, 'rt', encoding='utf-8') as stream:
        for line in stream:
            row = json.loads(line)
            key = row['workbook_id'], row['sheet_id']
            if key not in selected:
                continue
            if row['sheet_name'] != selected[key]['sheet_name'] or row['row'] in grouped[key]:
                raise ValueError('Raw row metadata mismatch or duplicate row')
            grouped[key][row['row']] = {k: row.get(k, {}) for k in ('values', 'formulas', 'hyperlinks')}
    observations, contexts, reports = {}, {}, []
    for key, sheet in selected.items():
        rows = grouped.get(key, {})
        if len(rows) != sheet['populated_rows']:
            raise ValueError('Raw-row coverage mismatch for ' + sheet['sheet_name'])
        if not rows:
            continue
        source = base['sources'][catalog[key[0]]]
        counts, repeats = collections.Counter(), collections.Counter()
        entries = list(instrument_evidence(sheet, rows, index)) + list(table_evidence(sheet, rows, source['title'], index))
        for start, end, kind, raw, ctx, extra in entries:
            context_id = 'experiment-context-' + digest(ctx)
            contexts.setdefault(context_id, {'context_id': context_id, 'values': ctx})
            corrections = extra.pop('contextual_correction_for_source_ids', [])
            semantic = {'kind': 'source_matrix_review', 'evidence_kind': kind, 'evidence_title': raw['Evidence title'],
                        'assays': ['LumiCycle'] if kind == 'instrument_block_recovery' and 'lumicycle' in norm(sheet['sheet_name']) else ['Other'],
                        'raw_values': raw, 'context_id': context_id, 'animal_link_status': 'unresolved', 'review_status': 'unreviewed', **extra}
            fingerprint = digest([sheet['sheet_name'], semantic])
            repeats[fingerprint] += 1
            source_id = 'experiment-source-' + digest([VERSION, fingerprint, repeats[fingerprint]])
            if source_id in ids:
                raise ValueError('Supplement source ID overlaps frozen prefix')
            right = max((colnum(c) for n, row in rows.items() if start <= n <= end for c in row['values']), default=1)
            ref = [catalog[key[0]], key[1], sheet['sheet_name'], f'A{start}:{colname(right)}{end}']
            if source_id not in observations:
                observations[source_id] = {'source_id': source_id, 'workbook_id': key[0], 'sheet_id': key[1],
                    'sheet_name': sheet['sheet_name'], 'range': ref[3], 'snapshot_date': source.get('snapshot_date'),
                    **semantic, 'provenance_refs': [], 'contextual_correction_for_source_ids': []}
            saved = observations[source_id]
            if ref not in saved['provenance_refs']:
                saved['provenance_refs'].append(ref)
                counts[kind] += 1
            saved['contextual_correction_for_source_ids'] = sorted(set(saved['contextual_correction_for_source_ids']) | set(corrections))
        reports.append({'workbook_id': key[0], 'sheet_id': key[1], 'sheet_name': sheet['sheet_name'],
                        'original_parser': sheet['parser'], 'populated_rows': len(rows), 'appended_occurrences_by_kind': dict(counts)})
    added = list(observations.values())
    new_contexts = [c for c in contexts.values() if c['context_id'] not in {x['context_id'] for x in base['contexts']}]
    result = copy.deepcopy(base)
    result['observations'].extend(added)
    result['contexts'].extend(new_contexts)
    evidence = {'version': VERSION, 'base_sha256': hashlib.sha256(frozen).hexdigest(),
                'raw_archive_sha256': hashlib.sha256(raw_path.read_bytes()).hexdigest(),
                'sheet_coverage_sha256': hashlib.sha256(coverage_path.read_bytes()).hexdigest(),
                'added_observations': len(added), 'added_contexts': len(new_contexts),
                'added_provenance_references': sum(len(o['provenance_refs']) for o in added),
                'observations_by_evidence_kind': dict(collections.Counter(o['evidence_kind'] for o in added)),
                'observations_with_contextual_corrections': sum(bool(o['contextual_correction_for_source_ids']) for o in added),
                'prior_observations_requiring_context_review': len({s for o in added for s in o['contextual_correction_for_source_ids']}),
                'not_completed_experiments': True, 'confirmed_animal_links_added': 0,
                'remaining_scope': ['Other archive-only layouts, embedded XLSX comments/objects and complete Google edit revisions remain outside this supplement.',
                                    'Source plans, controls, pooled material and actual procedures require human review; no completion or identity is inferred.',
                                    'Original parser classification totals describe the baseline extraction; this supplement has separate per-sheet coverage.']}
    result['coverage'].update(unique_observations=len(result['observations']), preparation_contexts=len(result['contexts']), evidence_completion=evidence,
                              observations_by_kind=dict(collections.Counter(o['kind'] for o in result['observations'])))
    history = copy.deepcopy(base.get('coverage_history', [base['coverage']]))
    if not history or history[-1] != base['coverage']:
        raise ValueError('Existing coverage history does not end with the frozen coverage')
    result['coverage_history'] = history + [copy.deepcopy(result['coverage'])]
    result['caveats'].append(WARNING + ' Context corrections annotate earlier evidence without deleting or globally invalidating it.')
    assert result['observations'][:len(base['observations'])] == base['observations']
    assert result['sources'] == base['sources']
    assert result['contexts'][:len(base['contexts'])] == base['contexts']
    assert base_path.read_bytes() == frozen
    output = Path(output_dir).resolve()
    public_repo = Path(__file__).resolve().parents[1]
    if output == public_repo or public_repo in output.parents:
        raise ValueError('Private extracted data cannot be written inside the application repository')
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(output, 0o700)
    data = json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    report = {**evidence, 'expanded_sha256': hashlib.sha256(data).hexdigest(), 'expanded_observations': len(result['observations']),
              'expanded_bytes': len(data), 'original_prefix_unchanged': True, 'source_catalog_unchanged': True,
              'context_prefix_unchanged': True, 'max_observation_bytes': max((len(canonical(o).encode()) for o in added), default=0),
              'max_context_bytes': max((len(canonical(c).encode()) for c in new_contexts), default=0)}
    outputs = {'experiment_sources_app.json': data,
               'experiment_evidence_addendum.json': json.dumps({'observations': added, 'contexts': new_contexts}, ensure_ascii=False, separators=(',', ':')).encode(),
               'validation_report.json': json.dumps(report, ensure_ascii=False, indent=2).encode(),
               'sheet_coverage.json': json.dumps(reports, ensure_ascii=False, indent=2).encode()}
    for name, content in outputs.items():
        with (output / name).open('xb') as stream:
            os.chmod(output / name, 0o600)
            stream.write(content)
    with (output / 'experiment_sources_app.json.gz').open('xb') as stream:
        os.chmod(stream.name, 0o600)
        with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0) as zipped:
            zipped.write(data)
    return result, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True)
    parser.add_argument('--raw-rows', required=True)
    parser.add_argument('--sheet-coverage', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    _, report = append_evidence(args.base, args.raw_rows, args.sheet_coverage, args.output)
    print(json.dumps(report, indent=2))
