const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium,webkit,devices}=require(process.env.PLAYWRIGHT_MODULE);
const origin='https://levonis-iq.com',out='/tmp/mascot-live-proof';
fs.mkdirSync(out,{recursive:true});
const report={origin,time:new Date().toISOString(),api:[],profiles:[],scope:'Anonymous read-only checks; no live users, orders or typing messages created. Device profiles are emulation, not physical hardware.'};
const save=()=>fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));
async function state(page,name){await page.waitForFunction(s=>document.querySelector('.lv-app-intro')?.dataset.mascotState===s,name,{timeout:15000});}
// A controller state swap precedes its 230ms SVG interpolation. In particular,
// the real not-found request raises an error before returning to idle. Measure
// the settled IDLE path, not an intermediate error shape with an idle label.
// All existing minimum-size, padding, hit-target and clearance assertions stay.
const idlePath=[50,7,74,6,91,23,92,47,94,71,78,91,52,93,26,95,7,80,8,53,9,25,24,8,50,7];
async function settle(page){
  await page.evaluate(()=>window.__mascotIdlePaintAt=null);
  await page.waitForFunction(expected=>{
    const shell=document.querySelector('.lv-app-intro'),svg=document.querySelector('svg.lv-bloub');
    const d=document.querySelector('[data-bloub-body]')?.getAttribute('d')??'';
    const values=(d.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)??[]).map(Number);
    const valid=shell?.dataset.phase==='docked'&&shell.dataset.mascotState==='idle'&&svg?.dataset.expression==='idle'
      &&values.length===expected.length&&values.every((n,i)=>Math.abs(n-expected[i])<.01);
    if(!valid){window.__mascotIdlePaintAt=null;return false;}
    window.__mascotIdlePaintAt??=performance.now();
    return performance.now()-window.__mascotIdlePaintAt>=320;
  },idlePath,{timeout:60000,polling:'raf'});
}
async function geometry(page,kind,item){
  const g=await page.evaluate(()=>{
    const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};};
    const a=document.querySelector('[data-bloub-occupied="true"]');
    const svg=document.querySelector('svg.lv-bloub'),body=document.querySelector('[data-bloub-body]');
    return {state:document.querySelector('.lv-app-intro')?.dataset.mascotState,expression:svg?.dataset.expression,path:body?.getAttribute('d'),kind:a?.dataset.bloubAnchor,svg:box(svg),body:box(body),anchor:box(a),hit:box(a.parentElement),viewBox:svg.getAttribute('viewBox'),capsules:[...document.querySelectorAll('[data-bottom-nav-group]')].map(box),overflow:document.documentElement.scrollWidth>innerWidth};
  });
  item.geometry??=[];item.geometry.push(g);save();
  assert.equal(g.state,'idle');assert.equal(g.expression,'idle');
  assert.equal(g.kind,kind);assert.equal(g.viewBox,'3 3 94 94');assert.equal(g.overflow,false);
  assert.equal(await page.locator('svg.lv-bloub').count(),1);
  assert.ok(g.body.w>= (kind==='bottom-home'?48:44));assert.ok(g.body.w/g.svg.w>.78);assert.ok(g.body.w/g.hit.w>.70);
  assert.ok(g.hit.w>g.body.w&&g.hit.h>g.body.h);
  assert.ok(Math.abs(g.anchor.x+g.anchor.w/2-g.svg.x-g.svg.w/2)<2&&Math.abs(g.anchor.y+g.anchor.h/2-g.svg.y-g.svg.h/2)<2);
  assert.ok(g.body.x>=g.svg.x-1&&g.body.y>=g.svg.y-1&&g.body.x+g.body.w<=g.svg.x+g.svg.w+1&&g.body.y+g.body.h<=g.svg.y+g.svg.h+1);
  if(kind==='bottom-home')for(const c of g.capsules)assert.ok(Math.max(c.x-g.body.x-g.body.w,g.body.x-c.x-c.w)>=5);
  return g;
}
(async()=>{
  let products=0;
  for(const path of ['/api/health','/api/products?limit=1','/api/chats/mascot-readonly-probe/typing']){
    const r=await fetch(origin+path,{signal:AbortSignal.timeout(30000)});report.api.push({path,status:r.status});save();
    assert.equal(r.status,path.includes('/typing')?401:200);
    if(path.includes('/products')){const data=await r.json();assert.ok(Array.isArray(data.products));products=data.products.length;}
  }
  const profiles=[
    ['chromium','Pixel 7',320,844,'ar'],['chromium','Pixel 7',360,844,'en'],
    ['webkit','iPhone 13',390,844,'ar'],['webkit','iPhone 14 Pro Max',430,932,'en'],
    ['webkit','iPad (gen 7)',768,1024,'ar'],['webkit','iPad (gen 7) landscape',1024,768,'en'],
    ['chromium',null,1440,900,'en'],['webkit',null,1440,900,'ar']
  ];
  for(const [engine,device,width,height,lang] of profiles){
    const name=`${engine}-${lang}-${width}`;
    const browser=await ({chromium,webkit}[engine]).launch();
    const profile=device?devices[device]:{};assert.ok(profile,'Browser device profile exists');
    const {defaultBrowserType,...settings}=profile;
    const context=await browser.newContext({...settings,viewport:{width,height},locale:lang==='ar'?'ar-IQ':'en-US',serviceWorkers:'block'});
    await context.addInitScript(lang=>localStorage.setItem('levo_lang',lang),lang);
    const item={name,device:device||'desktop',blockedWrites:[],errors:[]};report.profiles.push(item);
    await context.route('**/*',route=>{if(!['GET','HEAD','OPTIONS'].includes(route.request().method())){item.blockedWrites.push(new URL(route.request().url()).pathname);return route.abort();}return route.continue();});
    const page=await context.newPage();page.on('pageerror',e=>item.errors.push(e.message));
    try{
      const r=await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});assert.equal(r.status(),200);
      await settle(page);item.home=await geometry(page,'bottom-home',item);
      await page.screenshot({path:`${out}/${name}-home.png`});
      await page.evaluate(()=>window.__originalMascot=document.querySelector('svg.lv-bloub'));
      await page.locator('a[href="/products"]').first().click();await page.waitForURL(/\/products(?:\?|$)/);await settle(page);
      assert.ok(await page.evaluate(()=>window.__originalMascot===document.querySelector('svg.lv-bloub')));
      if(products){
        const product=page.locator('a[href^="/product/"]').first();await product.waitFor({timeout:30000});await product.click();await settle(page);
        item.product=await geometry(page,'top-header',item);item.productScope='Published product';
        assert.ok(await page.evaluate(()=>window.__originalMascot===document.querySelector('svg.lv-bloub')));
        await page.locator('a.lv-character-home').first().click();
      }else{
        await page.getByText(lang==='ar'?'لا توجد منتجات':'No products found',{exact:true}).waitFor({timeout:30000});
        if(device)await page.locator('[data-bloub-home-button]').tap();else await page.locator('[data-bloub-home-button]').click();
        item.productScope='Public catalog empty: no live purchase was attempted';
      }
      await page.waitForURL(origin+'/');await settle(page);
      assert.ok(await page.evaluate(()=>window.__originalMascot===document.querySelector('svg.lv-bloub')));
      // Presentation-event adapter, not real failed payments or live writes.
      for(const expression of ['loading','notify','success','error']){
        await page.evaluate(s=>window.dispatchEvent(new CustomEvent('levonis:bloub-state',{detail:{state:s,durationMs:650}})),expression);
        await state(page,expression);
        if(expression==='loading'){
          const before=await page.locator('[data-bloub-gaze]').evaluate(e=>getComputedStyle(e).transform);
          await page.waitForFunction(before=>getComputedStyle(document.querySelector('[data-bloub-gaze]')).transform!==before,before,{timeout:1500,polling:'raf'});
        }
        if(expression==='error'&&width===390)await page.screenshot({path:`${out}/${name}-error.png`});
        await settle(page);
      }
      if(!products){
        await page.goto(origin+'/product/mascot-readonly-not-a-product',{waitUntil:'domcontentloaded'});await settle(page);
        item.notFoundHeader=await geometry(page,'top-header',item);
        await page.screenshot({path:`${out}/${name}-header.png`});
        await page.locator('a.lv-character-home').first().click();await page.waitForURL(origin+'/');await settle(page);
      }
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.waitForFunction(()=>document.querySelector('svg.lv-bloub')?.dataset.reduced==='true');
      for(const selector of ['.lv-bloub-breath','.lv-bloub-gaze','.lv-bloub-blink'])assert.equal(await page.locator(selector).evaluate(e=>getComputedStyle(e).animationName),'none');
      assert.deepEqual(item.errors,[]);item.result='passed';console.log(`PASS ${name}: actual body ${item.home.body.w.toFixed(1)}px, independent hit ${item.home.hit.w.toFixed(1)}px, live navigation/persistence, expressions and reduced motion`);
    }catch(e){item.result='failed';item.error=String(e);item.failureState=await page.evaluate(()=>({phase:document.querySelector('.lv-app-intro')?.dataset.phase,state:document.querySelector('.lv-app-intro')?.dataset.mascotState,path:document.querySelector('[data-bloub-body]')?.getAttribute('d')})).catch(()=>null);await page.screenshot({path:`${out}/${name}-failure.png`}).catch(()=>{});throw e;}
    finally{save();await browser.close();}
  }
  report.result='passed';save();console.log('All eight anonymous phone/tablet/desktop profiles passed without production writes.');
})().catch(e=>{report.result='failed';report.error=String(e);save();console.error(e);process.exitCode=1;});
