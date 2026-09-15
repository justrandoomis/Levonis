/**
 * THE LIVING MASCOT'S SENSES, AS ASSERTIONS.
 *
 * `tests/mascotEngine.test.ts` pins the motion the character makes on its own.
 * This file pins what it does about the USER: following a pointer, noticing a
 * control, letting go again, escalating on a run of quantity presses, and
 * refusing to react to things that are not reactions.
 *
 * Everything under test is pure. The pointer tracker and the interest watcher
 * touch the DOM, so they are exercised through a minimal fake rather than a
 * full browser — what matters about them is not that a listener fires but that
 * the listener is PASSIVE and on the capture phase, which is a property of the
 * registration and can be asserted directly.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  NO_ATTENTION,
  attentionFrom,
  engagementAfter,
  follow,
  followAttention,
  releaseDelay,
  type Attention,
} from '../src/components/bloub/character/attention';
import { applyAttention, attentionLean, POSES } from '../src/components/bloub/character/expressions';
import { introOverlay, sampleCharacter } from '../src/components/bloub/character/engine';
import { classify } from '../src/components/bloub/interest';
import { createMascotController, MASCOT_STATES, type MascotClock } from '../src/lib/mascot';
import { requestFeedbackPolicy } from '../src/lib/mascotRequest';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The same file with its comments removed.
 *
 * Both tracking modules spend a paragraph explaining that they never call
 * `preventDefault` or `setPointerCapture` — which is exactly the prose an
 * assertion searching for those names finds first. Asserting against the code
 * means the guarantee is about what the module DOES, and a module may go on
 * saying why.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

/** The options a listener was registered with, following the one level of
 *  `const opts = { … }` indirection both files actually use. Takes the last
 *  declaration before the call site, which is the one in scope. */
function declared(src: string, argument: string, before: number): string {
  const name = argument.trim();
  if (name.startsWith('{')) return name;
  let found = '';
  for (const d of src.slice(0, before).matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(\{[^}]*\})/g)) {
    if (d[1] === name) found = d[2];
  }
  return found || name;
}

const VIEWPORT = { w: 1280, h: 800 };
/** Where the character actually lives: bottom-centre, in the navigation bar. */
const DOCK = { x: 640, y: 740 };

const look = (point: { x: number; y: number } | null, over: Partial<Parameters<typeof attentionFrom>[0]> = {}) =>
  attentionFrom({ point, center: DOCK, viewport: VIEWPORT, engagement: 1, ...over });

/* ------------------------------------------------------------ §4 §5 gaze */

test('the character looks TOWARDS the pointer, in every direction', () => {
  const above = look({ x: DOCK.x, y: 200 });
  assert.ok(above.y < 0, 'something above has a negative screen y');
  const right = look({ x: 1200, y: DOCK.y });
  assert.ok(right.x > 0);
  const left = look({ x: 40, y: DOCK.y });
  assert.ok(left.x < 0);
  const diagonal = look({ x: 900, y: 400 });
  assert.ok(diagonal.x > 0 && diagonal.y < 0, 'up and to the right is both at once');

  // THE CONTRACT, and it is no longer a unit direction. Each axis is a signed
  // excursion against ITS OWN half of the viewport, so the edge of the screen
  // is exactly 1 on that axis whatever the other one is doing.
  assert.ok(Math.abs(look({ x: 0, y: DOCK.y }).x + 1) < 1e-9, 'the left edge is exactly -1 across');
  assert.ok(Math.abs(look({ x: VIEWPORT.w, y: DOCK.y }).x - 1) < 1e-9, 'and the right edge exactly +1');
  assert.ok(Math.abs(look({ x: DOCK.x, y: 0 }).y + 1) < 1e-9, 'the top edge is exactly -1 up');

  // The thing a unit vector made impossible: a corner is nearly full excursion
  // on BOTH axes at once, not 0.707 of each. Diagonals are where the old
  // mapping lost the most — on a bottom-docked character the vertical distance
  // dominated the hypotenuse and ate the horizontal signal everywhere.
  const corner = look({ x: 6, y: 6 });
  assert.ok(Math.min(Math.abs(corner.x), Math.abs(corner.y)) > 0.9,
    `a corner reaches both axes: ${corner.x.toFixed(3)}, ${corner.y.toFixed(3)}`);
});

