/**
 * BODY SIZE CLASSES, GENERATED FROM THE CODE (`01-TARGET.md` §3.2 step 5).
 *
 * The design says the upload classes must be derived from `worker/routes`
 * rather than guessed. They are: every row in `uploadClasses.ts` names the call
 * site and the constant it came from, and this suite re-reads both out of the
 * core. Raise `VIDEO_MAX`, add a `c.req.formData()` mount, or delete a
 * constant, and the suite fails until the table is updated — which is the same
 * guarantee a code generator would give, without a generated file to go stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_CLASSES, DEFAULT_MAX_BODY_BYTES, FORM_OVERHEAD_BYTES, JSON_CLASSES, UPLOAD_CLASSES, maxBodyBytes } from '../src/uploadClasses';
import { coreUploadRouteFiles, readCore } from './_harness';

const MB = 1024 * 1024;

/** `const NAME = 40 * 1024 * 1024;` / `const NAME = 1_500_000;` → the number. */
function constantValue(file: string, name: string): number | null {
  const src = readCore(file);
  const m = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*([0-9_ *]+);`).exec(src);
  if (!m) return null;
  const expr = m[1].replace(/_/g, '').trim();
  if (!/^[0-9 *]+$/.test(expr)) return null;
  return expr.split('*').reduce((acc, part) => acc * Number.parseInt(part.trim(), 10), 1);
}

test('every route that reads a request body has a gateway size class', () => {
  const files = coreUploadRouteFiles();
  assert.ok(files.length >= 7, `expected the core's upload routes, saw ${files.join(', ')}`);
  const covered = new Set(UPLOAD_CLASSES.map((u) => u.routeFile));
  const missing = files.filter((f) => !covered.has(f));
  assert.deepEqual(missing, [], `a new upload mount needs a size class in src/uploadClasses.ts: ${missing.join(', ')}`);
});

test('every class points at a constant that still exists, with the value the class uses', () => {
  const problems: string[] = [];
  for (const row of BODY_CLASSES) {
    if (!row.source.includes('#')) continue;
    const [file, name] = row.source.split('#');
    const value = constantValue(file, name);
    if (value === null) {
      problems.push(`${row.prefix}: ${row.source} no longer exists`);
      continue;
    }
    if (row.kind === 'multipart' && row.maxBytes !== value) problems.push(`${row.prefix}: class allows ${row.maxBytes}, ${row.source} is ${value}`);
    // A character cap is not a byte cap: Arabic is up to 4 bytes per character.
    if (row.kind === 'json' && name.endsWith('CHARS') && row.maxBytes < value * 4) problems.push(`${row.prefix}: ${row.maxBytes} bytes cannot carry ${value} characters`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the cap is 1 MB unless a class raises it, and multipart gets its envelope allowance', () => {
  assert.equal(maxBodyBytes('/api/cart', 'POST'), DEFAULT_MAX_BODY_BYTES);
  assert.equal(maxBodyBytes('/api/orders', 'POST'), DEFAULT_MAX_BODY_BYTES);
  assert.equal(maxBodyBytes('/api/uploads', 'POST'), 40 * MB + FORM_OVERHEAD_BYTES);
  assert.equal(maxBodyBytes('/api/kyc/upload', 'POST'), 8 * MB + FORM_OVERHEAD_BYTES);
  assert.equal(maxBodyBytes('/api/admin/template/parse-zip', 'POST'), 15 * MB + FORM_OVERHEAD_BYTES);
  assert.equal(maxBodyBytes('/api/admin/import/preview', 'POST'), 40 * MB + FORM_OVERHEAD_BYTES);
  assert.equal(maxBodyBytes('/api/admin/template/apply', 'POST'), 48 * MB, 'a JSON class gets no multipart allowance');
  assert.equal(maxBodyBytes('/api/uploads', 'GET'), DEFAULT_MAX_BODY_BYTES, 'a class is scoped to its methods');
  assert.equal(maxBodyBytes('/api/kyc/submit', 'POST'), DEFAULT_MAX_BODY_BYTES, 'a sibling path is not the upload route');
});

test('the admin JSON allowance covers the template body the core actually accepts', () => {
  const bytes = constantValue('worker/lib/templateMedia.ts', 'MAX_TEMPLATE_BODY_BYTES');
  assert.equal(maxBodyBytes('/api/admin/template/apply', 'POST'), bytes, 'the portable TXT envelope must reach the parser');
  assert.ok(JSON_CLASSES.some((r) => r.prefix === '/api/admin'), 'admin mutations are authenticated, apex-only and admin-write limited');
});

test('no class is wider than the largest thing the platform accepts', () => {
  for (const row of BODY_CLASSES) assert.ok(row.maxBytes <= 48 * MB, `${row.prefix}: ${row.maxBytes}`);
});
