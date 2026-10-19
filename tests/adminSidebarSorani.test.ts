/**
 * THE ADMIN SIDEBAR IN REAL SORANI (P1-02; GAP-MAP conflict 3; DECISIONS row 183).
 *
 * Every tab label and every group name in src/pages/Admin.tsx's sidebar
 * carried its Arabic and its English, and about half carried no third
 * argument, so a Sorani-reading admin got the Arabic (`loc` falls back to it).
 * Row 183: a ckb slot never carries a copy of the Arabic. This pins that every
 * `loc(…)` and `section(…)` call in the sidebar has a Sorani argument that is
 * neither the Arabic nor the English, written in Sorani letters, and that the
 * two labels read from the interface table (`t('adminProducts')`,
 * `t('adminUsers')`) are Sorani there too.
 *
 * Run: node --import tsx --test tests/adminSidebarSorani.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { translations } from '../src/translations';

/** A letter Arabic does not have: the mark of a Sorani string. */
const KURDISH = /[ەۆێڕڵڤگچپژ]|ی/;

const admin = readFileSync(join(ROOT, 'src/pages/Admin.tsx'), 'utf8');
const sidebar = (() => {
  const start = admin.indexOf('const sidebarItems = [');
  assert.ok(start > 0, 'the sidebar is where it was');
  return admin.slice(start, admin.indexOf('\n  ];\n', start));
})();

/** Every `loc('ar', 'en'[, 'ckb'])` and `section('id', 'ar', 'en'[, 'ckb'])` call, with its arguments. */
function calls(src: string): Array<{ kind: 'loc' | 'section'; ar: string; en: string; ckb: string | undefined; text: string }> {
  const out: Array<{ kind: 'loc' | 'section'; ar: string; en: string; ckb: string | undefined; text: string }> = [];
  const str = `'((?:[^'\\\\]|\\\\.)*)'`;
  const re = new RegExp(`\\b(loc|section)\\(\\s*(?:'[a-z_]+',\\s*)?${str},\\s*${str}(?:,\\s*${str})?\\s*\\)`, 'g');
  for (const m of src.matchAll(re)) {
    // `section` takes the id first; the optional id group is only consumed for it.
    if (m[1] === 'loc' && /^loc\(\s*'[a-z_]+',/.test(m[0])) continue;
    out.push({ kind: m[1] as 'loc' | 'section', ar: m[2], en: m[3], ckb: m[4], text: m[0] });
  }
  return out;
}

test('every sidebar label and group name carries real Sorani — never the Arabic, never the English', () => {
  const found = calls(sidebar);
  const labels = found.filter((c) => c.kind === 'loc');
  const groups = found.filter((c) => c.kind === 'section');
  assert.ok(labels.length >= 30, `the sidebar's labels were read (${labels.length})`);
  assert.ok(groups.length >= 30, `the sidebar's group names were read (${groups.length})`);
  for (const c of found) {
    assert.ok(c.ckb !== undefined, `no Sorani — the Arabic would show: ${c.text}`);
    assert.notEqual(c.ckb, c.ar, `ckb is the Arabic pasted across: ${c.text}`);
    assert.notEqual(c.ckb, c.en, `ckb is the English: ${c.text}`);
    assert.match(c.ckb!, KURDISH, `ckb has no Sorani letter: ${c.text}`);
  }
  // Every `loc(` in the sidebar was parsed — none slipped past the reader with two arguments.
  assert.equal((sidebar.match(/\bloc\(/g) ?? []).length, labels.length, 'every loc( call in the sidebar was checked');
  assert.equal((sidebar.match(/\.\.\.section\(/g) ?? []).length, groups.length, 'every section( call in the sidebar was checked');
});

test('a group has ONE Sorani name, and the helper cannot be called without one', () => {
  const byGroup = new Map<string, Set<string>>();
  for (const m of sidebar.matchAll(/section\('([a-z_]+)', '[^']*', '[^']*', '([^']*)'\)/g)) {
    byGroup.set(m[1], (byGroup.get(m[1]) ?? new Set()).add(m[2]));
  }
  assert.deepEqual([...byGroup.keys()].sort(), ['administration', 'catalog', 'growth', 'operations', 'services', 'settings']);
  for (const [id, names] of byGroup) assert.equal(names.size, 1, `${id} is named one way: ${[...names].join(' / ')}`);
  assert.match(admin, /const section = \(id: string, ar: string, en: string, ckb: string\) =>/, 'ckb is a required argument');
});

test('the two labels from the interface table are Sorani there', () => {
  for (const key of ['adminProducts', 'adminUsers'] as const) {
    assert.match(sidebar, new RegExp(`t\\('${key}'\\)`));
    assert.notEqual(translations.ckb[key], translations.ar[key], `${key}: ckb is the Arabic`);
    assert.match(translations.ckb[key], KURDISH, `${key}: ckb has no Sorani letter`);
  }
});
