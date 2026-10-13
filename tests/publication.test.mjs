import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
test('publication uses an explicit source and website file list',async()=>{
  const paths=(await readFile(new URL('publication-files.txt',root),'utf8')).trim().split('\n');
  assert.equal(paths.length,new Set(paths).size);
  for(const path of paths)assert(!/^(?:outputs|raw|private|work)\//.test(path)&&!/(?:dataset.*\.json|history_cells|import-report|colony-backup|\.xlsx$)/.test(path),path);
  async function files(directory){const found=[];for(const e of await readdir(new URL(directory+'/',root),{withFileTypes:true})){const p=directory+'/'+e.name;if(e.isDirectory())found.push(...await files(p));else found.push(p);}return found;}
  assert.deepEqual((await files('web')).sort(),paths.filter(p=>p.startsWith('web/')).sort());
  assert(!paths.some(path=>path.startsWith('.github/workflows/')),'Branch deployment has no active custom workflow');
  await assert.rejects(readFile(new URL('.github/workflows/pages.yml',root),'utf8'),{code:'ENOENT'});
  const workflow=await readFile(new URL('deploy/pages-workflow.example.yml',root),'utf8');
  assert(workflow.includes('node --test tests/*.test.mjs'));
  assert(workflow.includes('node scripts/prepare-pages.mjs'));
  assert(workflow.includes('path: _site'));
  assert((await readFile(new URL('scripts/prepare-pages.mjs',root),'utf8')).includes("resolve(output,'.nojekyll')"));
});
test('source workbook write guard is required and contains no private identifier',async()=>{
  const source=await readFile(new URL('supabase/functions/sync-animal-sheet/index.ts',root),'utf8');
  assert(source.includes("required('ANIMAL_SOURCE_SPREADSHEET_ID').trim()"));
  assert(source.includes('if(sheet===sourceSheet)throw'));
  assert(source.includes("if(!v?.trim())throw"));
  assert(!/spreadsheets\/d\/[\w-]{30,}/.test(await readFile(new URL('SHEET_SYNC.md',root),'utf8')));
});
