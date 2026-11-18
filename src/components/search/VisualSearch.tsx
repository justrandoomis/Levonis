import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, ImagePlus, RotateCcw, ScanLine, Search, Sparkles, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, type ApiProduct } from '../../lib/api';
import { productMainImage } from '../../lib/productImage';
import { useTheme } from '../../lib/theme';
import { Overlay } from '../ui/Overlay';
import SafeImage from '../ui/SafeImage';
import { Skeleton } from '../ui/Skeleton';
import Spinner from '../ui/Spinner';
import CardPrice from '../CardPrice';
import AvailabilityLine from '../product/AvailabilityLine';
import type { ScanRead } from '../scanner/BarcodeScanner';
import { COLOUR_WORDS } from './searchKit';
import { linkWithSelection, type LinkSelection } from './resultLink';
/** The server refuses a longer `search` (worker/routes/products.ts); the same bound as ./LiveSearch.tsx. */
const SEARCH_MAX_LENGTH = 100;

const BarcodeScanner = React.lazy(() => import('../scanner/BarcodeScanner'));

/**
 * SEARCH BY SCAN AND BY PHOTO (owner, 2026-11-18: «add search about images and
 * scan … match the image with available options and color, smart and extra
 * and no mistake»).
 *
 * The camera button in the search field opens this window, with two ways in:
 *
 *   - SCAN: the shop's one camera scanner (../scanner/BarcodeScanner.tsx) in
 *     `accept="any"` mode. Any barcode or QR is taken: a link to this shop
 *     opens where it points; any other code goes into the field, where the
 *     identifier lane answers an EAN, a model code or a SKU exactly.
 *   - PHOTO: camera or gallery. Scaled here to 1024 px JPEG (a phone photo is
 *     4–12 MB; the request is ~150 KB) and sent to `POST /api/search/image`,
 *     which answers ONLY with the shop's own products — the model chooses from
 *     the candidates the shop's search found, never names one itself — and the
 *     colour or option the photo shows (worker/lib/search/imageSearch.ts).
 *
 * SAYING HOW SURE IT IS. The headline follows the server's verdict: «وجدناه»
 * only for `same`; `similar` says plainly these are the closest, not it; and
 * `none` says the shop does not have it, with the next step (another photo,
 * the words it read as a text search, or the support chat). Each row carries
 * its own label — «تطابق» / «مرجّح» / «مشابه» — and opens on the matched
 * colour (`?v=`, ./resultLink.ts), which the product page re-checks.
 *
 * Nothing about the photo is kept: it lives in this window's memory until the
 * window closes.
 */

type Confidence = 'high' | 'medium' | 'low';
interface ImageAnswer {
  verdict: 'same' | 'similar' | 'none';
  via: 'code' | 'photo';
  colour: string | null;
  query: string;
  products: ApiProduct[];
  confidence: Record<string, Confidence>;
  matched: Record<string, LinkSelection>;
}

type Step =
  | { kind: 'choose' }
  | { kind: 'scan' }
  | { kind: 'reading'; preview: string }
  | { kind: 'result'; preview: string; answer: ImageAnswer }
  | { kind: 'error'; preview: string | null; code: 'unavailable' | 'limit' | 'busy' | 'bad_photo' | 'failed' };

const MAX_EDGE = 1024;

/** Any picture the browser can open → a JPEG data URL at most `MAX_EDGE` on its long side. */
async function scaledPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode'));
      el.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const productHref = (p: ApiProduct): string => (p.product_slug ? `/bundles/${p.product_slug}` : `/product/${p.slug || p.id}`);

