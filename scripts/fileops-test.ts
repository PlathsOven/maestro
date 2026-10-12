// Files-tab rename / move / duplicate / OS-import confinement checks, plus the
// chat-image version check (`npm run test:fileops`).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { copyEntries, createEntry, entryPath, readAttachment, renameEntry } from '../src/main/services/files';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-ops-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'files-out-'));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
const throws = (fn: () => unknown, m: string) => { try { fn(); ok(false, m); } catch (e) { ok(true, `${m} (${(e as Error).message})`); } };
const ex = (p: string) => fs.existsSync(path.join(root, p));

createEntry(root, 'src/a.ts', false);
createEntry(root, 'src/lib/', true);
createEntry(root, 'src/lib/b.ts', false);
fs.writeFileSync(path.join(root, 'README.md'), 'hi');

renameEntry(root, 'src/a.ts', 'src/renamed.ts');
ok(ex('src/renamed.ts') && !ex('src/a.ts'), 'rename file');
renameEntry(root, 'src/lib', 'lib2');
ok(ex('lib2/b.ts') && !ex('src/lib'), 'move folder to root');
throws(() => renameEntry(root, 'lib2', 'lib2/inner/lib2'), 'refuse move into itself');
throws(() => renameEntry(root, 'README.md', 'src/renamed.ts'), 'refuse overwrite');
throws(() => renameEntry(root, 'README.md', '../escape.md'), 'refuse escape');
throws(() => renameEntry(root, '', 'x'), 'refuse root');
renameEntry(root, 'README.md', 'readme.md');
ok(fs.readdirSync(root).includes('readme.md'), 'case-only rename');
renameEntry(root, 'readme.md', 'docs/deep/readme.md');
ok(ex('docs/deep/readme.md'), 'rename into new nested folders');

ok(copyEntries(root, ['src/renamed.ts'], 'src')[0] === 'src/renamed copy.ts', 'duplicate -> " copy"');
ok(copyEntries(root, ['src/renamed.ts'], 'src')[0] === 'src/renamed copy 2.ts', 'duplicate again -> " copy 2"');
ok(copyEntries(root, ['lib2'], '')[0] === 'lib2 copy' && ex('lib2 copy/b.ts'), 'duplicate folder recursively');
ok(copyEntries(root, ['src/renamed.ts'], 'lib2')[0] === 'lib2/renamed.ts', 'copy into other folder keeps name');
throws(() => copyEntries(root, ['lib2'], 'lib2'), 'refuse copy folder into itself');

fs.writeFileSync(path.join(outside, 'ext.txt'), 'x');
fs.mkdirSync(path.join(outside, 'extdir'));
fs.writeFileSync(path.join(outside, 'extdir', 'f.txt'), 'y');
const got = copyEntries(root, [path.join(outside, 'ext.txt'), path.join(outside, 'extdir')], 'src');
ok(got.join(',') === 'src/ext.txt,src/extdir' && ex('src/extdir/f.txt'), 'import from OS');
throws(() => copyEntries(root, ['../outside.txt'], ''), 'refuse relative path escaping the tree');

fs.symlinkSync(outside, path.join(root, 'link'));
throws(() => renameEntry(root, 'src/renamed.ts', 'link/stolen.ts'), 'refuse moving through symlink out of tree');
renameEntry(root, 'link', 'link2');
ok(fs.lstatSync(path.join(root, 'link2')).isSymbolicLink() && fs.existsSync(path.join(outside, 'ext.txt')), 'rename symlink itself');
throws(() => entryPath(root, '.'), 'refuse deleting root');

// An inline chat image re-validates by version: unchanged → a stat-only
// `unchanged` answer; overwritten in place (same path) → the new bytes.
async function imageVersions() {
  const shot = path.join(root, 'shot.png');
  fs.writeFileSync(shot, 'first');
  const a = await readAttachment(root, 'shot.png');
  ok(a.kind === 'image' && !!a.dataUrl && !!a.version && !a.unchanged, 'image read carries a version');
  const b = await readAttachment(root, 'shot.png', undefined, a.version);
  ok(b.unchanged === true && !b.dataUrl && b.version === a.version, 'same version → unchanged, no payload');
  fs.writeFileSync(shot, 'second, longer');
  const c = await readAttachment(root, 'shot.png', undefined, a.version);
  ok(!c.unchanged && c.dataUrl === `data:image/png;base64,${Buffer.from('second, longer').toString('base64')}`, 'overwritten → new bytes');
  ok(c.version !== a.version, 'overwritten → new version');
  fs.writeFileSync(shot, 'third, samelen');
  fs.utimesSync(shot, new Date(), new Date(Date.now() + 5000));
  const d = await readAttachment(root, 'shot.png', undefined, c.version);
  ok(!d.unchanged && d.dataUrl?.endsWith(Buffer.from('third, samelen').toString('base64')) === true, 'same size, new mtime → new bytes');
  const e = await readAttachment(root, 'nope.png', undefined, d.version);
  ok(e.kind === 'binary' && !!e.error && !e.unchanged, 'missing file never reads as unchanged');
}

void imageVersions().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
});
