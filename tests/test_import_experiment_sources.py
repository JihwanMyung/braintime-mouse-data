import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('experiment_import', Path(__file__).parents[1]/'scripts/import-experiment-sources.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExperimentSourceTests(unittest.TestCase):
    def test_dates_do_not_guess_unknown_ranges_or_invalid_days(self):
        self.assertEqual(module.date_value('2021/6/4 15:00'), '2021-06-04')
        for value in ['2021/6/4 - 2021/6/5', '2019/12/06-07', '6/4', '2021/2/29', None, 'planned']:
            self.assertIsNone(module.date_value(value))

    def test_only_actual_merged_cells_supply_missing_context(self):
        rows = [['2021-06-04', 'P-M1'], [None, 'P-M2'], [None, 'P-M3']]
        values, refs = module.merged_values(rows, ['A1:A2'])
        self.assertEqual(values[1][0], '2021-06-04')
        self.assertIsNone(values[2][0])
        self.assertIsNone(rows[1][0])
        self.assertEqual(refs['A2'], 'A1:A2')

    def test_sampling_retains_both_animal_and_sample_labels_and_temperature(self):
        rows = [['Tissue sampling'], ['Date', 'Animals (genotype)', 'Name Tag', 'Tissues', 'Storage', 'qPCR/WB/IHC'],
                ['2021-06-04', 'AD-F26', '1 (red)', 'L brain', '-70ºC Box A', 'qPCR'],
                [None, None, None, None, False, None]]
        parsed = list(module.parse_sheet('Sampling (qPCR/WB/IHC)', rows, rows))
        self.assertEqual(len(parsed), 1)
        obs = parsed[0][1]
        self.assertEqual(obs['raw_identifiers'], ['AD-F26'])
        self.assertEqual(obs['raw_values']['C · Name Tag'], '1 (red)')
        self.assertEqual(obs['date'], '2021-06-04')
        self.assertEqual(obs['storage'], '-70ºC Box A')
        self.assertEqual(obs['assays'], ['qPCR', 'tissue_storage'])
        self.assertEqual(obs['animal_link_status'], 'unresolved')

    def test_channel_extraction_preserves_separate_tissues_from_same_animal(self):
        rows = [['LumiCycle'], ['N', 'Date (prep)', 'Label', '1 (1A)', '2 (1B)'],
                [1, '2021-06-04', 'Animal ID', 'P-M1', 'P-M1'],
                [None, None, 'Tissue', 'SCN', 'CP'], [None, None, 'Prep. time', '12:00', '12:05']]
        parsed = list(module.parse_sheet('LumiCycle 32', rows, rows))
        self.assertEqual(len(parsed), 2)
        self.assertEqual([o['tissue'] for _, o in parsed], ['SCN', 'CP'])
        self.assertNotEqual(module.digest(parsed[0][1]), module.digest(parsed[1][1]))

    def test_later_imaging_blocks_keep_decap_preparation_and_donor_distinct(self):
        rows = [['IMG'], ['N','Date (prep)','Label','Imaging 1','Imaging 2','Comments'],
            [1,'2021-06-04','Magnification','4x','20x','Maternal experiment'],
            [None,None,'Tissue','SCN','CP'],
            [None,None,'Animal (gender)','P-M1','P-M2'],
            [None,None,'Decap at','12:12','12:51'],
            [None,None,'Prep at','14:55','16:44'],
            [2,'2021-06-05','Effective magnification','4x','20x'],
            [None,None,'Tissue',None,None],
            [None,None,'Animal (gender)',None,None],
            [None,None,'Dish number','heart E14','IMG2'],
            [None,None,'Decap at','11:25',None],
            [None,None,'Prep at','12:08',None]]
        parsed = list(module.parse_luc_imaging_blocks(' Luc Imaging', rows, rows))
        self.assertEqual(len(parsed),3)
        first = parsed[0][1]
        self.assertEqual(first['raw_identifiers'], ['P-M1'])
        self.assertEqual(first['raw_values']['sample']['Decap at'],'12:12')
        self.assertEqual(first['raw_values']['sample']['Prep at'],'14:55')
        self.assertEqual(first['raw_values']['sample']['Animal (gender)'],'P-M1')
        self.assertEqual(parsed[0][0],'D3:D7')
        self.assertEqual(parsed[2][1]['identifier_kind'],'sample_label')
        self.assertEqual(parsed[2][1]['raw_identifiers'],['heart E14'])
        self.assertNotIn('mouse_sid', first)

    def test_imaging_setup_without_specimen_is_not_an_observation(self):
        rows = [['Date (prep)','Label','Imaging 1'],['2021-06-04','Effective magnification','4x'],
                [None,'Animal (gender)',None],[None,'Tissue',None],[None,'Camera','Camera name']]
        self.assertEqual(list(module.parse_luc_imaging_blocks('Luc Imaging',rows,rows)),[])

    def test_blank_checkbox_and_serial_number_rows_are_not_qpcr_runs(self):
        rows = [['qPCR'], ['No.', 'qPCR date', 'Tissue Sample', 'User'], [1, None, None, False],
                [2, '2021-06-04', 'SCN sample 7', 'JM']]
        parsed = list(module.parse_sheet('qPCR', rows, rows))
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0][1]['date'], '2021-06-04')
        self.assertEqual(parsed[0][1]['raw_identifiers'], [])

    def test_sample_labels_never_become_mouse_sids(self):
        rows = [['Date', 'Hydrocephalus?', 'Genotype', 'Tamoxifen?', 'Sample Name', 'Tissue', 'Location'],
                ['2024-05-23', 'yes', 'FPB', 'yes', 'F24', 'R-LVCP', 'IMG2']]
        obs = list(module.parse_sheet('FPB IMG data', rows, rows))[0][1]
        self.assertEqual(obs['raw_identifiers'], ['F24'])
        self.assertEqual(obs['identifier_kind'], 'sample_label')
        self.assertNotIn('mouse_sid', obs)

    def test_animal_tags_exclude_birth_and_entrainment_prose(self):
        self.assertEqual(module.identifiers("126-2\nB6 R12\nADFB'-M2840\nL0R1\nDOB: 2025/10/6\n40 wk\nentrained 4/21/26"), ["ADFB'-M2840"])
        self.assertEqual(module.identifiers('P-M134 (L0R1), P-M135'), ['P-M134', 'P-M135'])
        self.assertEqual(module.identifiers('1-(P5) 3'), ['1-(P5) 3'])

    def test_compact_bundle_preserves_shared_context_and_catalog_order(self):
        source = {'file_id':'synthetic-workbook','title':'Synthetic experiment sheet','snapshot_date':'2021-06-04','archive_path':'/private/example.xlsx'}
        ref = {'workbook_id':source['file_id'],'sheet_id':7,'sheet_name':'LumiCycle 32','range':'D3:D5'}
        observation = {'source_id':'synthetic-source','kind':'instrument_channel','raw_values':{'sample':{'Tissue':'SCN'},'preparation':{'Treatment':'vehicle'}},'provenance':[ref]}
        bundle = {'imported_at':'2026-10-14','sources':[source],'observations':[observation], 'coverage':{},'caveats':['Synthetic data']}
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'full.json'; p.write_text(json.dumps(bundle))
            result = module.compact_bundle(p,Path(tmp)/'app.json')
        self.assertNotIn('archive_path',result['sources'][0])
        row = result['observations'][0]
        self.assertEqual(row['provenance_refs'],[[0,7,'LumiCycle 32','D3:D5']])
        self.assertEqual(result['contexts'][0]['context_id'],row['context_id'])
        self.assertEqual(result['contexts'][0]['values'],observation['raw_values']['preparation'])
        self.assertEqual(row['raw_values']['sample'],observation['raw_values']['sample'])


if __name__ == '__main__':
    unittest.main()
