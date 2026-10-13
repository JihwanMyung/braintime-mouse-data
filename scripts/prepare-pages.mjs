// Package only reviewed public app assets. Private exports remain outside this repository.
import {readFile,readdir,stat,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const allowlist=(await readFile(resolve(root,'publication-files.txt'),'utf8')).trim().split('\n');
if(new Set(allowlist).size!==allowlist.length||allowlist.some(p=>!p||p.startsWith('/')||p.split('/').includes('..')))throw new Error('Invalid publication file list.');
for(const path of allowlist)if(!(await stat(resolve(root,path))).isFile())throw new Error(`Expected public file: ${path}`);
try{
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean);
  const unexpected=tracked.filter(p=>!allowlist.includes(p));
  if(unexpected.length)throw new Error(`Tracked files are not publication-approved: ${unexpected.join(', ')}`);
}catch(error){if(!String(error.stderr||'').includes('not a git repository'))throw error;}
async function files(directory){const found=[];for(const item of await readdir(resolve(root,directory),{withFileTypes:true})){const path=`${directory}/${item.name}`;if(item.isSymbolicLink())throw new Error(`Symlinks are not publishable: ${path}`);if(item.isDirectory())found.push(...await files(path));else found.push(path);}return found;}
const expected=allowlist.filter(p=>p.startsWith('web/')).sort(),actual=(await files('web')).sort();
if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('The web folder contains files outside the explicit publication list.');
for(const path of actual.filter(p=>/\.(?:js|html|css|webmanifest|svg)$/.test(p))){
  const text=await readFile(resolve(root,path),'utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sb_secret_[A-Za-z0-9_-]{20,}/.test(text))throw new Error(`Private credential found in ${path}`);
  for(const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)){
    let payload;try{payload=JSON.parse(Buffer.from(match[1],'base64url').toString('utf8'));}catch{continue;}
    if(payload.role!=='anon')throw new Error(`Non-public JWT found in ${path}`);
  }
}
const output=resolve(root,'_site');
try{if((await readdir(output)).length)throw new Error('_site must be absent or empty before packaging.');}catch(error){if(error.code!=='ENOENT')throw error;}
for(const path of expected){const target=resolve(output,path.slice(4));await mkdir(dirname(target),{recursive:true});await copyFile(resolve(root,path),target);}
await writeFile(resolve(output,'.nojekyll'),'');
console.log(`Prepared ${expected.length} approved public assets and .nojekyll in _site.`);
