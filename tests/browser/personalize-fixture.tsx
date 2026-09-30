/**
 * THE STUDIO, MOUNTED AS SHIPPED (Programme C, phase C1, lane L8) — over a
 * REAL mesh and scripted doors, for screenshots and for L10's
 * scripts/e2e-personalize.mjs. A browser fixture served only by a local
 * `vite` dev server, never reachable from production.
 *
 *   /tests/browser/personalize.html?bp=a|b|c|d|e|photo|icon
 *       &lang=ar|en|ckb &theme=dark|light &motion=reduce
 *       &gl=off &dstream=off          (read by the studio itself)
 *       &name=ALI &size=s|m|l &look=classic|silk   (a starting design)
 *       &preview=1                    (the builder's preview mode)
 *       &open=look|size|more          (a tile opened after the first paint)
 *
 *   a  the name stand (archetype A: Name · Look · Size · More + the door)
 *   b  the QR menu stand   c  the request-only photo lamp
 *   d  the name keychain   e  the group participant
 *   photo  the photo-only sign (no mesh: the merchant's photos)
 *   icon   the keychain with its heart icon chosen (the charm part shows)
 *
 * THE MESH IS REAL: boxes shaped around each blueprint's own area frames,
 * written as LVM1 + the LVR1 ranges trailer (worker/lib/personalize/
 * compile.ts's format, lane L4), gzipped in the page with CompressionStream
 * and served as `application/gzip` at the blueprint's `mesh.url`. THE LOOK
 * CARD IS CAPTURED the way the builder will (lane L9): the viewer's studio
 * scene renders the neutral poster and the region-id pass once, the frames go
 * through its camera into quads (src/components/personalize/lookcard.ts).
 *
 * `window.fetch` answers the /api/personalize doors with the shapes
 * worker/routes/personalize.ts returns (the blueprints are
 * tests/fixtures/personalizeBlueprints.ts's PublicBlueprints); a minted
 * configuration's request body is kept in `window.__mints` for probes.
 *
 * The studio is mounted the way the builder mounts it: a lazy chunk under
 * Suspense (it also waits for its words, one language's chunk).
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import { Toaster } from '../../src/components/ui/Toast';
import { toast } from '../../src/lib/toastStore';
import { personalizeApi } from '../../src/components/personalize/api';
import { studioWords } from '../../src/components/personalize/strings';
import { encodeIdMap, frameQuad } from '../../src/components/personalize/lookcard';
import { FIXTURES } from '../fixtures/personalizeBlueprints';
import { defaultConfig } from '../../packages/catalog/src/personalize/config';
import type { DesignConfig, PublicBlueprint } from '../../packages/catalog/src/personalize/types';
import '../../src/index.css';

const Studio = lazy(() => import('../../src/components/personalize/Studio'));

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
try {
  localStorage.setItem('levo_lang', lang);
} catch {
  /* Arabic, the default */
}
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

// Reduced motion on demand, answered before the app first asks.
if (params.get('motion') === 'reduce') {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q: string) =>
    q.includes('prefers-reduced-motion')
      ? ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as MediaQueryList)
      : real(q);
}

const PICK = { a: 'nameStand', b: 'qrMenuStand', c: 'photoLamp', d: 'nameKeychain', e: 'groupParticipant', photo: 'photoOnlySign', icon: 'nameKeychain' } as const;
const bp = (params.get('bp') ?? 'a') as keyof typeof PICK;
const fixture = FIXTURES[PICK[bp] ?? 'nameStand'];
const pub: PublicBlueprint = JSON.parse(JSON.stringify(fixture.pub));

// ------------------------------------------------------------------ the mesh

type Box = [number, number, number, number, number, number];

/** Six faces, each wound so its normal points out (the decals' facing test reads the winding). */
function boxTriangles([x0, y0, z0, x1, y1, z1]: Box): number[] {
  const faces = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
  ];
  return faces.flatMap(([a, b, c, d]) => [...a, ...b, ...c, ...a, ...c, ...d]);
}

/** A box around a front frame, its face on the frame's plane, `margin` mm round it, `depth` mm deep. */
function plate(f: { o: number[]; w: number; h: number }, margin: number, depth = 6): Box {
  return [f.o[0] - f.w / 2 - margin, f.o[1], f.o[2] - f.h / 2 - margin, f.o[0] + f.w / 2 + margin, f.o[1] + depth, f.o[2] + f.h / 2 + margin];
}