test('INTEREST falls off with distance; how far the eyes reach does the opposite', () => {
  const near = look({ x: DOCK.x + 60, y: DOCK.y - 60 });
  const middle = look({ x: DOCK.x + 420, y: DOCK.y - 300 });
  const far = look({ x: 20, y: 20 });

  // Distance is a question about INTEREST, which is what it was always asking.
  assert.ok(near.curiosity > middle.curiosity, 'closer is more interesting');
  assert.ok(near.curiosity > 0.35, 'a pointer right beside the character is interesting');
  assert.equal(middle.curiosity, 0, 'and half a screen away is not — curiosity is not tracking');
  assert.equal(far.curiosity, 0, 'the opposite corner of a desktop is not interesting at all');
  // The brief says do not exaggerate: even at its closest this is a fraction,
  // not a stare.
  assert.ok(near.curiosity <= 1);

  // …and it is NOT a question about how far to look. Distance used to gate the
  // gaze as well, which meant the character reached LESS far for a thing that
  // was further away — it peaked at its own x and retreated towards both edges,
  // and on a phone it went to exactly zero over the top quarter of the screen.
  assert.ok(Math.hypot(far.x, far.y) > Math.hypot(near.x, near.y),
    `the further out the pointer, the FURTHER the eyes reach (${Math.hypot(far.x, far.y).toFixed(2)} vs ${Math.hypot(near.x, near.y).toFixed(2)})`);
  // Weight is the release ramp and the priority damper, and nothing else.
  assert.equal(far.weight, 1, 'a live pointer is a live pointer wherever it is');
  assert.equal(look({ x: 20, y: 20 }, { engagement: 0.4 }).weight, 0.4, 'and weight is the engagement handed in');
});

test('nothing to look at is not the same as looking at the centre', () => {
  assert.deepEqual(look(null), NO_ATTENTION);
  assert.deepEqual(look({ x: 10, y: 10 }, { engagement: 0 }), NO_ATTENTION);
  // A pointer ON the character has no direction; it is not given a random one.
  const onTop = look({ x: DOCK.x, y: DOCK.y });
  assert.equal(onTop.x, 0);
  assert.equal(onTop.y, 0);
  assert.equal(onTop.weight, 1, 'and it is thoroughly noticed');
});

test('a DELIBERATE control is worth looking at from across the room', () => {
  const corner = { x: 40, y: 40 };
  const casual = look(corner);
  const control = look(corner, { deliberate: true });
  assert.ok(casual.curiosity < 0.12, 'a cursor drifting up there is nearly ignored…');
  assert.ok(control.curiosity > 0.5, '…the checkout button in the same place is not');
  // The DIRECTION is identical: importance changes how hard it looks, never
  // where.
  assert.equal(casual.x, control.x);
  assert.equal(casual.y, control.y);
});

/* --------------------------------------------------------- §4 the lag */

test('following is frame-rate independent — the same lag at 60Hz and at 120Hz', () => {
  // Two panels reaching the same instant by different numbers of steps must
  // arrive at the same value, or the character is visibly more sluggish on a
  // high-refresh phone than on a laptop.
  let slow = 0;
  for (let i = 0; i < 30; i++) slow = follow(slow, 1, 1 / 60, 0.2);
  let fast = 0;
  for (let i = 0; i < 60; i++) fast = follow(fast, 1, 1 / 120, 0.2);
  assert.ok(Math.abs(slow - fast) < 0.002, `${slow} vs ${fast}`);
  // And it is a LAG, not a jump: half a second of a 0.2s constant is most of
  // the way there and not all of it.
  assert.ok(slow > 0.7 && slow < 0.95, `half a second in, ${slow}`);
});

