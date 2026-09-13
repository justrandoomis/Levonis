import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapCharacterFrame, frameFromRect, characterTransform, beginCharacterRouteLoad, characterLayout, registerCharacterAnchor } from '../src/components/bloub/anchors';
import { isBloubState, bloubDuration, signalBloub } from '../src/components/bloub/events';

test('bootstrap has a real large footprint centred in the visual viewport', () => {
  for (const width of [320, 375, 390, 430, 768, 1440]) {
    const f = bootstrapCharacterFrame({ width, height: 800, offsetLeft: 4, offsetTop: 16 });
    assert.ok(f.size >= 112 && f.size <= 184);
    assert.equal(f.x + f.size / 2, width / 2 + 4);
    assert.equal(f.y + f.size / 2, 416);
  }
});
test('physical geometry centres the same in RTL and LTR and rejects invalid rectangles', () => {
  assert.deepEqual(frameFromRect({left:24,top:700,width:52,height:44}), {x:28,y:700,size:44});
  for (const width of [0, -1, NaN, Infinity]) assert.equal(frameFromRect({left:0,top:0,width,height:44}), null);
  assert.equal(characterTransform({x:28,y:700,size:44}), 'translate3d(28px, 700px, 0) scale(0.34375)');
});
test('concurrent real route loads settle independently and cleanup is idempotent', () => {
  const releaseA = beginCharacterRouteLoad(); const releaseB = beginCharacterRouteLoad();
  assert.equal(characterLayout.pending(), true);
  releaseA(); releaseA(); assert.equal(characterLayout.pending(), true);
  releaseB(); assert.equal(characterLayout.pending(), false);
});
test('stale anchor cleanup cannot unregister a replacement on the same element', () => {
  const element = { removeAttribute() {} } as unknown as HTMLElement;
  const old = registerCharacterAnchor(element, 'top-header');
  const current = registerCharacterAnchor(element, 'top-header');
  old(); assert.equal(characterLayout.hasPageAnchor(), true);
  current(); assert.equal(characterLayout.hasPageAnchor(), false);
});
test('external character signals reject invalid state and bound timers', () => {
  for (const state of ['idle','thinking','navigation','success','notify','tap','error']) assert.ok(isBloubState(state));
  for (const state of [null, undefined, {}, 'broken']) assert.equal(isBloubState(state), false);
  assert.equal(bloubDuration(Infinity),650); assert.equal(bloubDuration(-1),180); assert.equal(bloubDuration(99999),5000);
  assert.doesNotThrow(() => signalBloub('tap'));
});
