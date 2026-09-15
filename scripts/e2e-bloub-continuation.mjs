#!/usr/bin/env node
/** Real production components in an isolated local fixture. No live writes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.BLOUB_TEST_URL||'http://127.0.0.1:4175/tests/browser/bloub.html';
const out=process.env.OUT_DIR||'/tmp/levonis-diagnostics/browser';
await mkdir(out,{recursive:true});
const measurements=[]; let cases=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function state(page, name, timeout=6000) {
  await page.waitForFunction(name=>document.querySelector('.lv-app-intro')?.getAttribute('data-mascot-state')===name,name,{timeout});
}
/** Poll painted animation frames, not Node wall-clock sleeps. A loaded CI
 * runner may defer a WebKit paint; the gaze must still measurably change.
 *
 * Reads the eye's own matrix rather than a wrapper's computed transform. The
 * character no longer has a gaze wrapper to animate: each eye carries the
 * whole head pose — where it sits on the sphere, how it is inclined, how far
 * the lid has come down — in one matrix written per frame. That matrix IS the
 * gaze, so this is a stricter check than the group transform it replaces. */
async function animatedEyes(page) {
  const read=()=>page.locator('[data-bloub-eye="0"]').evaluate(e=>e.getAttribute('transform'));
  const before=await read();
  await page.waitForFunction(before=>
    document.querySelector('[data-bloub-eye="0"]')?.getAttribute('transform')!==before,
    before,{polling:'raf',timeout:2500});
  assert.notEqual(await read(),before,'eyes really moved');
}

/** THE GAZE LEADS THE BODY.
 *
 * The brief's headline requirement, and the one thing a screenshot can never
 * show: before the character goes anywhere, it looks where it is going. This
 * samples the eye's position on the face and the character's position on
 * screen every animation frame across a whole journey, then asserts three
 * things about the ORDER they happen in.
 *
 * Deliberately not a threshold on degrees: idle drift and saccades move the
 * eyes a few units on their own, so any fixed angle is either inside that
 * noise or outside the lead. And deliberately not the argmin of the eye
 * position either — the gaze TURNS and then HOLDS on the destination for the
 * whole journey, so its extreme frame is wherever the last hundredth of a unit
 * of jitter happened to land, which is meaningless. What is meaningful is when
 * the turn was substantially complete.
 */
async function gazeLeads(page) {
  const trace=await page.evaluate(()=>new Promise(resolve=>{
    const frames=[]; const t0=performance.now();
    const step=()=>{
      const eye=document.querySelector('[data-bloub-eye="0"]');
      const node=document.querySelector('.lv-app-intro__character');
      const m=eye?.getAttribute('transform')?.match(/matrix\(([^)]+)\)/);
      const c=node?.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px[^)]*\)\s*scale\(([\d.]+)\)/);
      if(m&&c){const p=m[1].trim().split(/\s+/).map(Number);
        frames.push({eyeY:p[5],charY:Number(c[2]),scale:Number(c[3])});}
      if(performance.now()-t0<1500) requestAnimationFrame(step); else resolve(frames);
    };
    requestAnimationFrame(step);
  }));
  assert.ok(trace.length>20,`sampled the journey (${trace.length} frames)`);
  const first=trace[0], last=trace[trace.length-1];
  const travelled=last.charY-first.charY;
  assert.ok(Math.abs(travelled)>40,`the character actually travelled (${travelled.toFixed(0)}px)`);
  const up=travelled<0;                       // screen-up journey => gaze pitches up => eyeY falls

  // 1. ANTICIPATION: the body gathers AWAY from the destination before it goes.
  const wrongWay=Math.max(...trace.map(f=>up?f.charY-first.charY:first.charY-f.charY));
  assert.ok(wrongWay>0.4&&wrongWay<10,`wound up away from the destination by ${wrongWay.toFixed(1)}px`);

  // 2. THE GAZE LEADS: it has substantially turned before the body commits.
  const eyes=trace.map(f=>f.eyeY);
  const extreme=up?Math.min(...eyes):Math.max(...eyes);
  const swing=extreme-first.eyeY;
  assert.ok(Math.abs(swing)>2,`the gaze visibly turned (${swing.toFixed(2)} viewBox units)`);
  const mark=first.eyeY+swing*0.9;
  const turned=trace.findIndex(f=>up?f.eyeY<=mark:f.eyeY>=mark);
  const moved=trace.findIndex(f=>Math.abs(f.charY-first.charY)>Math.abs(travelled)*0.1
    &&Math.sign(f.charY-first.charY)===Math.sign(travelled));
  assert.ok(moved>0,'found the frame the body committed to the journey');
  assert.ok(turned>=0&&turned<moved,`gaze turned by frame ${turned}, body committed at ${moved} — eyes must lead`);

  // 3. SIZE IS NOT POSITION: the character stays big as it sets off and does
  //    its shrinking on the approach, rather than resizing linearly as it goes.
  const scaleSpan=last.scale-first.scale;
  if(Math.abs(scaleSpan)>0.01){
    const at=trace[moved];
    const scaleProgress=(at.scale-first.scale)/scaleSpan;
    assert.ok(scaleProgress<0.08,`scale barely moved while the body committed (${(scaleProgress*100).toFixed(1)}%)`);
  }
  return {turned,moved,travelled};
}

