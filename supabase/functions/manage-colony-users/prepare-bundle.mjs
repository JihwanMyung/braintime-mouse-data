import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node prepare-bundle.mjs /absolute/private/deployment-directory');
const output = resolve(destination);
const handler = await readFile(new URL('./handler.mjs', import.meta.url), 'utf8');
const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
const bundled = '// Generated from manage-colony-users/handler.mjs and index.ts. Contains no credentials.\n' +
  handler.replace('export function createHandler', 'function createHandler') + '\n' + entry.replace(/^import[^\n]+\n/, '');
await mkdir(output, {recursive: true});
await writeFile(join(output, 'index.ts'), bundled);
await copyFile(new URL('./membership.sql', import.meta.url), join(output, '01-membership.sql'));
await copyFile(new URL('../../export-permissions.sql', import.meta.url), join(output, '02-export-permissions.sql'));
await copyFile(new URL('../../manager-permissions.sql', import.meta.url), join(output, '03-manager-permissions.sql'));
await copyFile(new URL('../../lab-members.sql', import.meta.url), join(output, '04-lab-members.sql'));
await copyFile(new URL('../../username-sign-in.sql', import.meta.url), join(output, '05-username-sign-in.sql'));
await copyFile(new URL('../../account-acronym.sql', import.meta.url), join(output, '06-account-acronym.sql'));
await copyFile(new URL('../../iacuc.sql', import.meta.url), join(output, '07-iacuc.sql'));
await copyFile(new URL('../../locobox.sql', import.meta.url), join(output, '08-locobox.sql'));
await copyFile(new URL('./README.md', import.meta.url), join(output, 'README.md'));
console.log(JSON.stringify({output, bundle_bytes: Buffer.byteLength(bundled), files: ['index.ts', '01-membership.sql', '02-export-permissions.sql', '03-manager-permissions.sql', '04-lab-members.sql', '05-username-sign-in.sql', '06-account-acronym.sql', '07-iacuc.sql', '08-locobox.sql', 'README.md']}));
