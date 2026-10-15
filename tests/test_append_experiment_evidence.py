import gzip
import importlib.util
import json
import stat
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('append_evidence', Path(__file__).parents[1] / 'scripts/append-experiment-evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def row(n, values, **extra):
    return {'row': n, 'values': values, 'formulas': {}, 'hyperlinks': {}, **extra}


class EvidenceCompletionTests(unittest.TestCase):
    def fixture(self, directory, sheets, observations=None):
        catalog = []
        for wb, title, _, _, _ in sheets:
            if not any(s['file_id'] == wb for s in catalog):
                catalog.append({'file_id': wb, 'title': title, 'snapshot_date': '2026-10-14'})
        base = {'sources': catalog, 'contexts': [{'context_id': 'old', 'values': {'Original': True}}],
                'observations': observations or [], 'coverage': {'unique_observations': len(observations or [])}, 'caveats': []}
        root = Path(directory)
        (root / 'base.json').write_text(json.dumps(base))
        coverage = []
        with gzip.open(root / 'raw.gz', 'wt') as stream:
            for wb, _, name, rows, merges in sheets:
                coverage.append({'workbook_id': wb, 'sheet_id': 1, 'sheet_name': name, 'populated_rows': len(rows),
                                 'merged_ranges': merges, 'parser': 'archive_only'})
                for r in rows:
                    stream.write(json.dumps({'workbook_id': wb, 'sheet_id': 1, 'sheet_name': name, **r}) + '\n')
        (root / 'coverage.json').write_text(json.dumps(coverage))
        return base

    def run_append(self, directory, suffix='output'):
        root = Path(directory)
        return module.append_evidence(root / 'base.json', root / 'raw.gz', root / 'coverage.json', root / suffix)

    def test_separate_variant_blocks_and_correct_only_overlapping_context(self):
        rows = [row(1, {'B': 'Date (prep)', 'K': 'Label', 'M': '1 (1A)'}),
                row(2, {'B': '2020-08-14', 'K': 'Animal ID', 'M': 'P-F187'}),
                row(3, {'K': 'Tissue', 'M': 'SCN'}),
                row(4, {'B': '2020-08-25', 'K': 'Animal LUC', 'M': 'P-F155'}),
                row(5, {'K': 'Tissue LUC', 'M': 'pineal'}),
                row(6, {'K': 'Prep. time', 'M': '12:10'}),
                row(7, {'K': 'Prep. time', 'M': '12:20'}),
                row(8, {'B': '2020-09-01', 'K': 'Animal ID', 'M': 'P-M3'}),
                row(9, {'K': 'Tissue', 'M': 'CP'})]
        original = [{'source_id': 'old-mixed-block', 'kind': 'instrument_channel', 'provenance_refs': [[0, 1, 'LumiCycle 32', 'M2:M7']]},
                    {'source_id': 'old-normal-block', 'kind': 'instrument_channel', 'provenance_refs': [[0, 1, 'LumiCycle 32', 'M8:M9']]}]
        with tempfile.TemporaryDirectory() as tmp:
            base = self.fixture(tmp, [('wb', 'Experiment', 'LumiCycle 32', rows, [])], original)
            result, report = self.run_append(tmp)
            added = result['observations'][2:]
            self.assertEqual(len(added), 2)
            self.assertEqual([x['range'] for x in added], ['A2:M3', 'A4:M7'])
            self.assertEqual([x['date'] for x in added], ['2020-08-14', '2020-08-25'])
            self.assertEqual(added[1]['contextual_correction_for_source_ids'], ['old-mixed-block'])
            labels = added[1]['raw_values']['Channel fields with row positions']['1 (1A)']
            self.assertEqual(labels['Prep. time (block row 3)'], '12:10')
            self.assertEqual(labels['Prep. time (block row 4)'], '12:20')
            self.assertEqual(result['observations'][:2], original)
            self.assertEqual(result['contexts'][:1], base['contexts'])
            self.assertEqual(result['sources'], base['sources'])
            self.assertEqual(result['coverage_history'], [base['coverage'], result['coverage']])
            self.assertEqual(report['confirmed_animal_links_added'], 0)

    def test_tail_timing_and_two_donors_remain_distinct(self):
        rows = [row(1, {'B': 'Date (prep)', 'K': 'Label', 'M': '1 (1A)'}),
                row(2, {'B': '2020-12-10', 'K': 'Animal ID (LUC)', 'M': 'P-M1'}),
                row(3, {'K': 'Tissue (LUC)', 'M': 'SCN'}),
                row(4, {'K': 'Animal ID (WT)', 'M': 'B6-M1'}),
                row(20, {'K': 'RNA sampling time 1', 'M': '25:30'}),
                row(21, {'K': 'Decapitation time', 'M': '12:00'})]
        with tempfile.TemporaryDirectory() as tmp:
            # A recognized heading in the first rows establishes the label column.
            rows.insert(1, row(1 + 1, {'B': '2020-12-01', 'K': 'Animal ID', 'M': 'P-M0'}))
            rows[2]['row'] = 3
            rows[3]['row'] = 4
            rows[4]['row'] = 5
            self.fixture(tmp, [('wb', 'Experiment', 'LumiCycle 32', rows, [])])
            result, _ = self.run_append(tmp)
            added = result['observations']
            self.assertEqual(len(added), 1)
            labels = next(iter(added[0]['raw_values']['Channel fields with row positions'].values()))
            self.assertIn('B6-M1', labels.values())
            self.assertIn('P-M1', labels.values())
            self.assertIn('25:30', labels.values())
            self.assertNotIn('mouse_sid', added[0])
            self.assertNotIn('raw_identifiers', added[0])

    def test_behavior_merged_dates_only_and_template_exclusion(self):
        rows = [row(1, {'B': 'TST / FST / SPT', 'C': 'Start date', 'D': 'End date', 'H': 'Animal IDs'}),
                row(2, {'B': 'TST', 'C': '2021-06-04', 'H': 'P-M1'}),
                row(3, {'H': 'P-M2'}), row(4, {'H': 'P-M3'}), row(5, {'A': 5, 'R': False})]
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp, [('wb', 'Experiment', 'TST/FST/SPT', rows, ['C2:C3'])])
            result, _ = self.run_append(tmp)
            added = result['observations']
            self.assertEqual(len(added), 3)
            self.assertEqual([o['date'] for o in added], ['2021-06-04', '2021-06-04', None])
            self.assertTrue(all(o['review_status'] == 'unreviewed' and o['animal_link_status'] == 'unresolved' for o in added))
            ctx = next(c for c in result['contexts'] if c['context_id'] == added[1]['context_id'])['values']
            self.assertEqual(ctx['Outside-range merge anchors'], {'C2': '2021-06-04'})

    def test_sample_controls_never_become_animal_participants(self):
        rows = [row(2, {'A': 'Date', 'D': 'Sample ID', 'H': 'Concentration'}),
                row(3, {'A': '2021-06-04', 'D': 'BLANK1(ddH2O)', 'H': 0.4}),
                row(4, {'D': 'CP-7', 'H': 12.5}, formulas={'H4': '1+11.5'}, hyperlinks={'D4': 'https://example.org/sample'}),
                row(5, {'A': False})]
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp, [('wb', 'Experiment', 'Nanodrop (cDNA)', rows, [])])
            result, _ = self.run_append(tmp)
            self.assertEqual(len(result['observations']), 2)
            self.assertTrue(all(o['identifier_kind'] == 'sample_label' for o in result['observations']))
            ctx = result['contexts'][-1]['values']['Source rows (offset from referenced range)'][0]
            self.assertEqual(ctx['formulas'], {'H4': '1+11.5'})
            self.assertEqual(ctx['hyperlinks'], {'D4': 'https://example.org/sample'})

    def test_dedupe_snapshots_preserve_repeats_and_stable_output(self):
        rows = [row(1, {'A': 'Date (prep)', 'E': 'Tissues', 'H': 'Animal box/ ind. ID'}),
                row(2, {'A': '2021-06-04', 'E': 'SCN', 'H': 'P-M1'}),
                row(3, {'A': '2021-06-04', 'E': 'SCN', 'H': 'P-M1'})]
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp, [('a', 'Experiment', 'Culture', rows, []), ('b', 'Experiment copy', 'Culture', rows, [])])
            first, report = self.run_append(tmp)
            second, _ = self.run_append(tmp, 'again')
            self.assertEqual(first, second)
            self.assertEqual(report['added_observations'], 2)
            self.assertEqual([len(o['provenance_refs']) for o in first['observations']], [2, 2])
            self.assertEqual(stat.S_IMODE((Path(tmp)/'output').stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((Path(tmp)/'output/experiment_sources_app.json').stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                self.run_append(tmp)

    def test_omit_administration_results_and_refuse_incomplete_raw_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp, [('a', 'Experiment', 'Weekly Schedule', [row(1, {'A': 'Meeting'})], [])])
            result, _ = self.run_append(tmp)
            self.assertEqual(result['observations'], [])
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp, [('a', 'Experiment', 'Culture', [row(1, {'A': 'Date (prep)', 'E': 'Tissues'})], [])])
            path = Path(tmp)/'coverage.json'
            bad = json.loads(path.read_text()); bad[0]['populated_rows'] += 1; path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, 'coverage mismatch'):
                self.run_append(tmp)
            self.assertFalse((Path(tmp)/'output').exists())

    def test_ad_sample_context_has_labeled_fields_and_correction_without_event_claim(self):
        rows = [row(1, {'C': 'Mouse No.', 'H': 'DOB', 'I': 'Entrainment start date', 'K': 'Sacrifice date'}),
                row(3, {'C': 'AD-M1', 'H': '2018-04-04', 'I': '2019-02-19', 'K': '2019-06-04'}),
                row(4, {'C': 'Experiment terminated: convert to normal diet'})]
        original = [{'source_id': 'matrix-row', 'kind': 'source_matrix_review', 'provenance_refs': [[0, 1, 'sample', 'A3:N3']]}]
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp, [('ad', 'AD sample', 'sample', rows, [])], original)
            result, _ = self.run_append(tmp)
            self.assertEqual(len(result['observations']), 2)
            extra = result['observations'][1]
            self.assertEqual(extra['contextual_correction_for_source_ids'], ['matrix-row'])
            self.assertEqual(extra['raw_values']['Recorded fields']['I · Entrainment start date'], '2019-02-19')
            self.assertIsNone(extra['date'])
            self.assertNotIn('event_type', extra)
            self.assertNotIn('supersedes_source_ids', extra)

    def test_uncertain_date_ranges_are_never_normalized(self):
        for value in ['2020-02-25 - 2020-03-02', '2/25', '2020-02-30', 20200225, 'planned']:
            self.assertIsNone(module.date_value(value))

    def test_cohort_group_labels_are_retained_without_invented_participants(self):
        rows = [row(1, {'C': 'Mouse No.', 'K': 'Sacrifice date'}),
                row(2, {'C': 'WT', 'K': '2019-06-04'}), row(3, {'C': 'ADP-F0004,5'}),
                row(4, {'C': 'Experiment terminated: convert to normal diet'})]
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp, [('ad', 'AD sample', 'sample', rows, [])])
            result, _ = self.run_append(tmp)
            self.assertEqual(len(result['observations']), 2)
            self.assertTrue(all('raw_identifiers' not in o and 'mouse_sid' not in o for o in result['observations']))
            header_rows = result['contexts'][-1]['values']['Source header rows']
            self.assertEqual(header_rows[-1]['row'], 4)
            self.assertIn('terminated', header_rows[-1]['values']['C'])


if __name__ == '__main__':
    unittest.main()