/** A scanned QR that is a link into this shop → its path; anything else → null. */
export function shopPathOf(text: string, origin: string): string | null {
  try {
    const u = new URL(text);
    const own = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== own.protocol) return null;
    if (u.host !== own.host && u.host !== 'levonis-iq.com' && u.host !== 'www.levonis-iq.com') return null;
    // «https://levonis-iq.com//evil.com» has the path «//evil.com», which a router reads as another
    // host: only a path with ONE leading slash, and only if it still resolves to this origin.
    if (!/^\/(?![/\\])/.test(u.pathname)) return null;
    const path = `${u.pathname}${u.search}${u.hash}`;
    return new URL(path, own.origin).origin === own.origin ? path : null;
  } catch {
    return null;
  }
}

/** What a scan puts in the field: the EAN, else the serial, else the first code read. */
export function scannedText(read: Pick<ScanRead, 'ean' | 'productSn' | 'raw'>): string {
  return (read.ean ?? read.productSn ?? read.raw[0]?.text ?? '').trim().slice(0, SEARCH_MAX_LENGTH);
}

export default function VisualSearch({
  open,
  onClose,
  anchor,
  onQuery,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  /** Put this text in the search field and open its panel. */
  onQuery: (text: string) => void;
}) {
  const { loc } = useLanguage();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const runRef = useRef(0);

  // Every opening starts at the choice; a closed window forgets the photo.
  useEffect(() => {
    if (open) setStep({ kind: 'choose' });
    else runRef.current++;
  }, [open]);

  const close = () => {
    runRef.current++;
    onClose();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const run = ++runRef.current;
    let preview: string;
    try {
      preview = await scaledPhoto(file);
    } catch {
      setStep({ kind: 'error', preview: null, code: 'bad_photo' });
      return;
    }
    setStep({ kind: 'reading', preview });
    try {
      const answer = await api.post<ImageAnswer>('/api/search/image', { image: preview }, { mascot: 'silent' });
      if (run !== runRef.current) return;
      setStep({ kind: 'result', preview, answer: { ...answer, products: answer.products ?? [], confidence: answer.confidence ?? {}, matched: answer.matched ?? {} } });
    } catch (err) {
      if (run !== runRef.current) return;
      const code = err instanceof ApiError ? err.code : '';
      const status = err instanceof ApiError ? err.status : 0;
      setStep({
        kind: 'error',
        preview,
        code:
          code === 'IMAGE_SEARCH_UNAVAILABLE'
            ? 'unavailable'
            : code === 'IMAGE_SEARCH_DAILY_LIMIT' || status === 429
              ? 'limit'
              : code === 'IMAGE_SEARCH_BUSY'
                ? 'busy'
                : code === 'INVALID_INPUT' || code === 'IMAGE_TOO_LARGE'
                  ? 'bad_photo'
                  : 'failed',
      });
    }
  };

  const onScanned = (read: ScanRead) => {
    const first = read.raw[0]?.text ?? '';
    const path = shopPathOf(first, window.location.origin);
    close();
    if (path) navigate(path);
    else {
      const text = scannedText(read);
      if (text) onQuery(text);
    }
  };

  const title =
    step.kind === 'scan'
      ? loc('امسح الباركود', 'Scan a barcode', 'بارکۆد بخوێنەرەوە')
      : loc('ابحث بالكاميرا', 'Search with your camera', 'بە کامێرا بگەڕێ');

  const photoInputs = (
    <>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onFile} />
      <input ref={galleryRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onFile} />
    </>
  );

  const bigButton = (icon: React.ReactNode, label: string, hint: string, onClick: () => void, testId: string) => (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-border-subtle bg-surface-raised px-4 text-start transition-colors hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-selected text-text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-text-primary">{label}</span>
        <span className="block text-[12.5px] leading-snug text-text-secondary">{hint}</span>
      </span>
    </button>
  );

  const retryPhoto = () => cameraRef.current?.click();
  /** The customer's own photo, a data URL held in this window's memory. */
  const previewSrc = step.kind === 'reading' || step.kind === 'result' || step.kind === 'error' ? step.preview : null;

  return (
    <Overlay
      open={open}
      onClose={close}
      labelledBy="visual-search-title"
      anchor={anchor}
      solid={step.kind === 'scan'}
      z={60}
      testId="visual-search"
      panelClassName="w-full max-w-md bg-surface-raised border border-border-subtle overflow-y-auto"
    >
      {photoInputs}
      {step.kind !== 'scan' && (
        <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
          <h2 id="visual-search-title" className="text-[16px] font-bold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={loc('إغلاق', 'Close', 'داخستن')}
            className="flex size-11 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
      )}

      {step.kind === 'choose' && (
        <div className="space-y-2.5 px-4 pb-5 pt-1">
          {bigButton(
            <ScanLine className="size-5" aria-hidden="true" />,
            loc('امسح الباركود', 'Scan a barcode', 'بارکۆد بخوێنەرەوە'),
            loc('باركود العلبة أو رمز QR — يفتح المنتج مباشرة', 'The box barcode or a QR code — opens the product directly', 'بارکۆدی قوتووەکە یان QR — ڕاستەوخۆ بەرهەمەکە دەکاتەوە'),
            () => setStep({ kind: 'scan' }),
            'visual-search-scan'
          )}
          {bigButton(
            <Camera className="size-5" aria-hidden="true" />,
            loc('صوّر المنتج', 'Take a photo', 'وێنەی بەرهەمەکە بگرە'),
            loc('نتعرّف عليه ونجد نفس المنتج ولونه في المتجر', 'We recognise it and find the same product and colour in the shop', 'دەیناسینەوە و هەمان بەرهەم و ڕەنگەکەی لە فرۆشگا دەدۆزینەوە'),
            () => cameraRef.current?.click(),
            'visual-search-camera'
          )}
          {bigButton(
            <ImagePlus className="size-5" aria-hidden="true" />,
            loc('اختر صورة', 'Choose a picture', 'وێنەیەک هەڵبژێرە'),
            loc('من معرض الصور أو لقطة شاشة لمنتج', 'From your gallery, or a screenshot of a product', 'لە گەلەری یان وێنەی شاشەی بەرهەمێک'),
            () => galleryRef.current?.click(),
            'visual-search-gallery'
          )}
        </div>
      )}

      {step.kind === 'scan' && (
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-16">
              <Spinner size="md" delayMs={150} decorative />
            </div>
          }
        >
          <BarcodeScanner
            mode="single"
            accept="any"
            qr
            frame="strip"
            titleId="visual-search-title"
            title={title}
            onRead={onScanned}
            onManual={(text) => {
              close();
              if (text.trim()) onQuery(text.trim().slice(0, SEARCH_MAX_LENGTH));
            }}
            onClose={() => setStep({ kind: 'choose' })}
          />
        </Suspense>
      )}

      {previewSrc && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-3">
            <img
              src={previewSrc}
              alt={loc('صورتك', 'Your photo', 'وێنەکەت')}
              className="size-16 shrink-0 rounded-xl border border-border-subtle object-cover"
            />
            <div className="min-w-0 flex-1" aria-live="polite">
              {step.kind === 'reading' && (
                <p className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
                  <Sparkles className="size-4 shrink-0 animate-pulse text-text-secondary" aria-hidden="true" />
                  {loc('نتعرّف على المنتج ونطابقه مع المتجر…', 'Recognising it and matching it with the shop…', 'دەیناسینەوە و لەگەڵ فرۆشگا بەراوردی دەکەین…')}
                </p>
              )}
              {step.kind === 'result' && <Headline answer={step.answer} />}
              {step.kind === 'error' && <ErrorLine code={step.code} />}
            </div>
          </div>
        </div>
      )}

      {step.kind === 'error' && !step.preview && (
        <div className="px-4 pb-2">
          <ErrorLine code={step.code} />
        </div>
      )}

      {step.kind === 'reading' && (
        <div className="space-y-1 px-4 pb-5 pt-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex min-h-[60px] items-center gap-3 py-1.5">
              <Skeleton className="h-12 w-12 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      )}

      {step.kind === 'result' && (
        <div className="px-2.5 pb-4 pt-1">
          {step.answer.products.length > 0 && (
            <ul className="space-y-0.5" data-testid="visual-search-results">
              {step.answer.products.map((p) => {
                const conf = step.answer.confidence[p.id] ?? 'low';
                const sel = step.answer.matched[p.id];
                return (
                  <li key={p.id}>
                    <Link
                      to={linkWithSelection(productHref(p), sel)}
                      onClick={close}
                      className="flex min-h-[64px] items-center gap-3 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <SafeImage
                        sizes="56px"
                        src={productMainImage(p, theme)}
                        alt=""
                        aspect="auto"
                        className="h-14 w-14 shrink-0 overflow-hidden rounded-lg"
                        fallbackIconClassName="h-4 w-4"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-[14px] font-medium leading-snug text-text-primary">{p.name}</p>
                        <div className="mt-0.5">
                          <CardPrice p={p} compact />
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <ConfidenceTag c={conf} verdict={step.answer.verdict} />
                          {sel && step.answer.colour && <ColourTag colour={step.answer.colour} />}
                          <AvailabilityLine product={p} className="min-w-0 flex-1" />
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-2 px-1.5">
            {step.answer.query && (
              <button
                type="button"
                className="lv-button lv-button-ghost lv-button-sm text-text-primary"
                onClick={() => {
                  close();
                  onQuery(step.answer.query.slice(0, SEARCH_MAX_LENGTH));
                }}
              >
                <Search className="h-4 w-4" aria-hidden="true" />
                <span className="max-w-xs truncate">
                  {loc('ابحث عن', 'Search for', 'بگەڕێ بۆ')} <bdi dir="ltr">«{step.answer.query}»</bdi>
                </span>
              </button>
            )}
            <button type="button" className="lv-button lv-button-ghost lv-button-sm text-text-primary" onClick={retryPhoto}>
              <Camera className="h-4 w-4" aria-hidden="true" />
              {loc('صورة أخرى', 'Another photo', 'وێنەیەکی تر')}
            </button>
            {step.answer.verdict === 'none' && (
              <Link to="/support" onClick={close} className="lv-button lv-button-ghost lv-button-sm text-text-primary">
                {loc('اسأل الدعم', 'Ask support', 'پرسیار لە پشتگیری بکە')}
              </Link>
            )}
          </div>
        </div>
      )}

      {step.kind === 'error' && (
        <div className="flex flex-wrap gap-2 px-4 pb-5 pt-2">
          {step.code !== 'unavailable' && step.code !== 'limit' && (
            <button type="button" className="lv-button lv-button-ghost lv-button-sm text-text-primary" onClick={retryPhoto}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {loc('حاول مرة أخرى', 'Try again', 'دووبارە هەوڵ بدەرەوە')}
            </button>
          )}
          <button type="button" className="lv-button lv-button-ghost lv-button-sm text-text-primary" onClick={() => setStep({ kind: 'scan' })}>
            <ScanLine className="h-4 w-4" aria-hidden="true" />
            {loc('امسح الباركود', 'Scan a barcode', 'بارکۆد بخوێنەرەوە')}
          </button>
        </div>
      )}
    </Overlay>
  );
}

function Headline({ answer }: { answer: ImageAnswer }) {
  const { loc } = useLanguage();
  const [ar, en, ckb] =
    answer.verdict === 'same'
      ? answer.via === 'code'
        ? ['وجدناه من الرمز المطبوع عليه', 'Found it from the code printed on it', 'لە کۆدە چاپکراوەکەی سەری دۆزرایەوە']
        : ['وجدناه في المتجر', 'Found it in the shop', 'لە فرۆشگادا دۆزرایەوە']
      : answer.verdict === 'similar'
        ? ['لم نجد نفس المنتج بالضبط — هذه الأقرب له في المتجر', 'Not this exact product — these are the closest in the shop', 'هەمان بەرهەم نەدۆزرایەوە — ئەمانە نزیکترینن لە فرۆشگادا']
        : ['لم نجد هذا المنتج في المتجر', 'We could not find this product in the shop', 'ئەم بەرهەمە لە فرۆشگادا نەدۆزرایەوە'];
  return (
    <p data-visual-verdict={answer.verdict} className={`text-[14px] font-bold leading-snug ${answer.verdict === 'same' ? 'text-success' : 'text-text-primary'}`}>
      {loc(ar, en, ckb)}
    </p>
  );
}

function ErrorLine({ code }: { code: Extract<Step, { kind: 'error' }>['code'] }) {
  const { loc } = useLanguage();
  const [ar, en, ckb] =
    code === 'unavailable'
      ? ['البحث بالصورة غير متاح الآن — امسح الباركود أو اكتب اسم المنتج', 'Search by photo is not available right now — scan the barcode or type the name', 'گەڕان بە وێنە ئێستا بەردەست نییە — بارکۆدەکە بخوێنەرەوە یان ناوەکەی بنووسە']
      : code === 'limit'
        ? ['وصلت إلى حد البحث بالصور لهذا اليوم — جرّب لاحقًا أو امسح الباركود', 'You have reached today’s photo search limit — try later or scan the barcode', 'گەیشتیتە سنووری گەڕان بە وێنە بۆ ئەمڕۆ — دواتر هەوڵ بدەرەوە یان بارکۆد بخوێنەرەوە']
        : code === 'busy'
          ? ['الخدمة مشغولة الآن، حاول بعد لحظات', 'The service is busy, try again in a moment', 'خزمەتگوزارییەکە ئێستا قەرەباڵغە، دوای چەند ساتێک هەوڵ بدەرەوە']
          : code === 'bad_photo'
            ? ['تعذّر فتح هذه الصورة، جرّب صورة أخرى', 'This picture could not be opened, try another one', 'ئەم وێنەیە نەکرایەوە، وێنەیەکی تر تاقی بکەرەوە']
            : ['تعذّر قراءة الصورة، حاول مرة أخرى', 'The photo could not be read, try again', 'وێنەکە نەخوێندرایەوە، دووبارە هەوڵ بدەرەوە'];
  return <p className="text-[14px] font-semibold leading-snug text-text-secondary">{loc(ar, en, ckb)}</p>;
}

function ConfidenceTag({ c, verdict }: { c: Confidence; verdict: ImageAnswer['verdict'] }) {
  const { loc } = useLanguage();
  if (verdict === 'same' && c === 'high') {
    return (
      <span data-visual-confidence="high" className="shrink-0 rounded-full bg-success/15 px-1.5 text-[10.5px] font-bold leading-[16px] text-success">
        {loc('تطابق', 'Match', 'هاوتا')}
      </span>
    );
  }
  return (
    <span data-visual-confidence={c} className="shrink-0 rounded-full bg-surface-selected px-1.5 text-[10.5px] font-bold leading-[16px] text-text-muted">
      {c === 'medium' ? loc('مرجّح', 'Likely', 'لەوانەیە') : loc('مشابه', 'Similar', 'هاوشێوە')}
    </span>
  );
}

function ColourTag({ colour }: { colour: string }) {
  const { loc } = useLanguage();
  const w = COLOUR_WORDS[colour];
  if (!w) return null;
  return (
    <span data-visual-colour={colour} className="shrink-0 rounded-full bg-surface-selected px-1.5 text-[10.5px] font-bold leading-[16px] text-text-secondary">
      {loc(`اللون: ${w[0]}`, `Colour: ${w[1]}`, `ڕەنگ: ${w[2]}`)}
    </span>
  );
}
