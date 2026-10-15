/** The step-4 code state a P0 check ran against: git HEAD, dirty files under bambuImport, and a sha256 over every file there
 *  (sorted relative path + NUL + bytes + NUL). tools/verify.py recomputes the sha256 to tell whether the code moved since. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const ROOT = '/home/user/levonis-import';
const DIR = `${ROOT}/packages/catalog/src/bambuImport`;
const walk = (d: string, rel = ''): string[] => readdirSync(d).sort().flatMap((n) => {
  const p = `${d}/${n}`;
  return statSync(p).isDirectory() ? walk(p, `${rel}${n}/`) : [`${rel}${n}`];
});
export function step4CodeState() {
  const h = createHash('sha256');
  const files = walk(DIR).sort();
  for (const f of files) { h.update(f); h.update('\0'); h.update(readFileSync(`${DIR}/${f}`)); h.update('\0'); }
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).toString().trim();
  const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'packages/catalog/src/bambuImport']).toString().split('\n').filter(Boolean).length;
  return { head, dirty_files_in_bambuImport: dirty, files: files.length, sha256: h.digest('hex'), read_at: new Date().toISOString() };
}