/** The parts of each blueprint as boxes, by LVR1 part index. */
function partsOf(p: PublicBlueprint): Box[][] {
  const parts: Box[][] = [];
  const add = (i: number, b: Box) => (parts[i] ??= []).push(b);
  if (bp === 'a') {
    // The controller stand: a base, a body with a cradle step (its magnet sits on the lower face), a back, the name plate.
    add(0, [-60, -30, -48, 60, 40, -20]);
    add(0, [-60, -40, -20, 60, 40, 6]);
    add(0, [-65, 22, 6, 65, 40, 60]);
    add(1, [-75, -50, -60, 75, 50, -48]);
    add(2, [-36, -40, 6, 36, -33, 34]);
    return parts;
  }
  for (const r of p.regions) {
    const frames = p.areas.filter((a) => a.region === r.id && a.frame).map((a) => a.frame!);
    for (const i of r.parts) {
      if (frames.length) for (const f of frames) add(i, plate(f, r.role === 'body' ? 8 : 4));
      else if (r.role === 'base') add(i, [-75, -50, -60, 75, 50, -48]);
      else if (r.role === 'accessory') add(i, [30, -4, 10, 44, 4, 24]);
      else if (r.role === 'icon') add(i, [26, -6, -8, 38, -1, 8]);
      else add(i, [-60, -40, -48, 60, 40, 40]);
    }
  }
  return parts;
}

/** LVM1 (header, triangles in mm) + LVR1 (ranges only). */
function lvm(parts: Box[][]): ArrayBuffer {
  const tris = parts.map((boxes) => (boxes ?? []).flatMap(boxTriangles));
  const t = tris.reduce((n, f) => n + f.length / 9, 0);
  const buf = new ArrayBuffer(32 + 36 * t + 8 + 8 * tris.length);
  const v = new DataView(buf);
  [0x4c, 0x56, 0x4d, 0x31].forEach((b, i) => v.setUint8(i, b));
  v.setUint32(4, t, true);
  const all = tris.flat();
  const min = [0, 1, 2].map((k) => Math.min(...all.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...all.filter((_, i) => i % 3 === k)));
  [...min, ...max].forEach((x, i) => v.setFloat32(8 + i * 4, x, true));
  all.forEach((x, i) => v.setFloat32(32 + i * 4, x, true));
  const at = 32 + 36 * t;
  [0x4c, 0x56, 0x52, 0x31].forEach((b, i) => v.setUint8(at + i, b));
  v.setUint16(at + 4, tris.length, true);
  v.setUint16(at + 6, 0, true);
  let start = 0;
  tris.forEach((f, i) => {
    v.setUint32(at + 8 + i * 8, start, true);
    v.setUint32(at + 12 + i * 8, f.length / 9, true);
    start += f.length / 9;
  });
  return buf;
}

async function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

// ------------------------------------------------------------------ the look card (captured as the builder will)

async function captureLook(raw: ArrayBuffer): Promise<PublicBlueprint['look']> {
  const [{ mountStudio }, { parseLvm }, { readRegions }] = await Promise.all([
    import('../../src/lib/viewer/studio'),
    import('../../src/lib/viewer/lvm'),
    import('../../src/lib/viewer/mesh'),
  ]);
  const mesh = parseLvm(raw);
  if (!mesh) return null;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:512px;height:512px';
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  try {
    const partToRegion: number[] = [];
    pub.regions.forEach((r, i) => r.parts.forEach((p) => (partToRegion[p] = i)));
    const studio = await new Promise<ReturnType<typeof mountStudio>>((resolve, reject) => {
      try {
        const s = mountStudio(canvas, { mesh, ranges: readRegions(raw) }, { onReady: () => resolve(s), regions: { partToRegion, colours: [] }, reducedMotion: true });
      } catch (e) {
        reject(e);
      }
    });
    // The poster at 1024; the id map at 512 while its runs stay within the 8 KB the Worker keeps, else 256.
    const size = 1024;
    const neutral = studio.capture({ mode: 'neutral', size });
    const idmapAt = (n: number) => {
      const rgba = studio.capture({ mode: 'ids', size: n });
      const red = new Uint8Array(n * n);
      for (let i = 0; i < red.length; i++) red[i] = rgba[i * 4];
      return encodeIdMap(red, n, n);
    };
    const fine = idmapAt(512);
    const idmap = atob(fine).length <= 8192 ? fine : idmapAt(256);
    const camera = studio.lookMatrix();
    studio.dispose();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(neutral), size, size), 0, 0);
    const quads = Object.fromEntries(pub.areas.filter((a) => a.frame).map((a) => [a.id, frameQuad(a.frame!, camera)]));
    return { poster_url: c.toDataURL('image/png'), w: size, h: size, idmap, quads: quads as never, camera };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

// ------------------------------------------------------------------ the photo-only product's photos

function signPhoto(board: [number, number, number], wood: boolean, wide: boolean): string {
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 500;
  const g = c.getContext('2d')!;
  const wall = g.createLinearGradient(0, 0, 0, 500);
  wall.addColorStop(0, 'rgb(214, 208, 198)');
  wall.addColorStop(1, 'rgb(176, 168, 156)');
  g.fillStyle = wall;
  g.fillRect(0, 0, 800, 500);
  const [x0, x1] = wide ? [60, 740] : [96, 704];
  g.fillStyle = 'rgba(0, 0, 0, 0.25)';
  g.fillRect(x0 + 10, 135, x1 - x0, 220);
  const face = g.createLinearGradient(0, 125, 0, 345);
  face.addColorStop(0, `rgb(${board.map((x) => Math.min(255, x + 22)).join(',')})`);
  face.addColorStop(1, `rgb(${board.map((x) => Math.max(0, x - 18)).join(',')})`);
  g.fillStyle = face;
  g.fillRect(x0, 125, x1 - x0, 220);
  if (wood) {
    g.strokeStyle = 'rgba(70, 40, 18, 0.35)';
    for (let y = 135; y < 345; y += 9) {
      g.beginPath();
      g.moveTo(x0, y);
      g.bezierCurveTo(300, y + 6, 500, y - 6, x1, y + 2);
      g.stroke();
    }
  }
  return c.toDataURL('image/png');
}

