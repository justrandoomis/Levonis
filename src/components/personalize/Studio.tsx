/**
 * THE STUDIO — Choose → Personalize → Preview (the owner's brief, Part 1;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.1–§B.2, §A C1.2–C1.46; survey S1–S3).
 * Compact on top, the engine underneath: the stage (the look card at once,
 * the live model cross-fading in when it is ready), one line saying whether
 * it is ready to print, the row the engine compiled (≤ 4 tiles + the door),
 * the open tile's panel, the price.
 *
 * C1 SHIPS DARK: the studio is mounted only by the merchant builder's preview
 * (`preview`, lane L9) and by tests/browser/personalize.html; C3 adds the
 * storefront door and the cart. It is a lazy chunk (`Personalize`), never in
 * a first-paint closure; the live model (./LiveModel.tsx over src/lib/viewer),
 * the picture/QR/icon editors (./extras.tsx), the More sheet, the icon set
 * and the taste functions are each loaded after it, when needed.
 *
 * THE STAGE: the look card paints first (./SceneFallback.tsx); the live model
 * mounts when the mesh arrives and fades in on `data-studio="ready"`.
 * `?gl=off`, `?dstream=off`, Save-Data, no WebGL, a lost context or a browser
 * that cannot inflate the mesh keep the look card — with «Show the live
 * preview» where that can help (Save-Data, a lost context). The stage is
 * `role=img` with a sentence of the colours and texts; a tap on the model
 * picks triangle → part → region and opens that region's editor, and every
 * such tap has its twin in the Look panel's rows.
 *
 * Hooks for probes: data-studio (loading | card | ready | fallback),
 * data-control, data-verdict, data-door, data-region (the stage: the last
 * region tapped; Look's rows: theirs), data-sheet, data-more-row,
 * data-fit-lines, data-colors, data-config-hash, data-price-iqd, data-spin
 * (on the live model, ./LiveModel.tsx).
 */
import React, { lazy, Suspense, use, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Motion from 'motion/react-m';
import { MoreHorizontal, Star, X } from 'lucide-react';
import type { DesignConfig, MorePage, PaletteKey, PublicBlueprint, SurfaceItem, TileId } from '../../../packages/catalog/src/personalize/types';
import { REGION_ROLES, ROLE_WORDS, colorWord, word } from '../../../packages/catalog/src/personalize/vocab';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { MotionFeatures } from '../../lib/motionFeatures';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { toast } from '../../lib/toastStore';
import { IconButton } from '../ui/Button';
import { Anchored } from '../ui/Overlay';
import { Skeleton } from '../ui/Skeleton';
import { fill, studioLang, studioWords } from './strings';
import { colorsAttr, configHash, paintRows, rgbOf, studioMode, useStudio, type Kit } from './useStudio';
import { useTaste, loadTaste } from './taste';
import { ControlRow, tileKey, type DoorKind } from './ControlRow';
import { PriceLine } from './PriceLine';
import { ReadyLine, readyLine, sizeName, type LineAction, type OpenTarget } from './ReadyLine';
import { NamePanel } from './NamePanel';
import { Dot, LookPanel, tasteCtx } from './LookPanel';
import { SizePanel } from './SizePanel';
import { AddonsPage } from './pages';
import { SceneFallback } from './SceneFallback';
import { areaArts, drawArt } from './art';
import type { LiveOff } from './LiveModel';
import type { Rgb255 } from './lookcard';

const MoreSheet = lazy(() => import('./MoreSheet'));
const LiveModel = lazy(() => import('./LiveModel'));
const Extras = {
  ImagePage: lazy(() => import('./extras').then((x) => ({ default: x.ImagePage }))),
  TargetPage: lazy(() => import('./extras').then((x) => ({ default: x.TargetPage }))),
  IconPicker: lazy(() => import('./extras').then((x) => ({ default: x.IconPicker }))),
};

export interface StudioProps {
  /** The public blueprint: the live projection, or the builder's preview projection. */
  blueprint: PublicBlueprint;
  /** The merchant's own preview (the builder): nothing is sent, the door says so. */
  preview?: boolean;
  /** A read-only view (C3's twin): no editing, no door. */
  readOnly?: boolean;
  /** Where the live model comes from — the builder's draft mesh (its URL, or the bytes it holds); default `blueprint.mesh.url`. */
  mesh?: { url: string } | { bytes: ArrayBuffer } | null;
  /** Choices to start from (a saved design, a builder's sample); carried over choice by choice. */
  initial?: DesignConfig | null;
  /** Whether the community is open and the store takes requests (the door's «Request printing»). */
  community?: { open?: boolean; takes_requests?: boolean };
  /** The door: add to cart, request printing, or ask the shop — with what will be made. */
  onDoor?: (kind: DoorKind, config: DesignConfig) => unknown;
  /** Every change: what will be made, its verdict and unit. */
  onChange?: (config: DesignConfig, out: { verdict: string; unit_iqd: number | null }) => void;
  onClose?: () => void;
  className?: string;
}

type Off = LiveOff | 'savedata' | 'nomesh';

/** Why the live model starts off, before anything is fetched. */
function offAtStart(pub: PublicBlueprint, mesh: StudioProps['mesh']): Off | null {
  if (!(mesh ?? pub.mesh)) return 'nomesh';
  const q = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  if (q.get('gl') === 'off') return 'gl';
  if (q.get('dstream') === 'off') return 'dstream';
  const conn = typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: { saveData?: boolean } }).connection : undefined;
  return conn?.saveData ? 'savedata' : null;
}

