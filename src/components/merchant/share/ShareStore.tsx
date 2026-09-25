/**
 * «شارك متجرك» — THE STORE'S LINK, READY TO HAND ON.
 *
 * A self-contained panel (it loads its own data) that the wave-3 Merchant
 * Workspace can mount unchanged. Today it sits in the dashboard's store
 * settings and, for the store's OWNER, behind the storefront's «…» menu.
 *
 * WHAT IT OFFERS, and every one of them works end to end:
 *   · the link — copied with one tap, or selected for copying by hand when
 *     the clipboard is refused;
 *   · the system share sheet — shown ONLY where the browser has one;
 *   · a QR code — the repository's own encoder (worker/lib/qr.ts), on its own
 *     white ground so it scans, and downloadable as a PNG for printing;
 *   · a preview of the card the link unfurls as — the SAME card the Worker
 *     writes into the document a chat app's crawler reads, not a guess at it;
 *   · the app a customer installs — the store's own icon once it is cut, and
 *     an honest line when it is not (worker/lib/storeIcons.ts).
 *
 * HIERARCHY, per the house design rules (.claude/skills/apple-design): the
 * link and its copy action lead; the preview and the QR support; the app
 * icon is last and quiet. One accent at most, compact controls with 44 px
 * targets, the address an LTR island in an RTL page.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, Copy, Download, QrCode, Share2, Store as StoreGlyph } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import Note from '../../ui/Note';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { shareStoreApi, type StoreShareCard, type StoreShareKit } from './shareStoreApi';
import {
  ICON_POLL_MS,
  QR_QUIET_ZONE,
  canShareNatively,
  displayAddress,
  isShareAbort,
  qrFileName,
  qrPngGeometry,
  shouldPollIcon,
  storeQr,
  type StoreQr,
} from './shareStoreModel';
import { iconStateLine, shareStrings, type ShareStrings } from './strings';

export interface ShareStoreProps {
  /** A kit the caller already holds (the storefront menu fetched one to know the viewer owns the store). */
  initialKit?: StoreShareKit | null;
  /** `card`: its own surface and heading, for a settings page. `plain`: content only, inside a window with its own title. */
  variant?: 'card' | 'plain';
  /** Show the QR code on arrival — where showing it is the reason the panel was opened. */
  qrOpen?: boolean;
}