// ------------------------------------------------------------------ the doors

declare global {
  interface Window {
    __calls: string[];
    __mints: unknown[];
    __ready: boolean;
  }
}
window.__calls = [];
window.__mints = [];
let meshGz: ArrayBuffer | null = null;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (pub.mesh && u.pathname === pub.mesh.url) {
    window.__calls.push(`${method} ${u.pathname}`);
    await new Promise((r) => setTimeout(r, 120));
    return new Response(meshGz, { status: 200, headers: { 'content-type': 'application/gzip' } });
  }
  if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
  window.__calls.push(`${method} ${u.pathname}${u.search}`);
  await new Promise((r) => setTimeout(r, 40));
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/api/personalize/status') return json(200, { success: true, on: true, may_use: true, may_build: false, cart: true, create: false, social: false });
  if (u.pathname === `/api/personalize/blueprints/${pub.product.id}`) return json(200, { success: true, preview: params.get('preview') === '1', blueprint: pub });
  if (u.pathname === '/api/personalize/configs' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'));
    window.__mints.push(body);
    return json(201, { success: true, config_id: 'dc_fixture', twin_code: 'T0FIXTURE', unit_iqd: 0, adds: [], words: { ar: '', en: '', ckb: '' }, check: { verdict: 'ready', issues: [] }, config: body.configuration });
  }
  return json(404, { success: false, error: 'Not found', code: 'PERSONALIZATION_UNAVAILABLE' });
};

// ------------------------------------------------------------------ the page

function startingDesign(p: PublicBlueprint): DesignConfig | null {
  const name = params.get('name');
  const size = params.get('size');
  const look = params.get('look');
  if (!name && !size && !look && bp !== 'icon') return null;
  const c = defaultConfig(p);
  const cur = p.variants.find((v) => v.id === c.variant);
  const want: Record<string, string> = { ...(cur?.values ?? {}) };
  if (size && p.axes.size) want[p.axes.size.group] = `ov_${size}`;
  if (look && p.axes.look) want[p.axes.look.group] = `ov_${look}`;
  const variant = p.variants.find((v) => Object.entries(want).every(([g, x]) => v.values[g] === x))?.id ?? c.variant;
  const nameArea = p.areas.find((a) => a.role === 'name');
  return {
    ...c,
    variant,
    texts: name && nameArea ? { ...c.texts, [nameArea.id]: { value: [name], style: nameArea.text!.default_style } } : c.texts,
    icon: bp === 'icon' ? { badge: 'heart' } : c.icon,
  };
}

function Page() {
  const [blueprint, setBlueprint] = useState<PublicBlueprint | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    void personalizeApi.blueprint(pub.product.id).then((r) => {
      setPreview(r.preview);
      setBlueprint(r.blueprint);
    });
  }, []);
  useEffect(() => {
    const open = params.get('open');
    if (!blueprint || !open) return;
    // Once the studio (a lazy chunk, then its words) is on the screen.
    let tries = 0;
    const id = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-control="${open}"]`);
      if (!el && ++tries < 80) return;
      window.clearInterval(id);
      el?.click();
    }, 100);
    return () => window.clearInterval(id);
  }, [blueprint]);
  if (!blueprint) return null;
  return (
    <div style={{ height: '100dvh' }}>
      <Suspense fallback={null}>
        <Studio
          blueprint={blueprint}
          preview={preview}
          initial={startingDesign(blueprint)}
          community={{ open: true, takes_requests: true }}
          onClose={() => undefined}
          onDoor={
            preview
              ? undefined
              : async (kind, configuration) => {
                  const r = await personalizeApi.mint(blueprint.product.id, configuration);
                  toast.success((await studioWords(lang)).door[kind], { description: r.config_id });
                }
          }
        />
      </Suspense>
      <Toaster />
    </div>
  );
}

async function boot() {
  if (pub.mesh) {
    const raw = lvm(partsOf(pub));
    meshGz = await gzip(raw);
    pub.look = await captureLook(raw).catch(() => null);
  } else {
    const rgb: Record<string, [number, number, number]> = { black: [34, 34, 38], white: [236, 234, 228], wood: [156, 104, 58] };
    pub.photos = pub.photos.map((ph) => ({ ...ph, url: signPhoto(rgb[ph.colour ?? 'wood'] ?? rgb.wood, (ph.colour ?? 'wood') === 'wood', !!ph.value_id) }));
  }
  window.__ready = true;
  createRoot(document.getElementById('root')!).render(
    <LanguageProvider>
      <Page />
    </LanguageProvider>
  );
}
void boot();
