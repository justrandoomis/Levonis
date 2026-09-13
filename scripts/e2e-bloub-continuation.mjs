#!/usr/bin/env node
/** Local real-browser regression test. This fixture calls no production API. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BLOUB_TEST_URL || 'http://127.0.0.1:4175/tests/browser/bloub.html';
const out = process.env.OUT_DIR || '/tmp/levonis-diagnostics/browser';
await mkdir(out,{recursive:true});
let cases=0;

async function aligned(page, kind) {
  await page.waitForFunction((kind) => {
    const app=document.querySelector('.lv-app-intro');
    const anchor=document.querySelector(`[data-bloub-anchor="${kind}"]`);
    const character=document.querySelector('.lv-app-intro__character');
    if (!anchor || !character || app?.getAttribute('data-phase')!=='docked') return false;
    const a=anchor.getBoundingClientRect(), b=character.getBoundingClientRect();
    return Math.abs(a.left+a.width/2-b.left-b.width/2)<1.5 && Math.abs(a.top+a.height/2-b.top-b.height/2)<1.5;
  },kind,{timeout:10000});
  assert.equal(await page.locator('svg.lv-bloub').count(),1);
  assert.equal(await page.evaluate(()=>document.querySelector('svg.lv-bloub')===window.__originalBloub),true,'SVG identity must survive navigation');
}

for (const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
  const browser=await engine.launch();
  try {
    for (const width of [320,375,390,430,768,1440]) for (const lang of ['ar','en']) {
      const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1});
      await context.addInitScript((lang)=>localStorage.setItem('levo_lang',lang),lang);
      const page=await context.newPage();
      const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      try {
        await page.goto(base);
        await page.locator('svg.lv-bloub').waitFor();
        await page.evaluate(()=>{window.__originalBloub=document.querySelector('svg.lv-bloub');});
        const initial=await page.locator('.lv-app-intro__character').boundingBox();
        assert.ok(initial && initial.width>=112 && initial.width<=184);
        assert.equal(await page.locator('.lv-app-intro').getAttribute('data-phase'),'loading');
        assert.ok(Math.abs(initial.x+initial.width/2-width/2)<2);
        await page.locator('#ready').click(); await aligned(page,'bottom-home');
        await page.locator('#product').click(); await aligned(page,'top-header');
        await page.locator('#checkout').click(); await aligned(page,'top-header');
        await page.locator('#busy').click();
        await page.waitForFunction(()=>document.querySelector('.lv-bloub--thinking'));
        await page.locator('#busy').click();
        await page.locator('#header').click(); await aligned(page,'top-fallback');
        await page.locator('#header').click(); await aligned(page,'top-header');
        await page.setViewportSize({width:width+13,height:780}); await aligned(page,'top-header');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
        const input=page.getByLabel('Focus probe'); await input.focus();
        await page.evaluate(()=>window.dispatchEvent(new CustomEvent('levonis:bloub-state',{detail:{state:'notify',durationMs:220}})));
        assert.equal(await input.evaluate(el=>el===document.activeElement),true,'animation must not steal focus');
        await page.evaluate(()=>document.documentElement.dataset.overlayOpen='true');
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('.lv-app-intro__character')).opacity==='0');
        await page.evaluate(()=>delete document.documentElement.dataset.overlayOpen);
        await page.locator('.lv-character-home').click(); await aligned(page,'bottom-home');
        assert.deepEqual(errors,[]);
        if(width===375) await page.screenshot({path:`${out}/${name}-${lang}-375.png`});
        console.log(`ok ${name} ${lang} ${width}: bootstrap, same SVG, routes, resize, fallback, focus, overlay, Home`);
        cases++;
      } finally { await context.close(); }
    }
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    const page=await context.newPage();
    await page.goto(base); await page.locator('svg.lv-bloub').waitFor();
    await page.evaluate(()=>{window.__originalBloub=document.querySelector('svg.lv-bloub');});
    await page.locator('#ready').click(); await aligned(page,'bottom-home');
    assert.equal(await page.locator('.lv-app-intro').getAttribute('data-reduced-motion'),'true');
    await page.locator('#product').click(); await aligned(page,'top-header');
    const animations=await page.locator('svg.lv-bloub').evaluate(el=>getComputedStyle(el).animationName);
    assert.equal(animations,'none');
    await context.close(); cases++;
    console.log(`ok ${name}: reduced motion`);
  } finally { await browser.close(); }
}
console.log(`Browser regression: ${cases} cases passed; no production writes.`);
