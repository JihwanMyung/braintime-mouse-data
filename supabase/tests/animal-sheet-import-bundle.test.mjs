import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareBundle} from '../functions/import-animal-sheet/prepare-bundle.mjs';
await test('single-file deployment bundle isolates modules and starts the same protected handler',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'animal-import-bundle-'));try{
 const result=await prepareBundle(directory),code=await readFile(join(directory,'index.ts'),'utf8');assert(result.bundle_bytes>10000);assert(!/^import /m.test(code));assert(!/\bexport (const|function)/.test(code));
 let handler;new Function('Deno',code)({serve:fn=>handler=fn,env:{get:()=>undefined}});assert.equal(typeof handler,'function');const response=await handler(new Request('https://example.org',{method:'POST'}));assert.equal(response.status,401);
 assert.equal(await readFile(join(directory,'01-install.sql'),'utf8'),await readFile(new URL('../animal-sheet-import.sql',import.meta.url),'utf8'));
 assert.equal(await readFile(join(directory,'04-activate-daily-after-verification.sql'),'utf8'),await readFile(new URL('../animal-sheet-import-schedule.sql',import.meta.url),'utf8'));
 }finally{await rm(directory,{recursive:true,force:true})}
});
