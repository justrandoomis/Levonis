/**
 * THE SHARE PANEL (src/components/merchant/share/, merchant platform W2-D).
 *
 * Its decisions are pure functions, pinned here under `node --test`; its
 * wiring — where it is mounted, what the storefront pays for it, which
 * strings are hand-written Sorani — is pinned by reading the source, the way
 * this repository pins the rest of its client wiring.
 *
 * The QR code is DECODED with the same scanner library the app ships
 * (`jsqr`), from the exact pixels the download writes: the code the merchant
 * prints scans to the store's address and to nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
import {
  ICON_POLL_LIMIT,
  QR_QUIET_ZONE,
  canShareNatively,
  displayAddress,
  isShareAbort,
  qrFileName,
  qrPngGeometry,
  shouldPollIcon,
  storeQr,
} from '../src/components/merchant/share/shareStoreModel';
import { iconStateLine, shareStrings } from '../src/components/merchant/share/strings';

const SRC = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The download's pixels: white ground, black modules, whole pixels per module. */
function rasterise(url: string) {
  const qr = storeQr(url);
  assert.ok(qr);
  const { scale, side } = qrPngGeometry(qr.matrix);
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < qr.matrix.size; y++) {
    for (let x = 0; x < qr.matrix.size; x++) {
      if (!qr.matrix.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + QR_QUIET_ZONE) * scale + dy) * side + (x + QR_QUIET_ZONE) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, side, scale, qr };
}

test('the QR code scans to the store\'s address, exactly', () => {
  for (const url of ['https://ali3d.levonis-iq.com', 'https://levonis-iq.com/community/store/str_0123456789abcdef0123']) {
    const { data, side } = rasterise(url);
    const decoded = jsQR(data, side, side);
    assert.equal(decoded?.data, url);
  }
});

test('the QR geometry: the spec\'s quiet zone, whole pixels per module, print-sized', () => {
  const qr = storeQr('https://ali3d.levonis-iq.com');
  assert.ok(qr);
  assert.equal(qr.viewBox, qr.matrix.size + 2 * QR_QUIET_ZONE);
  assert.equal(QR_QUIET_ZONE, 4, 'ISO/IEC 18004 asks for four modules');
  const { scale, side } = qrPngGeometry(qr.matrix);
  assert.ok(Number.isInteger(scale) && scale >= 8);
  assert.equal(side, qr.viewBox * scale);
  assert.ok(side <= 1024 && side > 700, `${side}px`);
});

test('a link the encoder cannot hold is an honest null, never a truncated code', () => {
  assert.equal(storeQr(''), null);
  assert.equal(storeQr(`https://x.levonis-iq.com/${'a'.repeat(400)}`), null);
});

test('the downloaded file is named after the address, and nothing path-like survives', () => {
  assert.equal(qrFileName('ali3d.levonis-iq.com', 'https://ali3d.levonis-iq.com'), 'ali3d.levonis-iq.com-qr.png');
  assert.equal(qrFileName('', 'https://levonis-iq.com/community/store/s1'), 'levonis-iq.com-qr.png');
  assert.equal(qrFileName('', 'not a url'), 'store-qr.png');
  assert.equal(qrFileName('../../etc/Passwd', ''), 'etc-passwd-qr.png');
  assert.equal(displayAddress({ host: 'ali3d.levonis-iq.com', url: 'https://ali3d.levonis-iq.com' }), 'ali3d.levonis-iq.com');
  assert.equal(displayAddress({ host: '', url: 'https://levonis-iq.com/community/store/s1' }), 'https://levonis-iq.com/community/store/s1');
});

test('the system share sheet is offered only where it exists — no button that cannot work', () => {
  const url = 'https://ali3d.levonis-iq.com';
  assert.equal(canShareNatively(undefined, url), false);
  assert.equal(canShareNatively({} as Navigator, url), false);
  const share = async () => undefined;
  assert.equal(canShareNatively({ share } as unknown as Navigator, url), true, 'no canShare: share is the answer');
  assert.equal(canShareNatively({ share, canShare: () => false } as unknown as Navigator, url), false);
  assert.equal(canShareNatively({ share, canShare: () => { throw new Error('x'); } } as unknown as Navigator, url), false);
  assert.equal(isShareAbort(Object.assign(new Error('closed'), { name: 'AbortError' })), true);
  assert.equal(isShareAbort(new Error('boom')), false);
  assert.equal(isShareAbort(null), false);
});

test('the icon is asked for again while it is being cut — a few times, then never', () => {
  assert.equal(shouldPollIcon('pending', 0), true);
  assert.equal(shouldPollIcon('pending', ICON_POLL_LIMIT), false);
  for (const state of ['ready', 'failed', 'unavailable', 'none']) assert.equal(shouldPollIcon(state, 0), false, state);
});

const EN = (ar: string, en: string) => en;
const AR = (ar: string) => ar;

test('every icon state and reason has its own sentence, and a code never reaches the screen', () => {
  const lines = new Set<string>();
  for (const [state, reason] of [
    ['ready', null],
    ['pending', null],
    ['none', 'NO_LOGO'],
    ['unavailable', 'IMAGES_UNAVAILABLE'],
    ['failed', 'SOURCE_TOO_SMALL'],
    ['failed', 'SOURCE_TOO_LARGE'],
    ['failed', 'SOURCE_NOT_IMAGE'],
    ['failed', 'SOURCE_MISSING'],
    ['failed', 'RENDITION_FAILED'],
  ] as const) {
    const en = iconStateLine(EN, state, reason);
    const ar = iconStateLine(AR, state, reason);
    assert.ok(en.length > 10 && ar.length > 10, `${state}/${reason}`);
    assert.doesNotMatch(en, /[A-Z]{3,}_[A-Z]/, 'a stable code leaked into the sentence');
    lines.add(en);
  }
  assert.equal(lines.size, 9 - 0, 'each case says something different');
  // An unknown reason is the generic, retrying line — not a crash, not the code.
  assert.equal(iconStateLine(EN, 'failed', 'WHO_KNOWS'), iconStateLine(EN, 'failed', 'RENDITION_FAILED'));
  // The actionable ones tell the merchant what to do.
  assert.match(iconStateLine(EN, 'failed', 'SOURCE_TOO_SMALL'), /512×512/);
  assert.match(iconStateLine(EN, 'none', null), /Store identity/);
});