/** Hold the page still for `ms` of REAL animation frames, in one round trip. */
const frames=(page,ms)=>page.evaluate(ms=>new Promise(done=>{const t0=performance.now();
  const step=()=>performance.now()-t0<ms?requestAnimationFrame(step):done();requestAnimationFrame(step);}),ms);
/** Horizontal position of the left eye, in viewBox units, read out of the one
 *  matrix the renderer writes per frame. That matrix IS the gaze. */
const eyeX=page=>page.locator('[data-bloub-eye="0"]').evaluate(e=>{
  const m=e.getAttribute('transform')?.match(/matrix\(([^)]+)\)/);
  return m?Number(m[1].trim().split(/\s+/)[4]):NaN;});

/** Mean eye position over a window of real frames. The character is alive
 *  even at rest — it drifts and it makes saccades — so a single sample carries
 *  that noise and an average does not. */
const meanEyeX=(page,ms)=>page.evaluate(ms=>new Promise(done=>{
  const xs=[]; const t0=performance.now();
  const step=()=>{
    const m=document.querySelector('[data-bloub-eye="0"]')?.getAttribute('transform')?.match(/matrix\(([^)]+)\)/);
    if(m) xs.push(Number(m[1].trim().split(/\s+/)[4]));
    if(performance.now()-t0<ms) requestAnimationFrame(step);
    else done(xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length));
  };
  requestAnimationFrame(step);
}),ms);

/**
 * §4 §5 §7 — IT LOOKS AT THE POINTER, IT LAGS, AND THEN IT LETS GO.
 *
 * None of this can be seen in a screenshot, so it is driven with a real pointer
 * across a real viewport and read out of the one matrix the renderer writes per
 * frame. Three claims, all the brief's:
 *
 *  1. THE GAZE FOLLOWS. Left edge and right edge must put the eyes in visibly
 *     different places.
 *  2. IT IS A LAG, NOT A JUMP. One frame after the pointer teleports across the
 *     screen the eyes must still be most of the way back where they were.
 *  3. IT RELEASES (§7). After a couple of seconds of stillness the character
 *     stops staring — which is provable without knowing where "rest" is: park
 *     the pointer left, let go, and park it right, let go, and the two resting
 *     gazes must agree even though the two engaged ones did not.
 */
async function gazeFollowsPointer(page,width) {
  const dock=await page.locator('.lv-app-intro__character').boundingBox();
  const y=Math.max(30,dock.y-90);
  const park=async x=>{await page.mouse.move(x,y,{steps:10});await frames(page,700);};

  await park(8);
  const engagedLeft=await meanEyeX(page,260);

  // Teleport, then read the very next frames: a follower with a 0.13s time
  // constant cannot have arrived, and a character that snaps would have.
  await page.mouse.move(width-8,y,{steps:1});
  await frames(page,24);
  const oneFrame=await eyeX(page);

  await frames(page,700);
  const engagedRight=await meanEyeX(page,260);
  const swing=engagedRight-engagedLeft;
  assert.ok(swing>0.5,`the eyes tracked the pointer across the viewport (${swing.toFixed(2)} viewBox units)`);
  const arrived=(oneFrame-engagedLeft)/swing;
  assert.ok(arrived<0.45,`the gaze lags rather than snapping (${(arrived*100).toFixed(0)}% of the way after one frame)`);

  // §7: hold two to three seconds, then fade. Five seconds is past any roll.
  await frames(page,5200);
  const restedRight=await meanEyeX(page,420);
  await park(8);
  await frames(page,5200);
  const restedLeft=await meanEyeX(page,420);
  const forgot=Math.abs(restedRight-restedLeft);
  assert.ok(forgot<Math.abs(swing)*0.4,
    `the character let go of the pointer (${forgot.toFixed(2)} apart at rest vs ${Math.abs(swing).toFixed(2)} engaged)`);
  return {swing,forgot};
}

/**
 * §9 — IMPORTANCE IS DECLARED, AND EVERYTHING ELSE IS INVISIBLE.
 *
 * The fixture carries one control of each class. A character that notices the
 * primary action and the stepper, and does NOT notice the opt-out or the plain
 * button beside them, is the difference between perceptive and twitchy.
 */
async function noticesDeclaredControls(page) {
  const mascotState=()=>page.locator('.lv-app-intro').getAttribute('data-mascot-state');
  const hover=async id=>{await page.locator(id).hover();await frames(page,220);return mascotState();};
  const away=async()=>{await page.mouse.move(4,4);await frames(page,900);};

  assert.equal(await hover('#cta-primary'),'curious','the design system’s own primary token is noticed');
  await away();
  assert.equal(await hover('#qty-inc'),'curious','an explicit data-mascot opt-in is noticed');
  await away();
  assert.equal(await hover('#decoy-ignored'),'idle','data-mascot="ignore" silences a control that would otherwise match');
  assert.equal(await hover('#decoy-plain'),'idle','a plain button is invisible to the character, which is the feature');
  await away();

  // A KEYBOARD USER HAS ARRIVED AT THE CONTROL TOO (§10).
  await page.locator('#cta-primary').focus();
  await frames(page,220);
  assert.equal(await mascotState(),'curious','focus is arrival, not just hover');
  await page.locator('#decoy-plain').focus();
  await frames(page,900);
  assert.equal(await mascotState(),'idle');
}

