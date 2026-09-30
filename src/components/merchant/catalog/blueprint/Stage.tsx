/**
 * THE BUILDER'S STAGE (docs/LEVO_PROJECT_PROGRAMME.md §B.2 items 3–5 and «the
 * look card»): the draft's own model through the viewer core
 * (src/lib/viewer/studio.ts, lane L7 — loaded here, lazily), or, on a
 * photo-only blueprint, the product's photo with each area's four corners.
 *
 *   PARTS mode  every region its own colour (the list's dots are the same
 *               palette keys), a part in no region grey, the chosen part in
 *               the accent — the one selection cue
 *   LOOK mode   every region in its first colour, the areas drawn where they
 *               will print (the decal atlas), the add-ons' simplified markers
 *   a tap       triangle → part (the LVR1 ranges) → `onPick` with the point
 *               and the triangle's own normal; every tap has a twin in the
 *               step's list, and the canvas is `role=img`
 *   capture     the look card (./capture.ts): the spec's regions in order,
 *               a part in no region hidden, the default view, a neutral
 *               render and the flat id pass; the screen is put back after
 *
 * A browser without WebGL keeps the list (`failed`); the canvas never
 * decides anything.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Area, BlueprintSpec, PaletteKey, Quad, Slot, Vec3 } from '../../../../../packages/catalog/src/personalize/types';
import { PALETTE_RGB } from '../../../../../packages/catalog/src/personalize/color';
import type { LoadedMesh } from '../../../../lib/viewer/mesh';
import type { Studio } from '../../../../lib/viewer/studio';
import type { DecalAtlas } from '../../../../lib/viewer/decals';
import { IDMAP_SIZES, POSTER_SIZE, blobBase64, fitIdMap, fitPoster, idsOf, quadOf, type LookBody } from './capture';
import { widthAxis } from './model';

/** The categorical colours of the parts map, as palette keys (the list draws the same `lv-swatch`). */
export const PART_COLOURS: readonly PaletteKey[] = ['blue', 'orange', 'green', 'purple', 'teal', 'pink', 'yellow', 'red'];
const GREY = [0.55, 0.56, 0.6];
const ACCENT = [0.86, 0.66, 0.29];
const UNSET = 14;
const CHOSEN = 15;

export interface StageHit {
  part: number;
  point: Vec3;
  normal: Vec3;
}

export interface StageHandle {
  /** The look card of `spec`; null when the browser could not draw it. */
  capture(spec: BlueprintSpec): Promise<LookBody | null>;
}

const rgbOf = (k: PaletteKey) => (PALETTE_RGB[k] ?? [150, 150, 150]).map((x) => x / 255);

/** Part → region slot and the 16 colours, for the screen. */
export function stageRegions(spec: Pick<BlueprintSpec, 'regions'>, parts: number, mode: 'parts' | 'look', chosen: number | null): { map: number[]; colours: number[] } {
  const map = Array.from({ length: parts }, (_, p) => {
    if (mode === 'parts' && p === chosen) return CHOSEN;
    const i = spec.regions.findIndex((r) => r.parts.includes(p));
    return i < 0 ? UNSET : Math.min(i, UNSET - 1);
  });
  const colours: number[] = [];
  for (let k = 0; k < 16; k++) {
    const r = spec.regions[k];
    colours.push(...(k === CHOSEN ? ACCENT : k === UNSET || !r ? GREY : rgbOf(mode === 'parts' ? PART_COLOURS[k % PART_COLOURS.length] : r.paint.default)));
  }
  return { map, colours };
}

interface Props {
  mesh: LoadedMesh | null;
  spec: BlueprintSpec;
  mode: 'parts' | 'look';
  chosen: number | null;
  /** Areas drawn on the model (LOOK mode), the active one in the accent. */
  areas: readonly Area[];
  activeArea: string | null;
  /** Slots whose marker is drawn at its anchor. */
  slots: readonly Slot[];
  reduced: boolean;
  label: string;
  loading: string;
  failedText: string;
  onPick: (hit: StageHit) => void;
}

/** A slot's simplified marker: its own effect, or for `marker` the part kind's (a light glows, a magnet is a ring). */
function markerOf(s: Slot): 'glow' | 'ring' | 'badge' | null {
  const e = s.show?.anchor ? s.show.effect : undefined;
  if (e === 'glow' || e === 'ring' || e === 'badge') return e;
  return e === 'marker' ? (s.kind === 'led' ? 'glow' : s.kind === 'magnet' ? 'ring' : 'badge') : null;
}

