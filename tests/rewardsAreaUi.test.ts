/**
 * «المكافآت» — THE REWARDS AREA'S DESIGN RULES, HELD IN ITS SOURCE (rewards
 * spec §2.5, §7 and §11; DECISIONS row 290).
 *
 * The area is built from the house primitives and `lv-*` classes only, with a
 * gold budget and one raised card per screen at most, so that no page reads
 * louder than the one thing it asks the customer to do. These are the rules a
 * later edit is most likely to break without noticing:
 *   1. the raised cards: the hub's «بانتظارك» card or its guest card (never
 *      both), the focal coupon, the focal printer — nothing else is raised;
 *   2. the primaries: «كوبوناتي» has exactly one, the competitions list none
 *      (its rows are links; a row carries no button);
 *   3. every live clock counts to the server's instant (`toDeviceTarget`);
 *   4. no fixed bar, no celebration, no decorative motion, no theme-specific
 *      colour, no arbitrary radius, no 32 px copy button;
 *   5. the competitions tabs keep one label weight and their own group;
 *   6. no sheet has detents (its grabber's Sorani labels are placeholders);
 *   7. the hub's badges are neutral;
 *   8. every image says how wide it is drawn.
 *
 * Source assertions — the screens are not imported: this repository has no
 * browser runner, and the client project is not type-checked strictly.
 *
 * Run: node --import tsx --test tests/rewardsAreaUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code only: a comment that names a banned class must not fail the test that bans it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const DIR = 'src/components/rewards';
const FRAME = 'src/pages/RewardsArea.tsx';

/** The area's files: src/pages/RewardsArea.tsx and everything under src/components/rewards. */
function areaFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(ROOT, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (/\.tsx?$/.test(name)) out.push(child);
    }
  };
  walk(DIR);
  out.push(FRAME);
  return out;
}

const count = (src: string, needle: string) => src.split(needle).length - 1;

/**
 * Each opening tag `<Name …>` / `<Name … />` in a file's code, attributes
 * included: braces are balanced, so an arrow (`=>`) or a nested element inside
 * an attribute does not end the tag.
 */
function tags(src: string, name: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${name}\\b`, 'g');
  for (let m = open.exec(src); m; m = open.exec(src)) {
    let depth = 0;
    let end = m.index + m[0].length;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, end + 1));
  }
  return out;
}

test('the area files are where these rules look', () => {
  const files = areaFiles();
  for (const f of ['HubScreen.tsx', 'CouponsScreen.tsx', 'ShopScreen.tsx', 'RateScreen.tsx', 'CompetitionsScreen.tsx', 'CompetitionScreen.tsx', 'EntrySheet.tsx', 'AreaChrome.tsx', 'couponUse.tsx']) {
    assert.ok(files.includes(`${DIR}/${f}`), `${DIR}/${f} moved — update this test, do not delete it`);
  }
});

// ------------------------------------------------------------ 1. one raised card per screen at most

test('raised cards: the hub\'s «بانتظارك» or its guest card, the focal coupon, the focal printer — nothing else', () => {
  const expected: Record<string, number> = {
    [`${DIR}/HubScreen.tsx`]: 2,
    [`${DIR}/CouponsScreen.tsx`]: 1,
    [`${DIR}/RateScreen.tsx`]: 1,
  };
  const found: Record<string, number> = {};
  for (const f of areaFiles()) {
    const n = count(code(f), 'lv-surface-raised');
    if (n || expected[f]) found[f] = n;
  }
  assert.deepEqual(found, expected);
  // The hub's two are never on one screen: the frame draws HubGuest for a guest and HubScreen otherwise.
  const hub = code(`${DIR}/HubScreen.tsx`);
  assert.match(hub, /<section aria-labelledby="now-eyebrow" data-rewards-now=\{kind\} className="lv-surface-raised p-4 space-y-3">/);
  assert.match(hub, /<section aria-labelledby="hub-guest-title" className="lv-surface-raised p-5 space-y-4">/);
  assert.doesNotMatch(hub, /<HubGuest\b/, 'HubScreen draws the guest card beside its own');
  const frame = code(FRAME);
  assert.match(frame, /else if \(!isAuthenticated\) screen = section === 'home' \? <HubGuest \/> : <SectionGuest section=\{section\} \/>;/);
  // The competition's status card is raised from 1024 px only, where it holds the call to action.
  assert.match(code(`${DIR}/CompetitionScreen.tsx`), /lg:bg-surface-raised lg:shadow-lg/);
});

// ------------------------------------------------------------ 2. the primaries

test('«كوبوناتي» has exactly one primary (the focal coupon\'s); the competitions list has none', () => {
  const coupons = code(`${DIR}/CouponsScreen.tsx`);
  assert.equal(count(coupons, 'variant="primary"'), 1);
  assert.equal(count(coupons, 'lv-button-primary'), 0);
  const list = code(`${DIR}/CompetitionsScreen.tsx`);
  assert.equal(count(list, 'variant="primary"'), 0, 'a row of the list carries a primary button');
  assert.equal(count(list, 'lv-button-primary'), 0, 'a row of the list carries a primary link');
});

// ------------------------------------------------------------ 3. live clocks

test('every live clock in the area counts to the server\'s instant, moved onto the device clock', () => {
  let clocks = 0;
  for (const f of areaFiles()) {
    for (const tag of tags(code(f), 'Countdown')) {
      clocks++;
      assert.match(tag, /\btarget=\{toDeviceTarget\(/, `${f}: a countdown reads the device clock — ${tag.slice(0, 100)}`);
    }
  }
  assert.ok(clocks >= 6, `the area's countdowns were not found (${clocks})`);
});