test('the eyes turn towards a thing faster than they commit to it', () => {
  const target: Attention = { x: 1, y: 0, weight: 1, curiosity: 1 };
  let a = NO_ATTENTION;
  for (let i = 0; i < 12; i++) a = followAttention(a, target, 1 / 60);
  assert.ok(a.x > a.weight, 'direction leads, commitment follows');
  assert.ok(a.weight > a.curiosity, 'and interest is the slowest of the three');
});

/* ------------------------------------------------- §7 return to idle */

test('the character holds a gaze for two to three seconds, then lets go slowly', () => {
  assert.equal(releaseDelay(0), 2);
  assert.ok(Math.abs(releaseDelay(1) - 3.2) < 1e-9);
  for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
    const d = releaseDelay(roll);
    assert.ok(d >= 2 && d <= 3.2, `${d} is outside the brief's window`);
  }
  // Inside the hold, nothing changes. Past it, a fade — never a cut.
  const hold = releaseDelay(0.5);
  assert.equal(engagementAfter(hold - 0.01, hold), 1);
  assert.equal(engagementAfter(hold, hold), 1);
  const midFade = engagementAfter(hold + 0.5, hold);
  assert.ok(midFade > 0.2 && midFade < 0.8, `${midFade} — a fade, not a step`);
  assert.equal(engagementAfter(hold + 5, hold), 0);
  // Monotone: it never comes back on its own.
  let previous = 1;
  for (let i = 0; i <= 40; i++) {
    const v = engagementAfter(hold + i / 20, hold);
    assert.ok(v <= previous + 1e-9, 'engagement must only ever decrease after the hold');
    previous = v;
  }
});

/* ----------------------------------------- §21 the face moves as one */

test('attention moves the gaze, the eyes, the mouth, the split and the body together', () => {
  const rest = POSES.idle;
  // The corner of the viewport, in the new contract: full excursion on BOTH
  // axes. Under the old unit-direction contract this pair could not exist —
  // a diagonal cost each axis 0.707 — which is most of why the gaze was small.
  const attention: Attention = { x: 1, y: -1, weight: 1, curiosity: 1 };
  const looking = applyAttention(rest, attention);

  assert.ok(looking.gaze.yaw > rest.gaze.yaw + 10, 'the head turned');
  assert.ok(looking.gaze.pitch > rest.gaze.pitch, 'and lifted, because the target is above');
  assert.ok(looking.eyes[0].w > rest.eyes[0].w, 'the eyes widened');
  assert.ok(looking.eyes[0].h > rest.eyes[0].h);
  assert.ok(looking.split > rest.split, 'and moved slightly apart');
  assert.ok(looking.mouth.width < rest.mouth.width, 'the mouth shortened');
  assert.ok(looking.mouth.curve > rest.mouth.curve, 'and lifted');
  assert.ok(looking.wander < rest.wander, 'and the idle drift was damped — it is locked on');
  assert.ok(attentionLean(attention) > 0, 'the body leans towards it');
  assert.ok(attentionLean(attention) < 0.05, 'and the brief asks twice for restraint');
});

test('no attention leaves the pose EXACTLY as it was', () => {
  const rest = POSES.idle;
  assert.equal(applyAttention(rest, null), rest, 'the same object — the common case allocates nothing');
  assert.equal(applyAttention(rest, { x: 1, y: 0, weight: 0, curiosity: 0 }), rest);
});

test('reduced motion keeps the gaze and drops the widening', () => {
  const attention: Attention = { x: 1, y: 0, weight: 1, curiosity: 1 };
  const full = applyAttention(POSES.idle, attention, false);
  const gentle = applyAttention(POSES.idle, attention, true);
  assert.ok(gentle.gaze.yaw > POSES.idle.gaze.yaw, 'the brief keeps semantic feedback under the preference');
  assert.ok(gentle.gaze.yaw < full.gaze.yaw, 'at a fraction of the swing');
  assert.equal(gentle.eyes[0].w, POSES.idle.eyes[0].w, 'and no widening at all');
  assert.equal(attentionLean(attention, true), 0, 'and no body lean');
});