export const Stage = forwardRef<StageHandle, Props>(function Stage(props, ref) {
  const { mesh, spec, mode, chosen, areas, activeArea, slots, reduced } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const studio = useRef<Studio | null>(null);
  const atlas = useRef<{ a: DecalAtlas; key: string } | null>(null);
  const [ready, setReady] = useState(false);
  const readyNow = useRef(false);
  const waiting = useRef<Array<() => void>>([]);
  const [failed, setFailed] = useState(false);
  const [redo, setRedo] = useState(0);
  const parts = mesh ? (mesh.ranges ? mesh.ranges.length / 2 : 1) : 0;
  const onPick = useRef(props.onPick);
  onPick.current = props.onPick;

  useEffect(() => {
    const el = canvas.current;
    if (!mesh || !el) return;
    let alive = true;
    setReady(false);
    readyNow.current = false;
    setFailed(false);
    const onReady = () => {
      if (!alive) return;
      readyNow.current = true;
      setReady(true);
      for (const done of waiting.current.splice(0)) done();
    };
    import('../../../../lib/viewer/studio')
      .then(({ mountStudio }) => {
        if (!alive) return;
        const { map, colours } = stageRegions(spec, parts, mode, chosen);
        studio.current = mountStudio(el, mesh, { onReady, regions: { partToRegion: map, colours }, reducedMotion: reduced });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      readyNow.current = false;
      studio.current?.dispose();
      studio.current = null;
      atlas.current = null;
    };
    // The scene is mounted once per mesh; later changes are uniform writes below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh]);

  // Regions and colours: one attribute pass and one uniform write.
  useEffect(() => {
    const s = studio.current;
    if (!s || !ready) return;
    const { map, colours } = stageRegions(spec, parts, mode, chosen);
    s.setRegions(map);
    s.setRegionColours(colours, true);
  }, [spec.regions, parts, mode, chosen, ready, redo]); // eslint-disable-line react-hooks/exhaustive-deps

  // The areas where they will print, and the add-ons' markers (LOOK mode).
  useEffect(() => {
    const s = studio.current;
    if (!s || !ready) return;
    const framed = mode === 'look' ? areas.filter((a) => a.frame).slice(0, 4) : [];
    s.setMarkers(
      mode === 'look'
        ? slots.flatMap((x) => {
            const kind = markerOf(x);
            return kind && x.show?.anchor ? [{ kind, at: x.show.anchor.o, n: x.show.anchor.n, size: Math.max(4, x.show.anchor.w) }] : [];
          })
        : []
    );
    if (!framed.length) {
      s.setDecals(null, []);
      return;
    }
    let alive = true;
    void import('../../../../lib/viewer/decals').then(async (d) => {
      if (!alive || studio.current !== s) return;
      const aspects = framed.map((a) => a.frame!.w / a.frame!.h);
      const key = aspects.map((x) => x.toFixed(3)).join();
      // A new atlas only when an area's shape changed: its rectangles are cut to the frames' aspects.
      const a = atlas.current?.key === key ? atlas.current.a : d.createAtlas(aspects);
      atlas.current = { a, key };
      for (let k = 0; k < framed.length; k++) await paintSlot(a, k, labelOf(framed[k]), framed[k].id === activeArea);
      if (!alive || studio.current !== s) return;
      a.version++;
      if (a.texture) a.texture.needsUpdate = true;
      s.setDecals(a, framed.map((x, k) => ({ slot: k, region: Math.max(0, spec.regions.findIndex((r) => r.id === x.region)), frame: { ...x.frame!, u: widthAxis(x.frame!) } })));
    });
    return () => {
      alive = false;
    };
  }, [areas, activeArea, slots, mode, ready, redo, spec.regions]);

  useImperativeHandle(ref, () => ({
    async capture(target) {
      // A stage mounted a moment ago: its first frame first (at most 10 s).
      if (!readyNow.current) await new Promise<void>((done) => { waiting.current.push(done); setTimeout(done, 10_000); });
      const s = studio.current;
      if (!s || !readyNow.current) return null;
      try {
        const map = Array.from({ length: parts }, (_, p) => Math.max(0, target.regions.findIndex((r) => r.parts.includes(p))));
        const off = map.map((_, p) => !target.regions.some((r) => r.parts.includes(p)));
        s.setDecals(null, []);
        s.setMarkers([]);
        s.setRegions(map);
        off.forEach((h, p) => h && s.setPartVisible(p, false));
        s.resetCamera();
        const neutral = s.capture({ mode: 'neutral', size: POSTER_SIZE });
        const ids = s.capture({ mode: 'ids', size: IDMAP_SIZES[0] });
        const camera = s.lookMatrix();
        off.forEach((h, p) => h && s.setPartVisible(p, true));
        setRedo((n) => n + 1);
        const full = document.createElement('canvas');
        full.width = full.height = POSTER_SIZE;
        full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(neutral), POSTER_SIZE, POSTER_SIZE), 0, 0);
        const poster = await fitPoster(
          (size, type, quality) =>
            new Promise<Blob | null>((done) => {
              let c = full;
              if (size !== POSTER_SIZE) {
                c = document.createElement('canvas');
                c.width = c.height = size;
                c.getContext('2d')!.drawImage(full, 0, 0, size, size);
              }
              c.toBlob(done, type, quality);
            })
        );
        const idmap = fitIdMap(idsOf(ids, IDMAP_SIZES[0]), IDMAP_SIZES[0]);
        if (!poster || !idmap) return null;
        const quads: Record<string, Quad> = {};
        for (const a of target.areas) if (a.frame) quads[a.id] = quadOf(a.frame, camera);
        return { poster: await blobBase64(poster.blob), idmap: idmap.b64, quads, camera };
      } catch {
        return null;
      }
    },
  }));

  // A tap (not a turn): a few pixels and a moment.
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = down.current;
    down.current = null;
    const s = studio.current;
    if (!d || !s || !mesh || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || e.timeStamp - d.t > 600) return;
    const box = e.currentTarget.getBoundingClientRect();
    const hit = s.pick(e.clientX - box.left, e.clientY - box.top);
    if (!hit || hit.part < 0) return;
    const n = mesh.mesh.normal;
    const o = hit.triangle * 9;
    onPick.current({ part: hit.part, point: hit.point, normal: [n[o], n[o + 1], n[o + 2]] });
  }

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border-subtle bg-surface-raised" data-stage={failed ? 'failed' : ready ? 'ready' : 'loading'}>
      {!failed && (
        <canvas
          ref={canvas}
          role="img"
          aria-label={props.label}
          className="block h-full w-full touch-none"
          onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY, t: e.timeStamp })}
          onPointerUp={up}
        />
      )}
      {(!ready || failed) && (
        <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-[13px] text-text-muted" role="status">
          {failed ? props.failedText : props.loading}
        </p>
      )}
    </div>
  );
});

