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
 * runner may defer a WebKit paint; the gaze must still measurably change. */
async function animatedEyes(page) {
  const before=await page.locator('[data-bloub-gaze]').evaluate(e=>getComputedStyle(e).transform);
  await page.waitForFunction(before=>{
    const eyes=document.querySelector('[data-bloub-gaze]');
    return eyes && getComputedStyle(eyes).transform!==before;
  },before,{polling:'raf',timeout:1500});
  assert.notEqual(await page.locator('[data-bloub-gaze]').evaluate(e=>getComputedStyle(e).transform),before,'eyes really moved');
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
const click=async(page,id)=>page.locator(id).click();
for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]) {
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
        assert.ok(intro.width>=144 && intro.width<=240);
        assert.ok(Math.abs(intro.x+intro.width/2-width/2)<1.5);
        await animatedEyes(page);
        if(width===390&&lang==='ar') await page.screenshot({path:`${out}/${engineName}-${lang}-intro.png`});
        await click(page,'#ready'); await aligned(page,'bottom-home'); await state(page,'idle');
        const home=await dimensions(page,'bottom-home');
        assert.ok(intro.width>=home.svg.w*1.9,'intro substantially larger than docked');
        await page.screenshot({path:`${out}/${engineName}-${lang}-${width}-home.png`});
        await click(page,'#product');
        await page.waitForFunction(()=>document.querySelector('[data-bloub-direction]')?.getAttribute('style')?.includes('translate'));
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
    for(const element of ['svg.lv-bloub','.lv-bloub-gaze','.lv-bloub-blink','.lv-bloub-breath']) assert.equal(await page.locator(element).evaluate(e=>getComputedStyle(e).animationName),'none');
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
    for(const element of ['.lv-bloub-gaze','.lv-bloub-blink','.lv-bloub-breath']) assert.equal(await page.locator(element).evaluate(e=>getComputedStyle(e).animationName),'none');
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
