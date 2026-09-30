/**
 * /model-viewer/:token — the standalone 3D preview of an uploaded print model.
 *
 * NO SITE CHROME, ON PURPOSE. The link is handed to whoever needs to LOOK at
 * the part — a merchant quoting it, a customer checking what they uploaded —
 * so the page is the model and nothing else. It is `fixed inset-0` rather than
 * an ordinary page body precisely so it stays a full viewport whichever layout
 * the router happens to wrap it in.
 *
 * THE BROWSER NEVER PARSES THE CUSTOMER'S FILE. The Worker already measured
 * the upload and cached a derived mesh (worker/lib/modelGeometry.ts →
 * `viewerMesh`); this page fetches THOSE bytes, never the STL/3MF/OBJ. That is
 * why the viewer core (src/lib/viewer — the mesh reader, the scene, the AR
 * path, shared with the studio) has a 32-byte header reader instead of a model
 * loader, and it is what keeps the store bundle free of slicer payload (T1,
 * tests/store-isolation.test.ts). `ogl` is the only 3D library available here —
 * `three` is banned by that same test. This file is the page: the strings, the
 * two fetches, the controls and the measurements.
 *
 * TWO 404s, TWO MEANINGS. Metadata is fetched first: a 404 there means the
 * token is wrong, expired or revoked, and the Worker refuses to say which, so
 * this page says one thing and nothing technical. A 404 on the MESH *after*
 * metadata succeeded means the token is fine but the format has no preview —
 * a different, much softer failure, where the measurements panel still stands
 * on its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Boxes,
  Component,
  Cuboid,
  Grid3x3,
  Link2Off,
  Loader2,
  RotateCcw,
  Rotate3d,
  Ruler,
  Smartphone,
  Triangle,
  TriangleAlert,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { parseLvm, type ParsedMesh } from '../lib/viewer/lvm';
import { mountScene, type Scene } from '../lib/viewer/scene';
import { xrParts } from '../lib/viewer/xr';

/**
 * No `name`: the server stopped sending the customer's own file name (audit 03
 * §10 F) — it reached anyone holding the link. The page says what it shows.
 */
interface ViewerMeta {
  format: string;
  dimensions_mm: { x: number; y: number; z: number } | null;
  volume_mm3: number | null;
  triangle_count: number | null;
  shell_count: number | null;
  expires_at: string;
  /** 'preview' = the coarse mesh a merchant quoting on the board is sent (worker/routes/printRequests.ts). */
  grant?: 'full' | 'preview';
}

const STR = {
  ar: {
    loading: 'جارٍ تحميل المجسم',
    title: 'معاينة المجسم',
    simplified: 'معاينة مبسّطة',
    simplifiedHint: 'شكل مبسّط من المجسم للتسعير، والملف الأصلي أدق تفصيلًا.',
    gone: 'هذا الرابط لم يعد صالحًا',
    goneHint: 'اطلب رابط عرض جديدًا ممن أرسله إليك.',
    failed: 'تعذّر فتح العارض',
    failedHint: 'حدّث الصفحة بعد قليل.',
    noPreview: 'لا تتوفر معاينة ثلاثية الأبعاد لهذا الملف، والقياسات معروضة أدناه.',
    noWebgl: 'متصفحك لا يدعم العرض ثلاثي الأبعاد، لذلك تظهر القياسات وحدها.',
    dims: 'الأبعاد',
    volume: 'الحجم',
    triangles: 'المثلثات',
    parts: 'عدد القطع',
    format: 'الصيغة',
    reset: 'إعادة ضبط العرض',
    grid: 'الشبكة الأرضية',
    wireframe: 'الهيكل السلكي',
    ar: 'عرض بالواقع المعزز',
    arExit: 'إنهاء الواقع المعزز',
    arFailed: 'تعذّر تشغيل الواقع المعزز على هذا الجهاز.',
    hint: 'اسحب للتدوير · قرّب للتكبير',
    mm: 'ملم',
    cm3: 'سم³',
  },
  en: {
    loading: 'Loading the model',
    title: 'Model preview',
    simplified: 'Simplified preview',
    simplifiedHint: 'A simplified shape of the model for quoting; the original file is more detailed.',
    gone: 'This link is no longer valid',
    goneHint: 'Ask whoever sent it for a fresh viewing link.',
    failed: 'The viewer could not be opened',
    failedHint: 'Refresh the page shortly.',
    noPreview: 'No 3D preview is available for this file. The measurements are below.',
    noWebgl: 'Your browser cannot render 3D, so only the measurements are shown.',
    dims: 'Dimensions',
    volume: 'Volume',
    triangles: 'Triangles',
    parts: 'Parts',
    format: 'Format',
    reset: 'Reset view',
    grid: 'Ground grid',
    wireframe: 'Wireframe',
    ar: 'View in AR',
    arExit: 'Exit AR',
    arFailed: 'Augmented reality could not start on this device.',
    hint: 'Drag to rotate · pinch to zoom',
    mm: 'mm',
    cm3: 'cm³',
  },
};