/**
 * §6 §23 — THE TRACKING NEVER TAKES THE PAGE AWAY FROM THE USER.
 *
 * Every listener is passive and on the capture phase; a unit test pins that at
 * the registration, and this pins the consequence: the page still scrolls, and
 * a wheel gesture over the character is the page's, not the character's.
 */
async function neverCapturesTheGesture(page) {
  await page.mouse.move(200,400);
  await page.mouse.wheel(0,600);
  await page.waitForFunction(()=>window.scrollY>200,null,{timeout:2000});
  const dock=await page.locator('.lv-app-intro__character').boundingBox();
  await page.mouse.move(dock.x+dock.width/2,dock.y+dock.height/2);
  const before=await page.evaluate(()=>window.scrollY);
  await page.mouse.wheel(0,-400);
  await page.waitForFunction(before=>window.scrollY<before-100,before,{timeout:2000});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForFunction(()=>window.scrollY===0);
  await frames(page,200);
}

/** Distance between the character's centre and its anchor's centre, in CSS px.
 *  One measurement, taken now — no waiting, because the question these checks
 *  ask is whether the character is ALREADY where it belongs. */
const offsetFromAnchor=(page,kind)=>page.evaluate(kind=>{
  const a=document.querySelector(`[data-bloub-anchor="${kind}"]`)?.getBoundingClientRect();
  const b=document.querySelector('.lv-app-intro__character')?.getBoundingClientRect();
  if(!a||!b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x+a.width/2-b.x-b.width/2, a.y+a.height/2-b.y-b.height/2);
},kind);

/** Both eye centres in viewBox units, averaged over a window of real frames so
 *  idle drift and saccades do not read as gaze. */
const meanEyes=(page,ms)=>page.evaluate(ms=>new Promise(done=>{
  const acc=[[0,0],[0,0]]; let n=0; const t0=performance.now();
  const step=()=>{
    const got=[0,1].map(i=>{
      const m=document.querySelector(`[data-bloub-eye="${i}"]`)?.getAttribute('transform')?.match(/matrix\(([^)]+)\)/);
      return m?m[1].trim().split(/\s+/).map(Number):null;
    });
    if(got[0]&&got[1]){
      for(let i=0;i<2;i++){acc[i][0]+=got[i][4];acc[i][1]+=got[i][5];}
      n++;
    }
    if(performance.now()-t0<ms) requestAnimationFrame(step);
    else done(n?acc.map(([x,y])=>({x:x/n,y:y/n})):null);
  };
  requestAnimationFrame(step);
}),ms);

/** The body's own width in viewBox units, so the gaze budget below is a real
 *  fraction of the face rather than a fraction of the canvas around it. */
const bodyWidth=page=>page.locator('[data-bloub-body]').evaluate(e=>e.getBBox().width);

/**
 * THE OWNER'S MANUAL GAZE TEST, RUN BY MACHINE.
 *
 * "Pointer at far-left → eyes clearly look left" and the eight cases after it,
 * with the acceptance the owner wrote out: if the difference between these
 * states is barely visible, the range is still too small.
 *
 * Measured off the eye's own matrix, which is where the whole head pose lands,
 * and reported as a PERCENTAGE OF THE BODY WIDTH — the number the owner's
 * 15-22% horizontal and 12-18% vertical bands are expressed in.
 */