test('a journey outranks a pointer: the gaze belongs to where it is going', () => {
  const attention: Attention = { x: -1, y: 0, weight: 1, curiosity: 1 };
  const travelling = sampleCharacter({
    t: 3,
    state: 'navigating',
    from: null,
    age: 0.4,
    // Heading right (angle 0) while the pointer is hard left.
    travel: { x: 0, y: 0, size: 100, angle: 0, stretch: 0, trail: 0, squash: 0, lead: 1, progress: 0.5, phase: 'move' },
    attention,
    reduced: false,
  });
  const standing = sampleCharacter({ t: 3, state: 'navigating', from: null, age: 0.4, travel: null, attention, reduced: false });
  // Standing still it follows the pointer left; in flight it does not.
  assert.notEqual(travelling.eyes[0].matrix, standing.eyes[0].matrix);
});

/* --------------------------------------------------- §18 the first visit */

test('the character OPENS rather than appearing finished', () => {
  const shut = introOverlay(0.05);
  assert.ok(shut && shut.lid < 0.1, 'it starts with its eyes closed');
  const opening = introOverlay(0.45);
  assert.ok(opening && opening.lid > shut!.lid && opening.lid < 1, 'and opens gradually');
  const looking = introOverlay(0.84);
  assert.ok(looking && Math.abs(looking.yaw) > 5, 'then looks around at where it finds itself');
  const blink = introOverlay(1.13);
  assert.ok(blink && blink.lid < 0.3, 'then blinks, which is what makes it read as an eye');
  assert.equal(introOverlay(1.22), null, 'and then it is simply awake');
  assert.equal(introOverlay(30), null);

  // No step at the end: the last frame of the introduction is already open.
  const last = introOverlay(1.219)!;
  assert.ok(last.lid > 0.97 && Math.abs(last.yaw) < 0.5 && Math.abs(last.pitch) < 0.5);

  // And the lid only ever moves smoothly through it.
  let previous = introOverlay(0)!.lid;
  for (let i = 1; i <= 150; i++) {
    const at = introOverlay(i / 125);
    const lid = at ? at.lid : 1;
    assert.ok(Math.abs(lid - previous) < 0.2, `a step of ${Math.abs(lid - previous).toFixed(3)} at ${(i / 125).toFixed(2)}s`);
    previous = lid;
  }
});

test('an omitted intro is not a NaN face', () => {
  // `intro` is optional, and passing nothing used to produce NaN lids — an eye
  // matrix of NaNs, which renders as nothing and is invisible in review.
  const r = sampleCharacter({ t: 4, state: 'idle', from: null, age: 9, travel: null, reduced: false });
  assert.equal(r.eyes[0].matrix.includes('NaN'), false, r.eyes[0].matrix);
  assert.ok(r.eyes[0].rx > 0 && r.eyes[0].ry > 0);
});

/* ---------------------------------------------- §9 what it notices */

test('importance is DECLARED, never guessed from being a button', () => {
  const el = (attrs: Record<string, string>, classes: string[] = []) => ({
    getAttribute: (n: string) => attrs[n] ?? null,
    classList: { contains: (c: string) => classes.includes(c) },
  }) as unknown as Element;

  // The design system's own primary token, and the three commerce testids.
  assert.equal(classify(el({}, ['lv-button-primary'])), 'cta');
  assert.equal(classify(el({ 'data-testid': 'product-cta' })), 'cta');
  assert.equal(classify(el({ 'data-testid': 'cart-checkout' })), 'cta');
  assert.equal(classify(el({ 'data-testid': 'checkout-place-order' })), 'cta');
  // The opt-in.
  assert.equal(classify(el({ 'data-mascot': 'coupon' })), 'cta');
  assert.equal(classify(el({ 'data-mascot': 'qty-inc' })), 'quantity');
  assert.equal(classify(el({ 'data-mascot': 'qty-dec' })), 'quantity');
  // The opt-out.
  assert.equal(classify(el({ 'data-mascot': 'ignore' })), 'ignore');
  // And everything else is invisible — which is the feature, not a gap.
  assert.equal(classify(el({})), null);
  assert.equal(classify(el({ 'data-testid': 'product-buybar' })), null);
  assert.equal(classify(el({ class: 'bg-gold' }, ['bg-gold'])), null);
  assert.equal(classify(null), null);
});

