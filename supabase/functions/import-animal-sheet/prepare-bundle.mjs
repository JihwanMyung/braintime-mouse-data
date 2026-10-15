import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function prepareBundle(destination){
 const output=resolve(destination),clean=text=>text.replace(/^import[^\n]+\n/gm,'').replace(/\bexport (?=(?:async )?(?:function|const|class)\b)/g,'');
 const observations=await readFile(new URL('../../../web/cage-observations.js',import.meta.url),'utf8'),source=await readFile(new URL('./source.mjs',import.meta.url),'utf8'),merge=await readFile(new URL('./merge.mjs',import.meta.url),'utf8'),handler=await readFile(new URL('./handler.mjs',import.meta.url),'utf8');
 // Isolate each module's local names, preserving its original implementation.
 const bundled='// Generated read-only inbound Animal Sheet function. Contains no credentials.\n'+
  'const observationModule=(()=>{\n'+clean(observations)+'\nreturn {cageObservations};\n})();\n'+
  'const sourceModule=(()=>{const {cageObservations}=observationModule;\n'+clean(source)+'\nreturn {parseAnimalSheetWorkbook,SOURCE_ID_PATTERN,SOURCE_SHEETS,sourceHash,stableJSON,sourceDate};\n})();\n'+
  'const mergeModule=(()=>{const {SOURCE_ID_PATTERN,sourceHash,stableJSON,sourceDate}=sourceModule;\n'+clean(merge)+'\nreturn {planAnimalSheetMerge};\n})();\n'+
  'const handlerModule=(()=>{const {parseAnimalSheetWorkbook,SOURCE_ID_PATTERN,SOURCE_SHEETS}=sourceModule;const {planAnimalSheetMerge}=mergeModule;\n'+clean(handler)+'\nreturn {createHandler};\n})();\nDeno.serve(handlerModule.createHandler({env:Deno.env}));\n';
 await mkdir(output,{recursive:true});await writeFile(join(output,'index.ts'),bundled);
 await copyFile(new URL('../../animal-sheet-import.sql',import.meta.url),join(output,'01-install.sql'));
 await copyFile(new URL('../../animal-sheet-import-schedule.sql',import.meta.url),join(output,'04-activate-daily-after-verification.sql'));
 await copyFile(new URL('./README.md',import.meta.url),join(output,'README.md'));
 return {output,bundle_bytes:Buffer.byteLength(bundled),files:['index.ts','01-install.sql','04-activate-daily-after-verification.sql','README.md']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(!process.argv[2])throw Error('Usage: node prepare-bundle.mjs /absolute/private/deployment-directory');console.log(JSON.stringify(await prepareBundle(process.argv[2])))}