async function gazeReach(page,width,height) {
  // START FROM A KNOWN STATE. The checks before this one hover controls and
  // scroll the page, and `locator.hover()` scrolls its target into view — so
  // without this the first reading is taken while the page is still settling
  // and every ratio below is measured against a moving reference.
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForFunction(()=>window.scrollY===0);
  await frames(page,300);
  const dock=await page.locator('.lv-app-intro__character').boundingBox();
  const cx=dock.x+dock.width/2, cy=dock.y+dock.height/2;
  const body=await bodyWidth(page);
  const edge=6;
  const cases={
    left:       {x:edge,        y:cy-40},
    right:      {x:width-edge,  y:cy-40},
    up:         {x:cx,          y:edge},
    down:       {x:cx,          y:height-edge},
    upLeft:     {x:edge,        y:edge},
    upRight:    {x:width-edge,  y:edge},
    downLeft:   {x:edge,        y:height-edge},
    downRight:  {x:width-edge,  y:height-edge},
  };
  const seen={};
  // THE NEUTRAL REFERENCE IS REST, NOT THE MIDDLE OF THE SCREEN. A pointer
  // parked near the character is not a neutral gaze — it is the character
  // looking at the pointer from very close, which for a bottom-docked mascot
  // means looking straight up. The only honest zero is the gaze it holds once
  // it has let go (§7), so that is what everything below is measured against.
  await page.mouse.move(cx,Math.max(edge,cy-4),{steps:6});
  await frames(page,5400);
  seen.centre=await meanEyes(page,420);
  assert.ok(seen.centre,'sampled the resting gaze');
  for(const [name,pt] of Object.entries(cases)) {
    await page.mouse.move(pt.x,pt.y,{steps:8});
    await frames(page,1200);
    seen[name]=await meanEyes(page,220);
    assert.ok(seen[name],`sampled the eyes while looking ${name}`);
  }
  // Average the pair: the two eyes move by different amounts under the sphere
  // projection — that is the point of it — so the PAIR's centre is what says
  // where the character is looking.
  const mid=n=>({x:(seen[n][0].x+seen[n][1].x)/2, y:(seen[n][0].y+seen[n][1].y)/2});
  const p=Object.fromEntries(['centre',...Object.keys(cases)].map(n=>[n,mid(n)]));

  const hTravel=p.right.x-p.left.x;
  const vTravel=p.down.y-p.up.y;
  const hPct=hTravel/body*100, vPct=vTravel/body*100;

  // A failed gaze assertion is unreadable without the table it was computed
  // from, and the table is worth printing even when it passes: it is the
  // owner's manual test, in numbers.
  console.log(`   gaze table (viewBox units, relative to rest):\n` +
    Object.keys(p).filter(n=>n!=='centre')
      .map(n=>`     ${n.padEnd(10)} x ${(p[n].x-p.centre.x).toFixed(2).padStart(6)}   y ${(p[n].y-p.centre.y).toFixed(2).padStart(6)}`)
      .join('\n'));

  // EVERYTHING BELOW IS MEASURED AGAINST THE REACHED EXTREMES, NEVER AGAINST
  // REST. The resting gaze is not a fixed point: idle life holds a saccade for
  // one to six seconds at a time, worth several viewBox units of yaw, so a
  // sample of it taken in a browser is wherever that calendar happened to be.
  // (The unit test CAN use rest as a reference — it samples one fixed instant
  // of the clock, so the same offset appears on both sides and cancels. A live
  // page cannot.) Positions are expressed along the axis the character
  // actually spans: 0 is as far left as it looks, 1 as far right.
  const alongH=n=>(p[n].x-p.left.x)/(p.right.x-p.left.x);
  const alongV=n=>(p[n].y-p.up.y)/(p.down.y-p.up.y);

  // 1. DIRECTION IS UNAMBIGUOUS, and the two axes are genuinely independent:
  //    the vertical probes are horizontally centred and must stay near the
  //    middle of the horizontal range, and vice versa.
  assert.ok(p.left.x<p.right.x, `far-left looks left of far-right (${p.left.x.toFixed(2)} vs ${p.right.x.toFixed(2)})`);
  assert.ok(p.up.y<p.down.y, `the top of the screen looks above the bottom (${p.up.y.toFixed(2)} vs ${p.down.y.toFixed(2)})`);
  for(const n of ['up','down']) assert.ok(Math.abs(alongH(n)-0.5)<0.25,`${n} is horizontally centred (${alongH(n).toFixed(2)} along the left-right axis)`);
  for(const n of ['left','right']) assert.ok(Math.abs(alongV(n)-0.5)<0.3,`${n} is vertically centred (${alongV(n).toFixed(2)} along the up-down axis)`);

  // 2. THE RANGE IS THE OWNER'S. 15-22% of the face across, 12-18% down, with a
  //    little headroom above for visual tuning. Under the floor is the defect
  //    the owner reported; far over it stops looking like a face.
  assert.ok(hPct>=15 && hPct<=26, `horizontal gaze travel is ${hPct.toFixed(1)}% of the ${body.toFixed(1)}-unit face (owner asks 15-22%)`);
  assert.ok(vPct>=12 && vPct<=22, `vertical gaze travel is ${vPct.toFixed(1)}% of the face (owner asks 12-18%)`);

  // 3. THE DIAGONALS ARE REAL DIAGONALS, not 0.707 shadows of the cardinals.
  //    Each corner of the screen has to put the gaze in the matching corner of
  //    the range the character spans. A unit-direction model cannot: it divides
  //    one budget across two axes, so its corners land at 71% of each and
  //    nowhere near the ends. 0.7 of the span is the floor here rather than
  //    1.0 because the sphere is real — an eye aimed up and sideways at once
  //    loses a little of its horizontal throw to cos(pitch), which is the
  //    foreshortening that makes it read as a head rather than a sticker.
  for(const [name,h,v] of [['upLeft',0,0],['upRight',1,0],['downLeft',0,1],['downRight',1,1]]) {
    const gotH=alongH(name), gotV=alongV(name);
    assert.ok(h?gotH>0.7:gotH<0.3,`${name} sits at ${gotH.toFixed(2)} along the left-right axis, wanted ${h?'>0.7':'<0.3'}`);
    assert.ok(v?gotV>0.7:gotV<0.3,`${name} sits at ${gotV.toFixed(2)} along the up-down axis, wanted ${v?'>0.7':'<0.3'}`);
  }

  // 4. EVERY ONE OF THE NINE IS TELLABLE FROM EVERY OTHER. The character is
  //    usually drawn at about 80 CSS px, so one viewBox unit is 0.8px — the
  //    floor below is a shade over a pixel of real separation on screen.
  const names=['centre',...Object.keys(cases)];
  let closest={gap:Infinity,pair:''};
  for(let i=0;i<names.length;i++) for(let j=i+1;j<names.length;j++) {
    const gap=Math.hypot(p[names[i]].x-p[names[j]].x,p[names[i]].y-p[names[j]].y);
    if(gap<closest.gap) closest={gap,pair:`${names[i]}/${names[j]}`};
  }
  assert.ok(closest.gap>1.4,
    `the two closest gaze states (${closest.pair}) are ${closest.gap.toFixed(2)} viewBox units apart — ${(closest.gap*0.8).toFixed(2)}px at the docked size`);

  // 5. FARTHER MEANS FARTHER. The owner asks for the pointer approaching the
  //    outer viewport to reach MUCH further, which is the opposite of a model
  //    that loses interest with distance.
  await page.mouse.move(cx-(cx-edge)*0.5,cy-40,{steps:8});
  await frames(page,1200);
  const half=await meanEyes(page,220);
  const halfway=(half[0].x+half[1].x)/2;
  assert.ok(p.left.x<halfway-0.6,
    `the screen edge pulls the gaze further than halfway to it (edge ${p.left.x.toFixed(2)} vs half ${halfway.toFixed(2)})`);

  return {hPct,vPct,closest:closest.gap,body};
}