function labelOf(a: Area): string {
  if (a.text) return a.text.sample.en || a.text.sample.ar;
  return a.kind === 'qr' ? 'QR' : a.kind === 'logo' ? 'LOGO' : a.kind === 'photo' ? 'PHOTO' : '★';
}

/** One area on the atlas: a light plate with a border and its sample, the active one in the accent. */
async function paintSlot(atlas: DecalAtlas, k: number, label: string, active: boolean): Promise<void> {
  const { ctx } = atlas;
  const r = atlas.rects[k];
  const q = atlas.canvas.width / 2;
  ctx.clearRect((k % 2) * q, (k >> 1) * q, q, q);
  const line = Math.max(4, Math.min(r.w, r.h) * 0.05);
  ctx.fillStyle = active ? 'rgba(220,168,74,0.5)' : 'rgba(255,255,255,0.3)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.lineWidth = line;
  ctx.strokeStyle = active ? 'rgba(220,168,74,1)' : 'rgba(255,255,255,0.95)';
  ctx.strokeRect(r.x + line / 2, r.y + line / 2, r.w - line, r.h - line);
  const font = '700 100px Cairo';
  await document.fonts?.load(font, label).catch(() => undefined);
  ctx.font = font;
  const px = Math.max(8, Math.min(r.h * 0.55, ((r.w * 0.8) / (ctx.measureText(label).width || 1)) * 100));
  ctx.font = `700 ${px}px Cairo`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = /[؀-ۿ]/.test(label) ? 'rtl' : 'ltr';
  ctx.fillStyle = 'rgba(24,24,28,0.92)';
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
}

/** A photo-only blueprint's stage: the photo, each area's outline, and the active one's four corners to drag. */
export function PhotoStage({
  url,
  quads,
  active,
  onQuad,
  label,
}: {
  url: string;
  quads: ReadonlyArray<{ id: string; quad: Quad }>;
  active: string | null;
  onQuad: (id: string, quad: Quad) => void;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(1);
  const drag = useRef<number | null>(null);
  const current = quads.find((q) => q.id === active);
  const move = (i: number, x: number, y: number) => {
    if (!current) return;
    const next = current.quad.map((p, j) => (j === i ? [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] : p)) as Quad;
    onQuad(current.id, next);
  };
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as const;
  };
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-2xl border border-border-subtle bg-surface-raised" style={{ aspectRatio: String(ratio) }} data-stage="photo">
      <img src={url} alt={label} className="block h-full w-full object-contain" onLoad={(e) => setRatio(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight) || 1)} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full text-gold" aria-hidden="true">
        {quads.map((q) => (
          <polygon
            key={q.id}
            points={q.quad.map((p) => p.join(',')).join(' ')}
            fill="currentColor"
            fillOpacity={q.id === active ? 0.28 : 0.12}
            stroke="currentColor"
            strokeWidth={q.id === active ? 2 : 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {current?.quad.map(([x, y], i) => (
        <span
          key={i}
          role="slider"
          tabIndex={0}
          aria-label={`${label} ${i + 1}`}
          aria-valuenow={Math.round(x * 100)}
          aria-valuetext={`${Math.round(x * 100)}, ${Math.round(y * 100)}`}
          className="absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-gold bg-surface"
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
          data-corner={i}
          onPointerDown={(e) => {
            drag.current = i;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => drag.current === i && move(i, ...at(e))}
          onPointerUp={() => (drag.current = null)}
          onKeyDown={(e) => {
            const d = { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, -0.01], ArrowDown: [0, 0.01] }[e.key];
            if (!d) return;
            e.preventDefault();
            move(i, x + d[0], y + d[1]);
          }}
        />
      ))}
    </div>
  );
}