/* Latin digits in both languages: these are measurements read off a caliper or
   a slicer, and every tool the reader will compare them against prints them
   this way. Grouping still comes from the locale-aware formatter. */
const int = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const dec = (n: number, d: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export default function ModelViewer() {
  const { token } = useParams<{ token: string }>();
  const { lang, dir } = useLanguage();
  const t = lang === 'en' ? STR.en : STR.ar;

  const [meta, setMeta] = useState<ViewerMeta | null>(null);
  const [fatal, setFatal] = useState<'gone' | 'failed' | null>(null);
  const [mesh, setMesh] = useState<ParsedMesh | null>(null);
  const [noPreview, setNoPreview] = useState(false);
  const [noWebgl, setNoWebgl] = useState(false);
  const [ready, setReady] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [arSupported, setArSupported] = useState(false);
  const [arActive, setArActive] = useState(false);
  const [arError, setArError] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Scene | null>(null);

  // 1. Metadata. This is also the token check: a 404 here is the ONLY thing
  //    that means "the link is dead", and the panel it feeds is what the
  //    WebGL-less fallback falls back to.
  useEffect(() => {
    if (!token) {
      setFatal('gone');
      return;
    }
    let alive = true;
    api
      .get<ViewerMeta>(`/api/marketplace/print/viewer/${encodeURIComponent(token)}`)
      .then((res) => {
        if (alive) setMeta(res);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setFatal(e instanceof ApiError && e.status === 404 ? 'gone' : 'failed');
      });
    return () => {
      alive = false;
    };
  }, [token]);

  // 2. The mesh. Raw fetch, not `api`, because the body is binary — the client
  //    would try to parse octet-stream as JSON and throw on the first byte.
  useEffect(() => {
    if (!token || !meta) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/marketplace/print/viewer/${encodeURIComponent(token)}/mesh`, {
          credentials: 'same-origin',
        });
        if (!alive) return;
        if (!res.ok) {
          // The token already proved good above, so this is a format with no
          // cached preview — not a dead link.
          setNoPreview(true);
          return;
        }
        const parsed = parseLvm(await res.arrayBuffer());
        if (!alive) return;
        if (parsed) setMesh(parsed);
        else setNoPreview(true);
      } catch {
        if (alive) setNoPreview(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, meta]);

  // 3. The scene. Built once per mesh and torn down on unmount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!mesh || !canvas) return;
    let viewer: Scene;
    try {
      viewer = mountScene(canvas, mesh, {
        onReady: () => setReady(true),
        onAr: setArActive,
        onArError: () => setArError(true),
      });
    } catch {
      setNoWebgl(true);
      return;
    }
    viewerRef.current = viewer;
    return () => {
      viewerRef.current = null;
      viewer.dispose();
    };
  }, [mesh]);

  // `ready` is in the deps so the toggles are applied to a scene that appears
  // after them, not just to one that was already up.
  useEffect(() => {
    viewerRef.current?.setGrid(showGrid);
  }, [showGrid, ready]);
  useEffect(() => {
    viewerRef.current?.setWire(wireframe);
  }, [wireframe, ready]);

  // AR is offered only where a session can actually be opened. No disabled
  // button, no "coming soon" — on every other device the control is absent.
  useEffect(() => {
    const parts = xrParts();
    if (!parts) return;
    let alive = true;
    parts.xr
      .isSessionSupported('immersive-ar')
      .then((ok) => {
        if (alive && ok) setArSupported(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const onAr = useCallback(() => {
    setArError(false);
    if (arActive) viewerRef.current?.stopAr();
    else viewerRef.current?.startAr();
  }, [arActive]);

  const dims = meta?.dimensions_mm ??
    (mesh ? { x: mesh.max[0] - mesh.min[0], y: mesh.max[1] - mesh.min[1], z: mesh.max[2] - mesh.min[2] } : null);
  const triangles = meta?.triangle_count ?? mesh?.triangles ?? null;
  const showCanvas = !fatal && !noWebgl && !noPreview;
  const showLoader = !fatal && !ready && !noWebgl && !noPreview;

  const btn =
    'inline-flex items-center justify-center min-h-11 min-w-11 rounded-xl border border-white/10 ' +
    'bg-zinc-950/70 backdrop-blur-md text-zinc-300 hover:text-white hover:border-white/25 transition-colors';
  const btnOn = 'border-gold/50 bg-gold/15 text-gold hover:text-gold';

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-black text-white"
      dir={dir}
      data-page="model-viewer"
    >
      {showCanvas && (
        <div className="absolute inset-0" data-viewer={ready ? 'ready' : undefined}>
          {/* touch-none: the orbit owns the gesture, so the page must not try
              to scroll or double-tap-zoom underneath it. */}
          <canvas ref={canvasRef} data-viewer="canvas" className="absolute inset-0 block touch-none" />
        </div>
      )}

      {showLoader && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black">
          <Loader2 className="h-7 w-7 animate-spin text-gold" aria-hidden />
          <p className="text-sm text-zinc-400">{t.loading}</p>
        </div>
      )}

      {fatal && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 text-center">
            {fatal === 'gone' ? (
              <Link2Off className="mx-auto mb-3 h-8 w-8 text-zinc-500" aria-hidden />
            ) : (
              <TriangleAlert className="mx-auto mb-3 h-8 w-8 text-zinc-500" aria-hidden />
            )}
            <p className="text-lg font-black leading-tight">{fatal === 'gone' ? t.gone : t.failed}</p>
            <p className="mt-2 text-sm text-zinc-400">{fatal === 'gone' ? t.goneHint : t.failedHint}</p>
          </div>
        </div>
      )}

      {!fatal && (
        <>
          {/* Top bar: what this is, and the controls. Both float over the
              canvas so the model keeps the whole viewport. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 p-3">
            <div className="pointer-events-auto min-w-0 flex-1 rounded-xl border border-white/10 bg-zinc-950/70 px-3 py-2 backdrop-blur-md">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-bold">{t.title}</p>
                {/* The board's merchant is sent a coarse mesh, never the file:
                    say so, or a rough shape reads as a rough print. */}
                {meta?.grant === 'preview' && (
                  <span
                    data-viewer="simplified"
                    title={t.simplifiedHint}
                    className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold text-amber-200"
                  >
                    {t.simplified}
                    <span className="sr-only"> — {t.simplifiedHint}</span>
                  </span>
                )}
              </div>
              {meta?.format && (
                <p
                  className="text-[11px] uppercase tracking-wide text-zinc-400"
                  dir="ltr"
                  aria-label={t.format}
                >
                  {meta.format}
                </p>
              )}
            </div>

            <div className="pointer-events-auto flex shrink-0 items-center gap-2">
              {arSupported && mesh && !noWebgl && (
                <button
                  type="button"
                  onClick={onAr}
                  data-viewer="ar"
                  aria-pressed={arActive}
                  title={arActive ? t.arExit : t.ar}
                  aria-label={arActive ? t.arExit : t.ar}
                  className={`${btn} gap-2 px-3 ${arActive ? btnOn : ''}`}
                >
                  <Smartphone className="h-4 w-4" aria-hidden />
                  <span className="hidden text-xs font-bold sm:inline">{arActive ? t.arExit : t.ar}</span>
                </button>
              )}
              {showCanvas && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowGrid((v) => !v)}
                    data-viewer="grid"
                    aria-pressed={showGrid}
                    title={t.grid}
                    aria-label={t.grid}
                    className={`${btn} ${showGrid ? btnOn : ''}`}
                  >
                    <Grid3x3 className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setWireframe((v) => !v)}
                    data-viewer="wireframe"
                    aria-pressed={wireframe}
                    title={t.wireframe}
                    aria-label={t.wireframe}
                    className={`${btn} ${wireframe ? btnOn : ''}`}
                  >
                    <Component className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => viewerRef.current?.resetCamera()}
                    data-viewer="reset"
                    title={t.reset}
                    aria-label={t.reset}
                    className={btn}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Bottom: the measurements, and the gesture hint. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
            {(noPreview || noWebgl || arError) && (
              <p className="pointer-events-auto mx-auto mb-2 max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-[13px] text-amber-200">
                {arError ? t.arFailed : noWebgl ? t.noWebgl : t.noPreview}
              </p>
            )}

            <div className="flex items-end justify-between gap-3">
              <dl
                data-viewer="info"
                className="pointer-events-auto w-full max-w-[17rem] rounded-2xl border border-white/10 bg-zinc-950/70 p-3 text-[13px] backdrop-blur-md"
              >
                <div className="flex items-center gap-2 py-1">
                  <Ruler className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.dims}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="dimensions">
                    {dims ? `${dec(dims.x, 1)} × ${dec(dims.y, 1)} × ${dec(dims.z, 1)} ${t.mm}` : '—'}
                  </dd>
                </div>
                <div className="flex items-center gap-2 py-1">
                  <Cuboid className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.volume}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="volume">
                    {meta?.volume_mm3 != null ? `${dec(meta.volume_mm3 / 1000, 1)} ${t.cm3}` : '—'}
                  </dd>
                </div>
                <div className="flex items-center gap-2 py-1">
                  <Triangle className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.triangles}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="triangles">
                    {triangles != null ? int(triangles) : '—'}
                  </dd>
                </div>
                <div className="flex items-center gap-2 py-1">
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <dt className="shrink-0 text-zinc-400">{t.parts}</dt>
                  <dd className="ms-auto font-bold" dir="ltr" data-viewer-field="parts">
                    {meta?.shell_count != null ? int(meta.shell_count) : '—'}
                  </dd>
                </div>
              </dl>

              {showCanvas && ready && !arActive && (
                <p className="hidden shrink-0 items-center gap-1.5 pb-1 text-[12px] text-zinc-500 sm:flex">
                  <Rotate3d className="h-3.5 w-3.5" aria-hidden />
                  {t.hint}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