/**
 * §3 — THE CHARACTER STAYS ON ITS ANCHOR THROUGH EVERY VIEWPORT CHANGE.
 *
 * Two different failures hide behind "it drifts", and they need two different
 * checks. A DISCRETE change — a rotation, a breakpoint, the URL bar collapsing
 * — is one jump, and the character must land back on the anchor. A CONTINUOUS
 * change — a dragged window edge — is a hundred of them in a second, and it is
 * the one that exposes accumulation: an implementation that adds each delta to
 * the last is correct after one step and visibly behind after a hundred.
 *
 * So the second check runs the SAME total change at two granularities. Lag
 * scales with the distance; accumulation scales with the number of steps.
 */
async function staysAnchored(page,kind,sizes) {
  let worst=0;
  for(const [w,h] of sizes) {
    await page.setViewportSize({width:w,height:h});
    await aligned(page,kind);
    worst=Math.max(worst,await offsetFromAnchor(page,kind));
  }
  return worst;
}

async function noCrawlDuringDrag(page,kind,from,to) {
  const walk=async steps=>{
    await page.setViewportSize({width:from.w,height:from.h});
    await aligned(page,kind);
    for(let i=1;i<=steps;i++) {
      const k=i/steps;
      await page.setViewportSize({
        width:Math.round(from.w+(to.w-from.w)*k),
        height:Math.round(from.h+(to.h-from.h)*k),
      });
    }
    await frames(page,900);
    return offsetFromAnchor(page,kind);
  };
  const coarse=await walk(4);
  const fine=await walk(40);
  assert.ok(fine<2.5,`after 40 resize steps the character is ${fine.toFixed(2)}px off its anchor`);
  assert.ok(coarse<2.5,`after 4 resize steps the character is ${coarse.toFixed(2)}px off its anchor`);
  // Ten times the events for the same distance must not mean a bigger error.
  assert.ok(fine<=coarse+1.2,
    `the error grows with the NUMBER of resize events (4 steps ${coarse.toFixed(2)}px, 40 steps ${fine.toFixed(2)}px) — that is accumulation, not lag`);
  return {coarse,fine};
}

/** §2 — nothing on the face glows. Asserted against the live DOM and the
 *  resolved styles, not against the source, because a halo can arrive from a
 *  stylesheet the markup never mentions. */
async function noFaceGlow(page) {
  const found=await page.evaluate(()=>{
    const svg=document.querySelector('svg.lv-bloub');
    if(!svg) return ['no svg'];
    const bad=[];
    if(svg.querySelector('[data-bloub-eyeglow], filter, feGaussianBlur, feDropShadow')) bad.push('a glow node survives in the markup');
    if(/eyeglow/i.test(svg.innerHTML)) bad.push('an eyeglow gradient is still declared');
    for(const node of [svg,...svg.querySelectorAll('*')]) {
      const s=getComputedStyle(node);
      const label=node.getAttribute('data-bloub-eye')!==null?'eye'
        :node.hasAttribute('data-bloub-mouth')?'mouth'
        :node.tagName.toLowerCase();
      if(s.filter&&s.filter!=='none') bad.push(`${label} carries filter: ${s.filter}`);
      if(s.boxShadow&&s.boxShadow!=='none') bad.push(`${label} carries box-shadow: ${s.boxShadow}`);
      if(s.textShadow&&s.textShadow!=='none') bad.push(`${label} carries text-shadow: ${s.textShadow}`);
    }
    // The body's own integrated highlight must SURVIVE — the owner kept it.
    if(!svg.querySelector('[data-bloub-gloss]')) bad.push('the body highlight was removed too');
    if(svg.querySelectorAll('[data-bloub-eye]').length!==2) bad.push('there are no longer exactly two eyes');
    return bad;
  });
  assert.deepEqual(found,[],`the face must not glow: ${found.join('; ')}`);
}