test('the watchers are passive and on the capture phase, and capture nothing', () => {
  let listeners = 0;
  for (const file of ['src/components/bloub/pointer.ts', 'src/components/bloub/interest.ts']) {
    const src = code(file);
    for (const m of src.matchAll(/addEventListener\(([^)]*)\)/g)) {
      const args = m[1];
      // `blur` carries no options and needs none: it cannot block anything.
      if (args.includes("'blur'")) continue;
      listeners += 1;
      const options = declared(src, args.split(',')[2] ?? '', m.index ?? 0);
      assert.match(options, /passive:\s*true/, `${file}: a listener without { passive: true } can delay a gesture\n${args}`);
      assert.match(options, /capture:\s*true/, `${file}: a listener without { capture: true } is blinded by stopPropagation\n${args}`);
    }
    // Nothing in either file is CAPABLE of taking a gesture away from the page.
    // Asserted against the code rather than the file, because both modules
    // explain in prose the very calls they are careful not to make.
    for (const forbidden of ['preventDefault', 'stopPropagation', 'setPointerCapture', 'stopImmediatePropagation']) {
      assert.equal(src.includes(forbidden), false, `${file} calls ${forbidden} — the brief forbids capturing a page gesture`);
    }
  }
  assert.ok(listeners >= 8, `only ${listeners} listeners found — a rename has made this test vacuous`);
});

test('nothing in the tracking path touches React state or measures in a loop', () => {
  const pointer = code('src/components/bloub/pointer.ts');
  assert.equal(/getBoundingClientRect|offsetWidth|getComputedStyle/.test(pointer), false, 'the pointer tracker measures nothing');
  assert.equal(/useState|setState|dispatch/.test(pointer), false, '§23: no framework state on a pointermove');

  // The loop itself: the only layout read is on the scheduled measure pass.
  const intro = code('src/components/bloub/AppIntro.tsx');
  const tick = intro.slice(intro.indexOf('const tick = '), intro.indexOf('const start = '));
  assert.ok(tick.length > 400, 'the draw loop was not found — this test would otherwise assert nothing');
  assert.equal(/getBoundingClientRect/.test(tick), false, 'the draw loop reads no layout');
  assert.equal(/set[A-Z]\w*\(/.test(tick), false, 'and re-renders nothing');
  // And the pass that DOES measure is the rAF-throttled one, not a listener.
  assert.match(intro, /const measure = \(\)[\s\S]{0,600}centreOf\(/, 'the control is re-measured on the layout pass');
});

/* ------------------------------------------------ §11 quantity escalation */

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const clock: MascotClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const key = ++id;
      timers.set(key, { at: now + ms, fn });
      return key as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (key) => void timers.delete(key as unknown as number),
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [key, t] of [...timers]) if (t.at <= now) { timers.delete(key); t.fn(); }
    },
  };
}

test('one step up is a glance; a run of them is being taken aback', () => {
  const { clock, advance } = fakeClock();
  const c = createMascotController(clock);

  c.quantity(2, 1);
  assert.equal(c.snapshot().state, 'curious', 'the first press is noticed and no more than that');
  advance(500);
  assert.equal(c.snapshot().state, 'idle');

  // Three in a row, still small numbers.
  c.quantity(2, 1); advance(200);
  c.quantity(3, 2); advance(200);
  c.quantity(4, 3);
  assert.equal(c.snapshot().state, 'surprised', "kept going — «oh, that's a lot»");
  c.dispose();
});

test('a jump the user did not arrive at one tap at a time is surprising on its own', () => {
  const { clock } = fakeClock();
  const c = createMascotController(clock);
  c.quantity(4, 1);
  assert.equal(c.snapshot().state, 'surprised');
  c.dispose();
});

