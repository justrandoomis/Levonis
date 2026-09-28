/**
 * EVERY CUSTOMER PAGE HAS A TOASTER (review of Levo Community, 2026-09-28).
 *
 * The customer shell's only Toaster lived inside the compare tray, which
 * mounts the first time the tray holds a product. On a visit that compared
 * nothing — most visits — «تعذّر تحديث المتابعة», an offer's refusal and every
 * other toast a customer page raised was queued and never drawn, and the
 * full-screen routes (checkout, settings, support) had no Toaster at all.
 *
 * Now the queue is its own React-free module (src/lib/toastStore.ts), the
 * shell's ToasterGate mounts the Toaster the first time it holds a message,
 * on both of the shell's layouts, and a second Toaster mounted alongside a
 * shell's own waits its turn instead of drawing every message twice.
 *
 * Run: node --import tsx --test tests/toasterGate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimToasterHost, dismissToast, isToasterHost, toast, toastQueue } from '../src/lib/toastStore';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the queue is React-free, so the entry can watch it without the Toaster', () => {
  const store = code('src/lib/toastStore.ts');
  assert.doesNotMatch(store, /from 'react'|from "react"|motion\/react/);
  dismissToast();
  const id = toast.error('x');
  assert.equal(toastQueue().length, 1);
  toast.error('y', { id });
  assert.equal(toastQueue().length, 1, 'the same id replaces');
  assert.equal(toastQueue()[0].title, 'y');
  dismissToast(id);
  assert.equal(toastQueue().length, 0);
});

test('two Toasters mounted at once: the first draws, the next takes over when it leaves', () => {
  const a = Symbol('a');
  const b = Symbol('b');
  const releaseA = claimToasterHost(a);
  const releaseB = claimToasterHost(b);
  assert.equal(isToasterHost(a), true);
  assert.equal(isToasterHost(b), false);
  releaseA();
  assert.equal(isToasterHost(b), true);
  releaseB();
  assert.equal(isToasterHost(b), false);

  const ui = code('src/components/ui/Toast.tsx');
  assert.match(ui, /useEffect\(\(\) => claimToasterHost\(me\), \[me\]\);/);
  assert.match(ui, /if \(typeof document === 'undefined' \|\| !drawing\) return null;/);
  assert.match(ui, /export \{ toast, toastQueue \} from '\.\.\/\.\.\/lib\/toastStore';/, 'every existing import keeps working');
});

test('the shell mounts the Toaster the first time there is a message — on both layouts, not where a shell has its own', () => {
  const gate = code('src/components/ui/ToasterGate.tsx');
  assert.match(gate, /React\.lazy<ToasterLike>\(\(\) =>\s*import\('\.\/Toast'\)\.then\(\(m\) => \(\{ default: m\.Toaster \}\)\)\.catch\(/, 'lazy, and a failed chunk renders nothing');
  assert.match(gate, /useSyncExternalStore\(subscribeToasts, \(\) => toastQueue\(\)\.length > 0, \(\) => false\)/);
  assert.match(gate, /if \(waiting && !armed\) setArmed\(true\);/, 'mounted once, kept for the visit');
  assert.doesNotMatch(gate, /from '\.\/Toast'/, 'the Toaster is not in the entry chunk');

  const app = code('src/App.tsx');
  assert.match(app, /<\/main>\s*\{!shellHasToaster && <ToasterGate \/>\}/, 'the full-screen layout (no floating nav there)');
  assert.match(app, /<CompareTrayGate \/>\s*\{!shellHasToaster && <ToasterGate aboveNav=\{!navHidden\} \/>\}/, 'the main layout, above the nav while it shows');
  assert.match(
    code('src/components/ui/Toast.tsx'),
    /insetBlockEnd: aboveNav\s*\? 'calc\(max\(var\(--shell-bottom-inset, 0px\), var\(--nav-stack\)\) \+ 0\.75rem\)'/,
    'a toast is never drawn over the nav'
  );
  assert.match(
    app,
    /const shellHasToaster =\s*pathForShell === '\/admin' \|\| pathForShell\.startsWith\('\/admin\/'\) \|\|\s*\(\(pathForShell === '\/merchant' \|\| pathForShell\.startsWith\('\/merchant\/'\)\) && !isMerchantStart\);/
  );
  assert.match(code('src/components/merchant/shell/MerchantShell.tsx'), /<Toaster \/>/, 'the workspace keeps its own');
  assert.match(code('src/pages/Admin.tsx'), /<Toaster \/>/, 'the admin console keeps its own');
});