/** 52 % of the visible height on a phone (the stage), live with the keyboard and rotation. */
function useStageHeight(): number {
  const read = () => Math.round(((typeof window === 'undefined' ? 740 : window.visualViewport?.height ?? window.innerHeight) || 740) * 0.52);
  const [h, setH] = useState(read);
  useEffect(() => {
    const on = () => setH(read());
    const vv = window.visualViewport;
    (vv ?? window).addEventListener('resize', on);
    return () => (vv ?? window).removeEventListener('resize', on);
  }, []);
  return h;
}

export default function Studio(props: StudioProps) {
  const pub = props.blueprint;
  const { lang: l } = useLanguage();
  const lang = studioLang(l);
  // The words on the screen: their own chunk, loaded once (the first render waits for it under the caller's Suspense).
  const t = use(studioWords(lang));
  const m = useMotion();
  const mode = studioMode(props);
  const { open: cOpen, takes_requests: cTakes } = props.community ?? {};
  const community = useMemo(() => ({ open: cOpen, takes_requests: cTakes }), [cOpen, cTakes]);
  const { state, derived, dispatch } = useStudio(pub, props.initial, community);
  const k: Kit = { pub, state, derived, dispatch, lang, t, mode };
  const taste = useTaste();
  const wide = useMediaQuery('(min-width: 1024px)');
  const stageH = useStageHeight();
  const uid = useId();
  const lineId = `${uid}-line`;
  const panelId = `${uid}-panel`;
  const { plan, made } = derived;

  // ---------------------------------------------------------------- tiles
  const firstTile = plan.tiles.find((x) => x.id !== 'more');
  const [active, setActive] = useState<string | null>(firstTile ? tileKey(firstTile) : null);
  const activeTile = plan.tiles.find((x) => tileKey(x) === active && x.id !== 'more') ?? firstTile ?? null;
  const [more, setMore] = useState<{ open: boolean; start: SurfaceItem<MorePage> | null; n: number } | null>(null);
  const openMore = useCallback((start: SurfaceItem<MorePage> | null) => setMore((x) => ({ open: true, start, n: (x?.n ?? 0) + 1 })), []);
  const closeMore = useCallback(() => setMore((x) => (x ? { ...x, open: false } : x)), []);
  const [focusRegion, setFocusRegion] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fixRef = useRef<HTMLButtonElement>(null);

  /** Opens the editor an issue (or a tap on the model) points at: its tile, else its More page. */
  const openTarget = useCallback(
    (target: OpenTarget) => {
      const same = (id: string) => id === target.id || (target.id === 'text' && id === 'name');
      const tile =
        plan.tiles.find((x) => x.id !== 'more' && same(x.id) && (!target.ref || x.ref === target.ref)) ??
        (target.ref && plan.name_icons.includes(target.ref) ? plan.tiles.find((x) => x.id === 'name') : undefined);
      if (tile) {
        setActive(tileKey(tile));
        requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('input, textarea, [role=radio], button')?.focus({ preventScroll: false }));
        return;
      }
      const page = plan.more.find((p) => same(p.id) && (!target.ref || p.ref === target.ref)) ?? null;
      if (page) openMore(page);
    },
    [plan, openMore]
  );

  // ---------------------------------------------------------------- colours and artwork
  const rgb = useCallback((key: PaletteKey) => rgbOf(pub, made, key), [pub, made]);
  const colours = useMemo<Rgb255[]>(() => pub.regions.map((r) => rgb(made.colors[r.id] ?? r.paint.default)), [pub, made, rgb]);
  const [arts, setArts] = useState<Record<string, HTMLCanvasElement | null>>({});
  const artSig = useRef<Record<string, string>>({});
  useEffect(() => {
    const now = new Map(areaArts(pub, made, derived.fits, state.assets, rgb).map((x) => [x.id, x]));
    for (const a of pub.areas) {
      const art = now.get(a.id);
      const sig = art ? `${art.frame.w}x${art.frame.h}|${art.sig}` : '';
      if (artSig.current[a.id] === sig) continue;
      artSig.current[a.id] = sig;
      if (!art) {
        setArts((prev) => (prev[a.id] ? { ...prev, [a.id]: null } : prev));
        continue;
      }
      void art
        .make()
        .then((spec) => drawArt(art.frame, spec))
        // A newer drawing of the same area wins; this one is dropped.
        .then((canvas) => {
          if (artSig.current[a.id] === sig) setArts((prev) => ({ ...prev, [a.id]: canvas }));
        })
        .catch(() => undefined);
    }
  }, [pub, made, derived.fits, state.assets, rgb]);

  // ---------------------------------------------------------------- the stage
  const [off, setOff] = useState<Off | null>(() => offAtStart(pub, props.mesh));
  const [ready, setReady] = useState(false);
  const [card, setCard] = useState<'wait' | 'shown' | 'none'>('wait');
  const onPainted = useCallback((ok: boolean) => setCard(ok ? 'shown' : 'none'), []);
  const onLiveReady = useCallback(() => setReady(true), []);
  const onLiveOff = useCallback((why: LiveOff) => {
    setReady(false);
    setOff(why);
  }, []);
  const [picked, setPicked] = useState('');
  const source = props.mesh ?? (pub.mesh ? { url: pub.mesh.url } : null);
  const sourceKey = source ? ('url' in source ? source.url : source.bytes) : null;
  // A new mesh (the builder's next draft) shows the look card until it is ready.
  useEffect(() => setReady(false), [sourceKey]);

  /** A tap on the model: a name plate opens the name; any other part opens its colours in Look. */
  const onPick = (regionId: string) => {
    setPicked(regionId);
    const area = pub.areas.find((a) => a.region === regionId && a.kind === 'text' && [...plan.tiles, ...plan.more].some((x) => x.ref === a.id));
    if (area && area.role === 'name') openTarget({ id: 'text', ref: area.id });
    else if (plan.tiles.some((x) => x.id === 'look')) {
      setActive('look');
      setFocusRegion(null);
      requestAnimationFrame(() => setFocusRegion(regionId));
    } else if (area) openTarget({ id: 'text', ref: area.id });
  };

  // The picture, QR and icon editors load once the product has such an area.
  const needsExtras = pub.areas.some((a) => a.kind !== 'text') || !!pub.extras.nfc;
  useEffect(() => {
    if (needsExtras) void import('./extras').catch(() => undefined);
  }, [needsExtras]);

  // ---------------------------------------------------------------- the line, the door
  const better = useMemo(
    () => (taste && state.changed && (derived.check.verdict === 'ready' || derived.check.verdict === 'adjusted') ? taste.makeItBetter(pub, state.config, tasteCtx(pub)) : null),
    [taste, state.changed, state.config, derived.check.verdict, pub]
  );
  const said = state.applied?.startsWith('better:') ? t.betterSay[state.applied.slice(7) as keyof typeof t.betterSay] : null;
  const line = readyLine(pub, made, derived.check.verdict, derived.check.issues, derived.blocking, t, lang, {
    undo: !!state.applied,
    better: better ? t.better : null,
    said,
  });
  const onLine = (a: LineAction) => {
    if (a.kind === 'apply') dispatch({ type: 'apply', config: a.config, why: 'fix' });
    else if (a.kind === 'open') openTarget(a.target);
    else if (a.kind === 'undo') dispatch({ type: 'undo' });
    else if (better) dispatch({ type: 'apply', config: better.config, why: `better:${better.code}` });
  };
  const doorWould: DoorKind = pub.sell.cart ? 'add_to_cart' : community.open && community.takes_requests ? 'request' : 'ask';
  const [doorBusy, setDoorBusy] = useState(false);
  const act = async (kind: DoorKind) => {
    if (props.onDoor) {
      setDoorBusy(true);
      try {
        await props.onDoor(kind, made);
      } finally {
        setDoorBusy(false);
      }
    } else if (mode === 'preview') toast.info(t.doorPreview);
  };
  const onDoor = () => {
    if (mode === 'view' || doorBusy) return;
    if (plan.door.kind !== 'disabled') return void act(plan.door.kind);
    // Blocked: bring the customer to what is missing — its editor, or the one-tap fix.
    if (line.action?.kind === 'open') openTarget(line.action.target);
    else fixRef.current?.focus();
  };
  const onSurprise = async () => {
    const tt = taste ?? (await loadTaste().catch(() => null));
    if (!tt) return;
    dispatch({ type: 'apply', config: tt.surpriseMe(pub, { config: state.config, ...tasteCtx(pub) }, state.seeds.surprise), why: 'surprise', seed: 'surprise' });
    closeMore();
  };

  // ---------------------------------------------------------------- reporting
  const { onChange } = props;
  useEffect(() => {
    onChange?.(made, { verdict: derived.check.verdict, unit_iqd: derived.unit });
  }, [onChange, made, derived.check.verdict, derived.unit]);
  const [hash, setHash] = useState('');
  useEffect(() => {
    let live = true;
    void configHash(made).then(
      (h) => live && setHash(h),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [made]);

  // ---------------------------------------------------------------- words
  const roleWord = (id: string) => {
    const r = pub.regions.find((x) => x.id === id);
    if (!r) return fill(t.colourOf, { name: pub.areas.find((a) => a.id === id)?.role === 'name' ? t.tiles.name : t.tiles.text });
    return r.role === 'name' || r.role === 'text' ? t.plate[r.role] : word(ROLE_WORDS, REGION_ROLES, r.role, lang);
  };
  const sentence = [
    fill(t.stageLabel, { product: pub.product.name }),
    ...paintRows(pub, made).map((r) => fill(t.partColour, { part: roleWord(r.id), colour: colorWord(made.colors[r.id], lang) })),
    ...pub.areas
      .filter((a) => made.texts[a.id]?.value.length)
      .map((a) => fill(t.textOn, { label: a.role === 'name' ? t.tiles.name : t.tiles.text, text: made.texts[a.id].value.join(' + ') })),
  ].join(lang === 'en' ? ', ' : '، ');

  const hint = (text: string) => <span className="truncate font-normal text-text-muted">{text}</span>;
  const tileValue = (tile: SurfaceItem<TileId>): React.ReactNode => {
    const ref = tile.ref ?? '';
    switch (tile.id) {
      case 'name':
      case 'text': {
        const v = made.texts[ref]?.value;
        return v?.length ? (
          <bdi dir="auto" className="truncate">
            {v.join(' + ')}
          </bdi>
        ) : (
          hint(pub.areas.find((a) => a.id === ref)?.text?.sample[lang] ?? t.add)
        );
      }
      // The kind's own words (the icon's, the target's) load with their editor, after first paint.
      case 'photo':
      case 'logo':
      case 'qr':
      case 'icon':
        return state.config[tile.id][ref] ? t.added : hint(t.add);
      case 'look':
        return (
          <span className="flex gap-0.5" aria-label={paintRows(pub, made).map((r) => colorWord(made.colors[r.id], lang)).join(lang === 'en' ? ', ' : '، ')}>
            {paintRows(pub, made)
              .slice(0, 4)
              .map((r) => (
                <Dot key={r.id} rgb={rgbOf(pub, made, made.colors[r.id])} size={14} />
              ))}
          </span>
        );
      case 'size': {
        const v = pub.variants.find((x) => x.id === made.variant)?.values[pub.axes.size?.group ?? ''];
        // The ★ sits in the tile's corner, so a long size word («ماماناوەند») keeps the whole line.
        return (
          <>
            <span className="truncate">{sizeName(pub, made, v, t)}</span>
            {v && pub.axes.size?.values[v]?.recommended ? <Star aria-label={t.recommended} className="absolute end-1 top-1 h-3 w-3 fill-current text-gold" /> : null}
          </>
        );
      }
      case 'addons': {
        const n = pub.slots.filter((s) => s.choice === 'customer' && state.config.slots[s.id]?.option).length;
        return n ? String(n) : hint(t.add);
      }
      case 'more':
        return hint(String(plan.more.length));
    }
  };

  const later = (node: React.ReactNode) => (
    <Suspense
      fallback={
        <div className="space-y-2 px-3 py-3">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-2/3" />
        </div>
      }
    >
      {node}
    </Suspense>
  );
  const panel = (tile: SurfaceItem<TileId> | null) => {
    if (!tile) return null;
    switch (tile.id) {
      case 'name':
      case 'text':
        return <NamePanel k={k} areaId={tile.ref!} icons={tile.id === 'name' ? plan.name_icons : []} />;
      case 'look':
        return <LookPanel k={k} taste={taste} focus={focusRegion} />;
      case 'size':
        return <SizePanel k={k} />;
      case 'photo':
      case 'logo':
        return later(<Extras.ImagePage k={k} areaId={tile.ref!} />);
      case 'qr':
        return later(<Extras.TargetPage k={k} areaId={tile.ref!} />);
      case 'addons':
        return <AddonsPage k={k} />;
      case 'icon':
        return later(
          <div className="px-3 py-3">
            <Extras.IconPicker k={k} areaId={tile.ref!} />
          </div>
        );
      default:
        return null;
    }
  };

  // ---------------------------------------------------------------- the ⋯ menu
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const menuItem = 'flex min-h-11 w-full items-center px-4 text-start text-[14px] text-text-primary disabled:opacity-45';

  const studioState = ready ? 'ready' : off ? 'fallback' : card === 'shown' ? 'card' : 'loading';
  const offWords = off === 'savedata' ? t.saveData : off && off !== 'nomesh' ? t.noLive : null;
  const canRetry = off === 'savedata' || off === 'lost';

  return (
    <section
      className={`flex h-full min-h-0 flex-col bg-canvas text-text-primary ${props.className ?? ''}`}
      data-studio={studioState}
      data-colors={colorsAttr(made)}
      data-config-hash={hash}
      data-derive-ms={derived.ms.toFixed(2)}
      aria-label={pub.product.name}
    >
      <header className="flex shrink-0 items-center gap-1 px-1.5 py-1">
        {props.onClose ? <IconButton label={t.close} icon={<X className="h-5 w-5" />} onClick={props.onClose} /> : <span className="w-2" />}
        {/* The name keeps its own direction and the header's alignment (an English name beside the close button in Arabic). */}
        <h1 className="min-w-0 flex-1 truncate px-1 text-start text-[16px] font-bold text-text-primary">
          <bdi>{pub.product.name}</bdi>
        </h1>
        {mode === 'preview' && (
          <span title={t.previewChip} className="shrink-0 rounded-full border border-border-subtle px-2.5 py-0.5 text-[11.5px] font-medium text-text-muted">
            {t.preview}
          </span>
        )}
        {mode !== 'view' && (
          <IconButton ref={menuAnchor} label={t.options} icon={<MoreHorizontal className="h-5 w-5" />} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(true)} />
        )}
        <Anchored open={menu} onClose={() => setMenu(false)} anchor={menuAnchor} label={t.options} align="end">
          <div className="min-w-[180px] py-1">
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              disabled={!state.undo.length}
              onClick={() => {
                setMenu(false);
                dispatch({ type: 'undo' });
              }}
            >
              {t.undo}
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setMenu(false);
                dispatch({ type: 'reset' });
              }}
            >
              {t.startOver}
            </button>
          </div>
        </Anchored>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 shrink-0 flex-col lg:flex-1" style={wide ? undefined : { height: stageH }}>
          <div className="relative min-h-0 flex-1 overflow-hidden" data-region={picked}>
            <div role="img" aria-label={sentence} className="absolute inset-0">
              <MotionFeatures>
                {/* The look card; the live model fades in over it as the card fades out. */}
                <Motion.div className="absolute inset-0" initial={false} animate={{ opacity: ready ? 0 : 1 }} transition={m.spring('ui')}>
                  <SceneFallback pub={pub} made={made} colours={colours} arts={arts} onPainted={onPainted} paused={ready} />
                </Motion.div>
              </MotionFeatures>
            </div>
            {!off && source && (
              <Suspense fallback={null}>
                <LiveModel
                  pub={pub}
                  made={made}
                  arts={arts}
                  rgb={rgb}
                  source={source}
                  ready={ready}
                  onReady={onLiveReady}
                  onOff={onLiveOff}
                  onPick={onPick}
                  resetLabel={t.resetView}
                />
              </Suspense>
            )}
            {offWords && (
              <div className="absolute inset-x-3 top-2 flex flex-wrap items-center gap-2 text-[12.5px] leading-relaxed text-text-secondary">
                <p className="min-w-0 flex-1">{offWords}</p>
                {canRetry && (
                  <button type="button" className="lv-button lv-button-secondary lv-button-sm" onClick={() => setOff(null)} data-show-live>
                    {t.showLive}
                  </button>
                )}
              </div>
            )}
            {card === 'wait' && !ready && !off && (
              <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[13px] text-text-muted" role="status">
                {t.loading}
              </p>
            )}
          </div>
          <div className="shrink-0 px-3 pb-1 lg:pb-3">
            <ReadyLine line={line} verdict={derived.check.verdict} onAction={onLine} actionRef={fixRef} id={lineId} />
          </div>
        </div>

        <aside className="flex min-h-0 flex-1 flex-col lg:flex-none lg:border-s lg:border-border-subtle" style={wide ? { width: 380 } : undefined} aria-label={t.controls}>
          <ControlRow
            plan={plan}
            active={activeTile ? tileKey(activeTile) : null}
            onTile={(tile) => (tile.id === 'more' ? openMore(null) : setActive(tileKey(tile)))}
            value={tileValue}
            doorWould={doorWould}
            onDoor={onDoor}
            doorBusy={doorBusy}
            describedBy={lineId}
            t={t}
            panelId={panelId}
            readOnly={mode === 'view'}
            price={<PriceLine unit={derived.unit} label={t.price} />}
          >
            <MotionFeatures>
              <Motion.div
                ref={panelRef}
                key={activeTile ? tileKey(activeTile) : 'none'}
                initial={{ opacity: 0, y: m.travel(8) }}
                animate={{ opacity: 1, y: 0 }}
                transition={m.spring('ui')}
                inert={mode === 'view' ? true : undefined}
              >
                {panel(activeTile)}
              </Motion.div>
            </MotionFeatures>
          </ControlRow>
        </aside>
      </div>

      {more && (
        <Suspense fallback={null}>
          <MoreSheet
            key={more.n}
            k={k}
            open={more.open}
            start={more.start}
            onClose={closeMore}
            onAsk={() => {
              closeMore();
              void act('ask');
            }}
            onSurprise={() => void onSurprise()}
          />
        </Suspense>
      )}
    </section>
  );
}

export type { PublicBlueprint, DesignConfig };