test('a quantity that is simply a lot is surprising, once', () => {
  const { clock, advance } = fakeClock();
  const c = createMascotController(clock);
  c.quantity(5, 4);
  assert.equal(c.snapshot().state, 'surprised');
  advance(800);
  // A fourth, fifth, sixth press changes nothing: it has already said the
  // thing it had to say.
  c.quantity(6, 5);
  const after = c.snapshot();
  c.quantity(7, 6);
  assert.equal(c.snapshot().state, after.state, 'no escalation beyond surprised');
  c.dispose();
});

test('stepping DOWN says nothing, and a long gap resets the run', () => {
  const { clock, advance } = fakeClock();
  const c = createMascotController(clock);
  c.quantity(2, 1); advance(500);
  c.quantity(1, 2);
  assert.equal(c.snapshot().state, 'idle', 'a correction is not commented on');

  // Two increases, a minute of nothing, then a third: not a run.
  c.quantity(2, 1); advance(300);
  c.quantity(3, 2); advance(60_000);
  c.quantity(4, 3);
  assert.equal(c.snapshot().state, 'curious', 'the streak expired with the pause');
  c.dispose();
});

test('nonsense is ignored rather than animated', () => {
  const { clock } = fakeClock();
  const c = createMascotController(clock);
  c.quantity(Number.NaN, 1);
  c.quantity(2, Number.POSITIVE_INFINITY);
  assert.equal(c.snapshot().state, 'idle');
  c.dispose();
});

/* ----------------------------------------------------- §22 the priority */

test('the ladder: a failure outranks work, work outranks a journey, and curiosity outranks nothing but rest', () => {
  const p = (s: keyof typeof MASCOT_STATES) => MASCOT_STATES[s].priority;
  assert.ok(p('error') > p('warning'));
  assert.ok(p('warning') > p('loading'));
  assert.ok(p('loading') > p('navigating'));
  assert.ok(p('celebrate') > p('success'), 'an order is bigger than an add to cart');
  assert.ok(p('celebrate') > p('notify'));
  assert.ok(p('surprised') > p('success'));
  assert.ok(p('curious') > p('idle'), 'noticing is more than resting');
  assert.ok(p('curious') < p('success'), '…and less than everything else');
  assert.ok(p('curious') < p('arrival'));
  assert.ok(p('curious') < p('navigating'));
  assert.ok(p('curious') < p('error'));
});

test('a pointer crossing a button cannot interrupt a real reaction', () => {
  const { clock, advance } = fakeClock();
  const c = createMascotController(clock);
  c.outcome('failed');
  assert.equal(c.snapshot().state, 'error');
  const release = c.begin('curious');
  assert.equal(c.snapshot().state, 'error', 'the failure keeps the face');
  advance(MASCOT_STATES.error.duration + 1);
  assert.equal(c.snapshot().state, 'curious', 'and hands it back afterwards — §22');
  release();
  assert.equal(c.snapshot().state, 'idle');
  c.dispose();
});

test('every outcome names what happened, not which animation to play', () => {
  const { clock, advance } = fakeClock();
  const c = createMascotController(clock);
  const seen = (kind: Parameters<typeof c.outcome>[0]) => {
    c.outcome(kind);
    const state = c.snapshot().state;
    advance(3000);
    return state;
  };
  assert.equal(seen('added'), 'success');
  assert.equal(seen('ordered'), 'celebrate', 'an order is the biggest thing that happens here');
  assert.equal(seen('removed'), 'surprised', 'the user asked for it — noticed, not mourned');
  assert.equal(seen('failed'), 'error');
  assert.equal(seen('rejected'), 'warning');
  assert.equal(seen('saved'), 'success');
  c.dispose();
});

/* ------------------------------------------ §13 §16 the real result */