async function aligned(page,kind) {
  await page.waitForFunction(kind=>{
    const a=document.querySelector(`[data-bloub-anchor="${kind}"]`)?.getBoundingClientRect();
    const b=document.querySelector('.lv-app-intro__character')?.getBoundingClientRect();
    return a&&b&&document.querySelector('.lv-app-intro')?.getAttribute('data-phase')==='docked'
      &&Math.abs(a.x+a.width/2-b.x-b.width/2)<1.5&&Math.abs(a.y+a.height/2-b.y-b.height/2)<1.5;
  },kind,{timeout:10000});
  assert.equal(await page.locator('svg.lv-bloub').count(),1);
  assert.ok(await page.evaluate(()=>document.querySelector('svg.lv-bloub')===window.__originalBloub),'same SVG, not a remount');
}
async function dimensions(page,kind) {
  const m=await page.evaluate(kind=>{
    const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
    const svg=box(document.querySelector('svg.lv-bloub')), body=box(document.querySelector('[data-bloub-body]'));
    const anchor=document.querySelector(`[data-bloub-anchor="${kind}"]`), hit=box(anchor.parentElement);
    const capsules=[...document.querySelectorAll('[data-bottom-nav-group]')].map(box);
    return {svg,body,hit,capsules,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};
  },kind);
  assert.equal(m.overflow,false,'no horizontal overflow');
  assert.ok(m.body.w/m.svg.w>.78,'actual path must fill its canvas, not transparent padding');
  assert.ok(m.body.w/m.hit.w>.70,'actual character occupies most of the independent hit area');
  assert.ok(m.body.x>=m.svg.x-0.8 && m.body.y>=m.svg.y-0.8 && m.body.x+m.body.w<=m.svg.x+m.svg.w+0.8 && m.body.y+m.body.h<=m.svg.y+m.svg.h+0.8,'body stays within SVG including active morph');
  assert.ok(m.hit.w>m.body.w && m.hit.h>m.body.h,'touch target independent/larger');
  assert.ok(m.body.w >= (kind==='bottom-home'?48:44),'visibly substantial path');
  if(kind==='bottom-home') for(const capsule of m.capsules) {
    const gap= Math.max(capsule.x-(m.body.x+m.body.w), m.body.x-(capsule.x+capsule.w));
    assert.ok(gap>=5,`breathing room to navigation capsule (${gap}px)`);
  }
  return m;
}
/**
 * Activate a control WITHOUT moving the cursor.
 *
 * `locator.click()` drives the real mouse, which parks the pointer on whatever
 * was just pressed — and the character now looks at the pointer. That makes
 * every gaze measurement taken after a click a measurement of two things at
 * once: a journey that had already turned the eyes towards the link the user
 * clicked reads as a smaller lead than the same journey from rest.
 *
 * So the ordinary flow activates controls the way the keyboard does, and the
 * pointer is driven explicitly, only by the checks that are about the pointer.
 */
const click=async(page,id)=>page.locator(id).evaluate(e=>e.click());
/** Under a reduced-motion preference the BODY must hold perfectly still: no
 * breathing, no drift, no resting wobble. Blinking is intentionally still
 * running — it is not vestibular, and a face that never blinks reads as broken
 * rather than as calm — so this samples the outline and not the eyes. */
