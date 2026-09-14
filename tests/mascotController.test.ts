import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMascotController, createUnreadObserver, isMascotState, MASCOT_STATES, movementDirection, type MascotClock } from '../src/lib/mascot';
import { requestFeedbackPolicy } from '../src/lib/mascotRequest';
import { readFileSync } from 'node:fs';

function fixture() {
  let now = 0; let counter = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: MascotClock = {
    now: () => now,
    setTimer(fn, ms) { const id = ++counter; timers.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer(id) { timers.delete(id as unknown as number); },
  };
  const controller = createMascotController(clock);
  return { controller, timers, advance(ms: number) {
    const end = now + ms;
    for (let n = 0; n < 100; n++) {
      const first = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      now = first[1].at; timers.delete(first[0]); first[1].fn();
    }
    now = end;
  } };
}

test('first bootstrap work enters loading and its settlement returns to idle', () => {
  const {controller:c} = fixture(); c.activity('bootstrap','loading'); assert.equal(c.snapshot().state,'loading');
  c.activity('bootstrap',null); assert.equal(c.snapshot().state,'idle'); c.dispose();
});
test('overlapping loads use independent, idempotently released leases', () => {
  const {controller:c} = fixture(); const a=c.begin('loading'), b=c.begin('loading');
  a(); a(); assert.equal(c.snapshot().state,'loading'); b(); assert.equal(c.snapshot().state,'idle');
});
test('navigation and arrival do not reset an active error expression', () => {
  const {controller:c,advance} = fixture(); c.trigger('error'); c.activity('anchor-travel','navigating');
  c.look(0,-700); assert.equal(c.snapshot().state,'error'); assert.equal(c.snapshot().direction.y,-1);
  c.navigationComplete(); assert.equal(c.snapshot().state,'error'); advance(2200); assert.equal(c.snapshot().state,'idle');
});
test('remote typing resumes under loading and stops when its lease is released', () => {
  const {controller:c} = fixture(); const typing=c.begin('typing'); assert.equal(c.snapshot().state,'typing');
  const load=c.begin('loading'); assert.equal(c.snapshot().state,'loading'); load(); assert.equal(c.snapshot().state,'typing');
  typing(); assert.equal(c.snapshot().state,'idle');
});
test('priority error > warning > loading > typing > navigation > notification > success', () => {
  const {controller:c,advance} = fixture(); c.trigger('success'); c.trigger('notify'); assert.equal(c.snapshot().state,'notify');
  const nav=c.begin('navigating'); const typing=c.begin('typing'); const load=c.begin('loading');
  assert.equal(c.snapshot().state,'loading'); c.trigger('warning'); assert.equal(c.snapshot().state,'warning');
  c.trigger('error'); c.trigger('success'); assert.equal(c.snapshot().state,'error');
  advance(2200); assert.equal(c.snapshot().state,'loading'); load(); assert.equal(c.snapshot().state,'typing');
  typing(); assert.equal(c.snapshot().state,'navigating'); nav(); assert.equal(c.snapshot().state,'idle');
});
for (const state of ['tap','success','warning','error','notify','arrival','navigating','returning'] as const) {
  test(`${state} expires instead of sticking or resurrecting later`, () => {
    const {controller:c,advance,timers}=fixture(); c.trigger(state); assert.equal(c.snapshot().state,state);
    assert.equal(timers.size,1); advance(MASCOT_STATES[state].duration+1); assert.equal(c.snapshot().state,'idle'); assert.equal(timers.size,0);
  });
}
test('hidden document rests without timers, retains only real work on return', () => {
  const {controller:c,timers,advance}=fixture(); const stop=c.begin('loading'); c.trigger('error'); c.setVisible(false);
  assert.equal(c.snapshot().state,'sleep'); assert.equal(timers.size,0); c.trigger('notify'); advance(10000);
  c.setVisible(true); assert.equal(c.snapshot().state,'loading'); stop(); assert.equal(c.snapshot().state,'idle');
});
test('tap reacts immediately during loading without interrupting an error', () => {
  const {controller:c,advance}=fixture(); const release=c.begin('loading'); c.trigger('tap'); assert.equal(c.snapshot().state,'tap');
  advance(211); assert.equal(c.snapshot().state,'loading'); c.trigger('error'); c.trigger('tap'); assert.equal(c.snapshot().state,'error'); release(); c.dispose();
});
test('direction is physical, normalized, safe for coincident or invalid anchors', () => {
  assert.deepEqual(movementDirection(0,-100),{x:0,y:-1}); assert.deepEqual(movementDirection(0,100),{x:0,y:1});
  assert.deepEqual(movementDirection(0,0),{x:0,y:0}); assert.deepEqual(movementDirection(NaN,1),{x:0,y:0});
});
test('unchanged work does not emit a new snapshot every layout measurement', () => {
  const {controller:c}=fixture(); let n=0; const off=c.subscribe(()=>n++);
  c.activity('header','loading'); const before=c.snapshot(); c.activity('header','loading');
  assert.equal(c.snapshot(),before); assert.equal(n,1); off(); c.dispose();
});
test('all states are recognized; arbitrary/prototype names are rejected', () => {
  for(const state of Object.keys(MASCOT_STATES)) assert.ok(isMascotState(state));
  for(const state of [undefined,null,{},'constructor','toString','unknown']) assert.equal(isMascotState(state),false);
});
test('unread baseline and decreases are silent; only a new increase notifies', () => {
  let n=0; const unread=createUnreadObserver(()=>n++); unread.observe(5); unread.observe(5); unread.observe(2); assert.equal(n,0);
  unread.observe(3); assert.equal(n,1); unread.reset(); unread.observe(20); assert.equal(n,1);
});
test('silent polling cannot flash loading, fake success, or error on every tick', () => {
  for (const path of ['/api/auth/me','/api/notifications/unread-count','/api/chats/id/typing']) assert.equal(requestFeedbackPolicy('GET',path).silent,true);
  assert.equal(requestFeedbackPolicy('GET','/api/chats/id/messages','silent').silent,true);
  assert.equal(requestFeedbackPolicy('POST','/api/orders').success,true);
  assert.equal(requestFeedbackPolicy('POST','/api/checkout/quote').success,false);
  assert.equal(requestFeedbackPolicy('GET','/api/products').success,false);
});
test('real event adapters remain wired and local input never directly triggers typing', () => {
  const source=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
  assert.match(source('src/lib/api.ts'),/beginRequestFeedback/);
  assert.match(source('src/pages/Chat.tsx'),/useChatPresence/);
  assert.match(source('src/components/adminOrders/OrderChatPanel.tsx'),/presence\.onEdit/);
  assert.match(source('src/components/notifications/NotificationBell.tsx'),/mascotUnread\.current\.observe/);
  const hook=source('src/lib/useChatPresence.ts');
  assert.match(hook,/result\.typing === true/);
  assert.doesNotMatch(hook.slice(hook.indexOf('editRef.current = (hasText)'),hook.indexOf('stopRef.current = stop')),/mascot\./);
});