test('the character reacts to the application result, not to the HTTP status', () => {
  // A route that answers "no" with a 200 is not a success.
  assert.equal(requestFeedbackPolicy('POST', '/api/cart/coupon-check').success, false);
  assert.equal(requestFeedbackPolicy('POST', '/api/auth/verify').success, false);
  // An ordinary mutation still is.
  assert.equal(requestFeedbackPolicy('POST', '/api/cart/items').success, true);
  assert.equal(requestFeedbackPolicy('POST', '/api/orders').success, true);
  // A quote is a calculation, not an achievement.
  assert.equal(requestFeedbackPolicy('POST', '/api/orders/quote').success, false);
  // Reads never celebrate.
  assert.equal(requestFeedbackPolicy('GET', '/api/cart').success, false);
  // And the caller may always silence one.
  assert.equal(requestFeedbackPolicy('GET', '/api/cart', 'silent').silent, true);
});

test('not being signed in is not a failure, and a background poll is not work', () => {
  const src = read('src/lib/mascotRequest.ts');
  assert.match(src, /NOT_A_FAILURE[\s\S]{0,80}401/, '401 must not paint a concerned face');
  assert.match(src, /NOT_A_FAILURE\.has\(error\.status/);
  assert.match(src, /background > 0/, 'a timer-driven refresh must not drive the loading face');
  // The refresher raises the flag for its OWN calls and not for a wake.
  const fresh = read('src/lib/useFreshOnReturn.ts');
  assert.match(fresh, /duringBackgroundRefresh/);
  assert.match(fresh, /run\(false, true\)/, 'only the interval passes background: true');
  assert.equal(/onWake = \(\) => void run\(false, true\)/.test(fresh), false, 'a user returning to the tab IS work they are waiting for');
});

/* -------------------------------------------------- the visual contract */

test('the character has no outer outline, and its highlight is a fill', () => {
  const svg = read('src/components/bloub/BloubHome.tsx');
  const body = svg.slice(svg.indexOf('ref={body}'), svg.indexOf('ref={bounce}'));
  assert.equal(/stroke=/.test(body), false, 'the brief is explicit: no visible outer outline');
  // The gloss is filled with a gradient, never stroked.
  const gloss = svg.slice(svg.indexOf('ref={gloss}'), svg.indexOf('ref={gloss}') + 200);
  assert.match(gloss, /fill="url\(#levonis-bloub-gloss\)"/);
  assert.equal(/stroke/.test(gloss), false, 'a stroked highlight is a line drawn on the character');
  // …and that gradient ends in nothing, which is what makes the shape's own
  // edge invisible.
  assert.match(svg, /id="levonis-bloub-gloss"[\s\S]{0,400}stopOpacity="0"\s*\/>/);
  // No pupils anywhere: the eyes are two solid cream shapes and nothing else.
  assert.equal(/pupil/i.test(svg), false);
  assert.equal((svg.match(/data-bloub-eye=/g) ?? []).length, 2);
});

test('the eyes are large and vertically elongated, as the reference render is', () => {
  const face = read('src/components/bloub/character/face.ts');
  const w = Number(/EYE_W = ([\d.]+)/.exec(face)?.[1]);
  const h = Number(/EYE_H = ([\d.]+)/.exec(face)?.[1]);
  assert.ok(w > 8 && w < 10, `EYE_W ${w}`);
  assert.ok(h > 18 && h < 21, `EYE_H ${h}`);
  assert.ok(h / w > 2.1, `the capsule must stay tall: ratio ${(h / w).toFixed(2)}`);
  // Larger than the character carried before, which is what the brief asks.
  assert.ok(w > 7.6 && h > 16.6);
});

test('every state still draws a closed body, a gloss, a bounce and two eyes', () => {
  for (const state of Object.keys(POSES) as Array<keyof typeof POSES>) {
    const r = sampleCharacter({ t: 6.1, state, from: POSES.idle, age: 0.35, travel: null, attention: null, reduced: false });
    assert.match(r.body, /^M .* Z$/, `${state} body`);
    assert.match(r.gloss, /^M .* Z$/, `${state} gloss is a closed lens`);
    assert.match(r.bounce, /^M .* Z$/, `${state} bounce`);
    for (const eye of r.eyes) {
      assert.equal(eye.matrix.includes('NaN'), false, `${state} eye matrix`);
      assert.ok(eye.rx > 0 && eye.ry > 0, `${state} eye size`);
    }
  }
});