async function stillBody(page) {
  const got=await page.evaluate(()=>new Promise(resolve=>{
    const seen=new Set(); const states=new Set(); const t0=performance.now();
    const step=()=>{
      seen.add(document.querySelector('[data-bloub-body]')?.getAttribute('d'));
      states.add(`${document.querySelector('.lv-app-intro')?.dataset.mascotState}/${document.querySelector('.lv-app-intro')?.dataset.phase}/reduced=${document.querySelector('svg.lv-bloub')?.dataset.reduced}`);
      if(performance.now()-t0<600) requestAnimationFrame(step); else resolve({paths:[...seen],states:[...states]});
    };
    requestAnimationFrame(step);
  }));
  if(got.paths.length!==1) {
    // Say WHAT moved. "21 distinct paths" is unactionable; the largest
    // coordinate delta and the states it happened in are not.
    const a=got.paths[0].split(/[ ,]/).map(Number);
    const z=got.paths[got.paths.length-1].split(/[ ,]/).map(Number);
    const delta=Math.max(...a.map((v,i)=>Number.isFinite(v)&&Number.isFinite(z[i])?Math.abs(v-z[i]):0));
    assert.fail(`body outline is static under reduced motion — saw ${got.paths.length} distinct paths, largest coordinate moved ${delta.toFixed(3)} viewBox units, during ${got.states.join(' | ')}`);
  }
}
// Both engines in CI. `BLOUB_ENGINES=chromium` lets a developer run one
// locally without editing the file — it never narrows what CI runs.
const engines=[['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.BLOUB_ENGINES||process.env.BLOUB_ENGINES.split(',').includes(name));
for(const [engineName,engine] of engines) {
  const browser=await engine.launch();
  try {
    for(const width of [320,360,390,430,768,1024,1440]) for(const lang of ['ar','en']) {
      const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1});
      await context.addInitScript(lang=>localStorage.setItem('levo_lang',lang),lang);
      const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      try {
        await page.goto(base); await page.locator('svg.lv-bloub').waitFor();
        await page.evaluate(()=>{window.__originalBloub=document.querySelector('svg.lv-bloub');window.__states=[];
          new MutationObserver(()=>{const e=document.querySelector('.lv-app-intro');window.__states.push(e?.getAttribute('data-mascot-state'));}).observe(document.querySelector('.lv-app-intro'),{attributes:true,attributeFilter:['data-mascot-state']});});
        await state(page,'loading');
        const intro=await page.locator('.lv-app-intro__character').boundingBox();
        assert.ok(intro.width>=180 && intro.width<=320,`first frame ${intro.width}`);
        assert.ok(Math.abs(intro.x+intro.width/2-width/2)<1.5);
        await animatedEyes(page);
        if(width===390&&lang==='ar') await page.screenshot({path:`${out}/${engineName}-${lang}-intro.png`});
        await click(page,'#ready'); await aligned(page,'bottom-home'); await state(page,'idle');
        await noFaceGlow(page);
        const home=await dimensions(page,'bottom-home');
        assert.ok(intro.width>=home.svg.w*1.9,'intro substantially larger than docked');
        await page.screenshot({path:`${out}/${engineName}-${lang}-${width}-home.png`});
        await click(page,'#product');
        await page.waitForFunction(()=>document.querySelector('.lv-app-intro')?.dataset.phase==='travelling',null,{polling:'raf',timeout:4000});
        await gazeLeads(page);
        await aligned(page,'top-header'); await state(page,'idle');
        const header=await dimensions(page,'top-header');
        await page.screenshot({path:`${out}/${engineName}-${lang}-${width}-header.png`});
        await click(page,'#checkout'); await aligned(page,'top-header');
        await click(page,'#busy'); await state(page,'loading');
        await click(page,'#busy'); await state(page,'idle');
        await click(page,'#header'); await aligned(page,'top-fallback');
        await click(page,'#header'); await aligned(page,'top-header');
        await page.setViewportSize({width,height:480}); await aligned(page,'top-header');
        await page.setViewportSize({width,height:844}); await aligned(page,'top-header');
        await page.getByLabel('Focus probe').focus();
        await page.evaluate(()=>window.dispatchEvent(new CustomEvent('levonis:bloub-state',{detail:{state:'notify',durationMs:220}})));
        assert.ok(await page.getByLabel('Focus probe').evaluate(e=>e===document.activeElement));
        await page.evaluate(()=>document.documentElement.dataset.overlayOpen='true');
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('.lv-app-intro__character')).opacity==='0');
        await page.evaluate(()=>delete document.documentElement.dataset.overlayOpen);
        await page.locator('.lv-character-home').click(); await aligned(page,'bottom-home'); await state(page,'idle');
        const history=await page.evaluate(()=>window.__states);
        assert.ok(history.includes('navigating')&&history.includes('returning')&&history.includes('arrival')&&history.includes('tap'),'travel, settle and immediate Home reaction');
        assert.deepEqual(errors,[]);
        measurements.push({engine:engineName,lang,width,intro:intro.width,homePath:home.body.w,homeCanvas:home.svg.w,homeHit:home.hit.w,headerPath:header.body.w});
        console.log(`ok ${engineName} ${lang} ${width}: path ${home.body.w.toFixed(1)}px / hit ${home.hit.w.toFixed(1)}px; header ${header.body.w.toFixed(1)}px; animated eyes, geometry, same SVG, routes, keyboard, overlays`);
        cases++;
        if(width===390) {
          await click(page,'#api-load'); await state(page,'loading');
          await click(page,'#api-resolve'); await state(page,'idle');
          await click(page,'#api-success'); await state(page,'success'); await delay(250); await dimensions(page,'bottom-home'); await state(page,'idle');
          await click(page,'#api-warning'); await state(page,'warning'); await delay(250); await dimensions(page,'bottom-home'); await state(page,'idle');
          await click(page,'#api-error'); await state(page,'error'); await click(page,'#api-success'); await state(page,'error');
          await page.screenshot({path:`${out}/${engineName}-${lang}-error.png`}); await state(page,'idle');
          await click(page,'#notification'); await state(page,'notify'); await state(page,'idle');
          await click(page,'#chat'); await aligned(page,'top-header'); await state(page,'idle');
          await page.locator('#own-message').fill('My own typing does not animate the remote state');
          await delay(300); assert.notEqual(await page.locator('.lv-app-intro').getAttribute('data-mascot-state'),'typing');
          await click(page,'#remote-start'); await state(page,'typing');
          await animatedEyes(page);
          await page.screenshot({path:`${out}/${engineName}-${lang}-typing.png`});
          await click(page,'#remote-stop'); await state(page,'idle');
          await page.locator('#force-rest').evaluate(e=>e.click()); await state(page,'sleep');
          await page.locator('#force-wake').evaluate(e=>e.click()); await state(page,'idle');
          assert.deepEqual(errors,[]); cases++;
          // THE SENSES. Back to the dock first: the gaze measurements are taken
          // relative to where the character actually is.
          await page.locator('.lv-character-home').click(); await aligned(page,'bottom-home'); await state(page,'idle');
          await neverCapturesTheGesture(page);
          const gaze=await gazeFollowsPointer(page,width);
          await noticesDeclaredControls(page);
          assert.deepEqual(errors,[]);
          console.log(`ok ${engineName} ${lang} ${width}: gaze swung ${gaze.swing.toFixed(2)} units across the viewport, let go to within ${gaze.forgot.toFixed(2)}, noticed only declared controls, never took the scroll`);
          cases++;

          // THE OWNER'S FOUR ACCEPTANCE CRITERIA, in real motion. These change
          // the viewport, so they run last and put it back.
          const reach=await gazeReach(page,width,844);
          const anchored=await staysAnchored(page,'bottom-home',
            [[320,568],[390,844],[430,932],[768,1024],[1024,768],[1440,900],[1180,820],[390,844]]);
          const drag=await noCrawlDuringDrag(page,'bottom-home',{w:390,h:844},{w:1180,h:820});
          await page.setViewportSize({width,height:844});
          await aligned(page,'bottom-home'); await state(page,'idle');
          await noFaceGlow(page);
          assert.deepEqual(errors,[]);
          console.log(`ok ${engineName} ${lang} ${width}: gaze reaches ${reach.hPct.toFixed(1)}% x ${reach.vPct.toFixed(1)}% of the ${reach.body.toFixed(1)}-unit face, nine states ${reach.closest.toFixed(2)} units apart at worst; anchored within ${anchored.toFixed(2)}px across 8 viewports; drag left it ${drag.fine.toFixed(2)}px off after 40 steps vs ${drag.coarse.toFixed(2)}px after 4`);
          cases++;
        }
      } catch(e) {
        const diagnostic=await page.evaluate(()=>({state:document.querySelector('.lv-app-intro')?.getAttribute('data-mascot-state'),phase:document.querySelector('.lv-app-intro')?.getAttribute('data-phase'),history:window.__states,html:document.querySelector('.lv-app-intro')?.outerHTML}));
        await writeFile(`${out}/${engineName}-${lang}-${width}-failure.json`,JSON.stringify({error:String(e),pageErrors:errors,...diagnostic},null,2));
        console.error('Browser diagnostics:',JSON.stringify({state:diagnostic.state,phase:diagnostic.phase,history:diagnostic.history,pageErrors:errors}));
        await page.screenshot({path:`${out}/${engineName}-${lang}-${width}-failure.png`}); throw e;
      } finally {await context.close();}
    }
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    const page=await context.newPage();await page.goto(base);await page.locator('svg.lv-bloub').waitFor();
    await page.evaluate(()=>window.__originalBloub=document.querySelector('svg.lv-bloub'));
    await click(page,'#ready');await aligned(page,'bottom-home');
    assert.equal(await page.locator('.lv-app-intro').getAttribute('data-reduced-motion'),'true');
    await click(page,'#product');await aligned(page,'top-header');
    assert.equal(await page.locator('svg.lv-bloub').evaluate(e=>getComputedStyle(e).animationName),'none');
    await stillBody(page);
    await click(page,'#api-error');await state(page,'error');
    await state(page,'idle');cases++;
    // A preference changed while this page is OPEN must reach both React
    // layers, not just the CSS query. No reload or replacement SVG allowed.
    const preference=async(value)=>{
      await page.emulateMedia({reducedMotion:value?'reduce':'no-preference'});
      await page.waitForFunction(value=>
        document.querySelector('svg.lv-bloub')?.dataset.reduced===String(value)
        &&document.querySelector('.lv-app-intro')?.dataset.reducedMotion===String(value),value);
      assert.ok(await page.evaluate(()=>window.__originalBloub===document.querySelector('svg.lv-bloub')));
    };
    await preference(false);
    await click(page,'#api-load');await state(page,'loading');await animatedEyes(page);
    await preference(true);await state(page,'loading');
    await stillBody(page);
    await click(page,'#api-resolve');await state(page,'idle');await aligned(page,'top-header');
    await preference(false);
    await page.locator('.lv-character-home').click();
    await page.waitForFunction(()=>document.querySelector('.lv-app-intro')?.dataset.phase==='travelling',null,{polling:'raf'});
    await preference(true);await aligned(page,'bottom-home');await state(page,'idle');
    console.log(`ok ${engineName}: runtime reduced motion toggles in both directions, preserves pending work/SVG, and settles interrupted travel`);
    await context.close();cases++;
  } finally {await browser.close();}
}
await writeFile(`${out}/measurements.json`,JSON.stringify(measurements,null,2));
console.log(`Browser regression: ${cases} cases passed; measured actual SVG paths; no production writes.`);