export default function ShareStore({ initialKit = null, variant = 'card', qrOpen = false }: ShareStoreProps) {
  const { loc } = useLanguage();
  const s = shareStrings(loc);
  const titleId = useId();
  const [kit, setKit] = useState<StoreShareKit | null>(initialKit);
  const [failed, setFailed] = useState(false);
  const [polls, setPolls] = useState(0);

  const load = useCallback(async () => {
    try {
      setKit(await shareStoreApi.kit());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!initialKit) void load();
  }, [initialKit, load]);

  // The icon is cut after the request that noticed it was missing; ask again
  // a few times, then stop — the line already says it is on its way.
  useEffect(() => {
    if (!kit || !shouldPollIcon(kit.app_icon.state, polls)) return;
    const timer = window.setTimeout(() => {
      setPolls((n) => n + 1);
      void load();
    }, ICON_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [kit, polls, load]);

  const body = kit ? (
    <ShareBody kit={kit} s={s} qrOpen={qrOpen} />
  ) : failed ? (
    <div className="py-4 text-center" role="alert">
      <p className="text-zinc-400 text-[12.5px]">{s.loadFailed}</p>
      <button type="button" onClick={() => void load()} className="lv-button lv-button-secondary lv-button-sm mt-3">
        {s.retry}
      </button>
    </div>
  ) : (
    <ShareSkeleton label={s.loading} />
  );

  if (variant === 'plain') return body;
  return (
    <section aria-labelledby={titleId} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
      <h3 id={titleId} className="text-gold font-bold text-[12.5px] mb-1 text-balance">
        {s.title}
      </h3>
      <p className="text-zinc-400 text-[12px] leading-relaxed mb-3">{s.intro}</p>
      {body}
    </section>
  );
}

// ------------------------------------------------------------------ the body

function ShareBody({ kit, s, qrOpen }: { kit: StoreShareKit; s: ShareStrings; qrOpen: boolean }) {
  const { loc } = useLanguage();
  const m = useMotion();
  const qrId = useId();
  const statusId = useId();
  const addressRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [showQr, setShowQr] = useState(qrOpen);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const qr = useMemo(() => storeQr(kit.url), [kit.url]);
  const nativeShare = typeof navigator !== 'undefined' && canShareNatively(navigator, kit.url);
  const address = displayAddress(kit);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(kit.url);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure context, a refusing webview): select the
      // address so the person can copy it with the system's own gesture.
      const el = addressRef.current;
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      if (el && selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyFailed(true);
    }
  }, [kit.url]);

  const share = useCallback(async () => {
    try {
      await navigator.share({ title: kit.card?.title || kit.app_icon.name, url: kit.url });
    } catch (error) {
      // Closing the sheet is a choice, not a failure; anything else falls
      // back to the one action that always exists.
      if (!isShareAbort(error)) void copy();
    }
  }, [kit, copy]);

  const download = useCallback(() => {
    setDownloadFailed(false);
    if (!qr || !downloadQrPng(qr, qrFileName(kit.host, kit.url))) setDownloadFailed(true);
  }, [qr, kit.host, kit.url]);

  return (
    <div className="@container space-y-4">
      {kit.suspended && (
        <Note tone="amber" compact animate={false} icon={<AlertTriangle className="w-4 h-4" strokeWidth={2} />}>
          {s.suspended}
        </Note>
      )}

      {kit.card && <LinkPreview card={kit.card} address={address} caption={s.previewCaption} note={s.previewNote} />}

      {/* The link, and the action that matters most. */}
      <div>
        <p className="text-zinc-400 text-[12px] font-semibold mb-1.5">{s.linkLabel}</p>
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1 flex items-center rounded-xl border border-white/10 bg-black/40 px-3 min-h-[44px]">
            <span
              ref={addressRef}
              dir="ltr"
              translate="no"
              className="block min-w-0 truncate select-all text-[13px] text-zinc-100 tabular-nums"
            >
              {address}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            aria-describedby={statusId}
            className="lv-button lv-button-primary lv-button-sm shrink-0"
          >
            {copied ? (
              <Check className="w-4 h-4 shrink-0" strokeWidth={2.5} aria-hidden />
            ) : (
              <Copy className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />
            )}
            {copied ? s.copied : s.copy}
          </button>
        </div>
        <p id={statusId} role="status" aria-live="polite" className={copyFailed ? 'mt-1.5 text-[11.5px] leading-relaxed text-amber-200/90' : 'sr-only'}>
          {copyFailed ? s.copyFailed : copied ? s.copied : ''}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {nativeShare && (
          <button type="button" onClick={() => void share()} className="lv-button lv-button-secondary lv-button-sm">
            <Share2 className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />
            {s.share}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowQr((v) => !v)}
          aria-expanded={showQr}
          aria-controls={qrId}
          className="lv-button lv-button-secondary lv-button-sm"
        >
          <QrCode className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />
          {showQr ? s.qrHide : s.qrShow}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {showQr && (
          <motion.div
            id={qrId}
            key="qr"
            initial={{ opacity: 0, y: m.travel(-6) }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.travel(-6) }}
            transition={m.spring('quick')}
          >
            {qr ? (
              <div className="flex flex-col items-center gap-3 @md:flex-row @md:items-start">
                {/* The modules stay true black on true white in every theme, or a
                    camera cannot read them — the one surface here with its own ground. */}
                <div className="shrink-0 rounded-xl bg-snow p-2.5" role="img" aria-label={`${s.qrAlt}: ${address}`}>
                  <svg
                    viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`}
                    className="block w-[168px] h-[168px]"
                    shapeRendering="crispEdges"
                    aria-hidden="true"
                  >
                    <rect width={qr.viewBox} height={qr.viewBox} fill="#ffffff" />
                    <path d={qr.path} fill="#000000" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1 text-center @md:text-start">
                  <p className="text-zinc-400 text-[12px] leading-relaxed">{s.qrHint}</p>
                  <button type="button" onClick={download} className="lv-button lv-button-ghost lv-button-sm mt-2 hover:text-zinc-100">
                    <Download className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />
                    {s.qrDownload}
                  </button>
                  {downloadFailed && (
                    <p role="status" className="text-amber-200/90 text-[11.5px] mt-1">
                      {s.qrDownloadFailed}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-zinc-400 text-[12px]" role="status">
                {s.qrUnavailable}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AppIconRow kit={kit} title={s.appTitle} lead={s.appLead} line={iconStateLine(loc, kit.app_icon.state, kit.app_icon.reason)} />
    </div>
  );
}

/**
 * The card as a chat app shows it: the square picture at the start, then the
 * title, the line and the address. Built from the server's card — the same
 * one the crawler reads — so what the merchant sees here is what their
 * customer will see.
 */
function LinkPreview({ card, address, caption, note }: { card: StoreShareCard; address: string; caption: string; note: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <figure>
      <div className="flex items-stretch gap-3 rounded-xl border border-white/10 bg-black/30 p-2.5">
        <div className="w-16 h-16 shrink-0 overflow-hidden rounded-lg bg-black flex items-center justify-center">
          {card.image && !broken ? (
            <img
              src={card.image}
              alt=""
              width={64}
              height={64}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setBroken(true)}
            />
          ) : (
            <StoreGlyph className="w-6 h-6 text-zinc-500" strokeWidth={1.5} aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1 py-0.5">
          <p className="truncate text-[13px] font-bold leading-snug text-zinc-100" dir="auto">
            {card.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-zinc-400" dir="auto">
            {card.description}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">
            <span dir="ltr" translate="no">
              {address}
            </span>
          </p>
        </div>
      </div>
      <figcaption className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        {caption}. {note}
      </figcaption>
    </figure>
  );
}

/** The installed app: the icon iOS will draw (its own rounded square), the label under it, and where it stands. */
function AppIconRow({ kit, title, lead, line }: { kit: StoreShareKit; title: string; lead: string; line: string }) {
  const { state, icon, short_name } = kit.app_icon;
  const [broken, setBroken] = useState(false);
  return (
    <div className="border-t border-white/[0.06] pt-3.5">
      <p className="text-zinc-300 text-[12.5px] font-semibold">{title}</p>
      <p className="text-zinc-500 text-[11.5px] leading-relaxed mb-2.5">{lead}</p>
      <div className="flex items-center gap-3">
        <div
          className="w-12 h-12 shrink-0 overflow-hidden rounded-[11px] border border-white/10 bg-black flex items-center justify-center"
          aria-hidden="true"
        >
          {state === 'ready' && icon && !broken ? (
            <img src={icon} alt="" width={48} height={48} className="w-full h-full" loading="lazy" onError={() => setBroken(true)} />
          ) : state === 'pending' ? (
            <Skeleton className="w-full h-full rounded-none" />
          ) : (
            <StoreGlyph className="w-5 h-5 text-zinc-500" strokeWidth={1.5} />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-zinc-100">
            <bdi>{short_name}</bdi>
          </p>
          <p className="text-[11.5px] leading-5 text-zinc-400" role="status" aria-live="polite">
            {line}
          </p>
        </div>
      </div>
    </div>
  );
}

function ShareSkeleton({ label }: { label: string }) {
  return (
    <SkeletonGroup label={label} className="space-y-3">
      <Skeleton className="h-[86px] w-full rounded-xl" />
      <div className="flex gap-2">
        <Skeleton className="h-11 flex-1 rounded-xl" />
        <Skeleton className="h-11 w-28 rounded-xl" />
      </div>
      <Skeleton className="h-11 w-40 rounded-xl" />
    </SkeletonGroup>
  );
}

/**
 * The code as a printable PNG: whole pixels per module on a white square,
 * quiet zone included, named after the store's address. Returns false where
 * the browser cannot draw or save it, so the panel can say so.
 */
function downloadQrPng(qr: StoreQr, fileName: string): boolean {
  try {
    const { scale, side } = qrPngGeometry(qr.matrix);
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = '#000000';
    const { modules, size } = qr.matrix;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) ctx.fillRect((x + QR_QUIET_ZONE) * scale, (y + QR_QUIET_ZONE) * scale, scale, scale);
      }
    }
    const href = canvas.toDataURL('image/png');
    if (!href.startsWith('data:image/png')) return false;
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  }
}