// ------------------------------------------------------------ 4. what the area never draws

test('no fixed bar, celebration, decorative motion, theme-specific colour, arbitrary radius or 32 px copy button', () => {
  const BANNED: ReadonlyArray<[RegExp, string]> = [
    [/fixed bottom-0/, 'a fixed bottom bar (the CTA bar sits after the scroller)'],
    [/--nav-stack/, 'the bottom-nav stack (the area is a full-screen page)'],
    [/lv-celebration/, 'a celebration'],
    [/hover:scale/, 'a hover zoom'],
    [/transition-shadow/, 'an animated shadow'],
    [/ring-gold/, 'a gold focus ring (the ring is always ring-focus)'],
    [/rounded-\[/, 'an arbitrary radius'],
    [/-zinc-|\bzinc-\d/, 'a zinc utility'],
    [/\bdark:/, 'a dark-only variant (tokens carry both themes)'],
    [/#[0-9a-fA-F]{3,8}\b/, 'a hex colour'],
    [/backdrop-blur|\bblur-/, 'a blur'],
    [/\bInlineCopy\b/, 'InlineCopy (its button is 32 px)'],
  ];
  const bad: string[] = [];
  for (const f of areaFiles()) {
    const src = code(f);
    for (const [re, what] of BANNED) if (re.test(src)) bad.push(`${f}: ${what}`);
  }
  assert.deepEqual(bad, []);
});

// ------------------------------------------------------------ 5. the competitions tabs

test('the competitions tabs keep one label weight and a group of their own', () => {
  const strips: string[] = [];
  for (const f of areaFiles()) for (const tag of tags(code(f), 'TabStrip')) strips.push(tag);
  assert.equal(strips.length, 1, 'one TabStrip in the area');
  const [strip] = strips;
  assert.doesNotMatch(strip, /\b(activeClassName|idleClassName)=/, 'a second weight makes a Sorani strip reflow');
  assert.match(strip, /group="rewards-competitions"/);
  assert.match(strip, /\bpanels\b/);
  assert.match(strip, /\bfill\b/, 'two equal tabs that never scroll');
  // The panels are wired to the same group, and no other screen of the app uses it.
  assert.match(code(`${DIR}/CompetitionsScreen.tsx`), /<TabPanels value=\{view\} order=\{\['current', 'results'\]\} group="rewards-competitions">/);
  const area = new Set(areaFiles());
  const walk = (rel: string, out: string[] = []): string[] => {
    for (const name of readdirSync(join(ROOT, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(ROOT, child)).isDirectory()) walk(child, out);
      else if (/\.tsx?$/.test(name)) out.push(child);
    }
    return out;
  };
  assert.deepEqual(walk('src').filter((f) => !area.has(f) && read(f).includes('rewards-competitions')), []);
});

// ------------------------------------------------------------ 6. sheets

test('no sheet in the area has detents', () => {
  let sheets = 0;
  for (const f of areaFiles()) {
    const src = code(f);
    sheets += tags(src, 'Sheet').length;
    assert.doesNotMatch(src, /\bdetents\b/, `${f}: a sheet with detents draws a grabber whose Sorani labels are placeholders`);
  }
  assert.ok(sheets >= 2, `the targets sheet and the entry sheet were not found (${sheets})`);
});

// ------------------------------------------------------------ 7. badges

test('the hub\'s badges are neutral (gold is the coin\'s alone)', () => {
  const hub = code(`${DIR}/HubScreen.tsx`);
  assert.doesNotMatch(hub, /tone="accent"/);
  for (const tag of tags(hub, 'Badge')) assert.match(tag, /tone="neutral"/, tag);
  // The doors draw CountBadge, whose Badge is neutral and hidden from assistive tech.
  assert.match(hub, /<CountBadge n=\{door\.badge\} \/>/);
  assert.match(code(`${DIR}/AreaChrome.tsx`), /<span aria-hidden="true">\s*<Badge tone="neutral">\{n\}<\/Badge>\s*<\/span>/);
});

// ------------------------------------------------------------ 8. images

test('every image in the area states the width it is drawn at', () => {
  let images = 0;
  for (const f of areaFiles()) {
    for (const tag of tags(code(f), 'SafeImage')) {
      images++;
      assert.match(tag, /\bsizes=/, `${f}: ${tag.slice(0, 100)}`);
    }
  }
  assert.ok(images >= 7, `the area's images were not found (${images})`);
});