test('Sorani is never machine-written: every Sorani line in the panel is reused verbatim from the app', () => {
  // docs/DECISIONS.md row 11. Every third argument to `loc(...)` in the
  // feature's strings must already exist, word for word, somewhere the owner
  // wrote it; everything else passes only Arabic and English.
  const strings = readFileSync(new URL('../src/components/merchant/share/strings.ts', import.meta.url), 'utf8');
  const ckb = [...strings.matchAll(/loc\(\s*'[^']*',\s*'[^']*',\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(ckb.length >= 5, `expected the reused lines, saw ${ckb.length}`);
  const elsewhere = [
    SRC('pages/Storefront.tsx'),
    SRC('components/profile/QrCodeModal.tsx'),
    readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'),
  ].join('\n');
  for (const line of ckb) assert.ok(elsewhere.includes(line), `«${line}» is not hand-written anywhere else`);
  // And the lines that are new are marked for the owner.
  const owners = (strings.match(/OWNER: Sorani to be written by hand\./g) ?? []).length;
  assert.ok(owners >= 20, `${owners} OWNER marks`);
  // Every string is built — no empty labels in any language.
  const s = shareStrings(EN);
  for (const [key, value] of Object.entries(s)) assert.ok(value.trim().length > 0, key);
});

// ----------------------------------------------------------------- the wiring

test('the panel is mounted in the dashboard\'s store settings, outside the form\'s save', () => {
  const tab = SRC('components/merchant/dashboard/StoreSettingsTab.tsx');
  assert.match(tab, /import ShareStore from '\.\.\/share\/ShareStore';/);
  const mount = tab.indexOf('<ShareStore />');
  assert.ok(mount > 0, 'not mounted');
  assert.ok(mount > tab.indexOf('<Btn onClick={save}'), 'it has its own actions; it is not part of the settings form');
});

test('the storefront menu carries the owner row, and the storefront pays only for the row', () => {
  const storefront = SRC('pages/Storefront.tsx');
  // W2-F: the row is a LAZY import of the «…» menu, so a customer's visit
  // downloads neither it nor its strings (tests/bundleBudget.test.ts).
  assert.match(storefront, /const OwnerShareMenuItem = lazy\(\(\) => import\('\.\.\/components\/merchant\/share\/OwnerShareMenuItem'\)\);/);
  assert.doesNotMatch(storefront, /import OwnerShareMenuItem from/);
  assert.match(storefront, /<StoreMenu url=\{store\.url\} name=\{store\.name\} loc=\{loc\} storeId=\{store\.id\} \/>/);
  assert.match(storefront, /<OwnerShareMenuItem\s+storeId=\{storeId\}\s+onDone=\{\(\) => setOpen\(false\)\}/);
  // The heavy half — the panel and the QR encoder — is a lazy chunk.
  const row = code(SRC('components/merchant/share/OwnerShareMenuItem.tsx'));
  assert.match(row, /lazy\(\(\) => import\('\.\/ShareStoreSheet'\)\)/);
  assert.doesNotMatch(row, /from '\.\/ShareStore'|profile\/qr|shareStoreModel/, 'the storefront would ship the encoder');
  // Ownership is the server's answer: the row shows itself only for the store on screen.
  assert.match(row, /k\.store_id === storeId/);
  assert.match(row, /if \(!user \|\| !storeId\) return;/, 'a signed-out visitor never asks');
});

test('the panel asks the server route that exists, and does nothing the house rules forbid', () => {
  const api = SRC('components/merchant/share/shareStoreApi.ts');
  assert.match(api, /'\/api\/merchant\/store\/share'/);
  const merchant = readFileSync(new URL('../worker/routes/merchant.ts', import.meta.url), 'utf8');
  assert.match(merchant, /merchantRoutes\.get\('\/store\/share'/);
  for (const file of ['ShareStore.tsx', 'ShareStoreSheet.tsx', 'OwnerShareMenuItem.tsx', 'shareStoreModel.ts', 'strings.ts']) {
    const text = code(SRC(`components/merchant/share/${file}`));
    assert.doesNotMatch(text, /\bconfirm\(|\balert\(/, `${file}: no native dialogs`);
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|<iframe/i, `${file}`);
    assert.doesNotMatch(text, /levonis-iq\.com/, `${file} hard-codes the platform domain`);
    // Logical properties only: a physical left/right would mirror wrongly in RTL.
    assert.doesNotMatch(text, /\b(?:ml|mr|pl|pr|left|right)-\d/, `${file}: use ms/me/ps/pe/start/end`);
  }
  const panel = code(SRC('components/merchant/share/ShareStore.tsx'));
  // The QR keeps its own white ground and crisp modules, or it does not scan.
  assert.match(panel, /bg-white/);
  assert.match(panel, /shapeRendering="crispEdges"/);
  // Every control is a real button with a 44 px target (lv-button).
  assert.ok((panel.match(/className="lv-button /g) ?? []).length >= 4);
});
