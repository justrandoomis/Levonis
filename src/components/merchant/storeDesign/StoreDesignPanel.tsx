/**
 * «تصميم المتجر» — choose the store page's theme, see the draft, publish it,
 * and go back to any published version.
 *
 * The minimum that makes the store-layout contract usable end to end
 * (docs/MERCHANT_PLATFORM.md §4.4; the block-by-block builder is wave 4):
 *
 *   - a theme is saved to the DRAFT (`applyTheme` changes tokens only — never
 *     a block, a product, a review or a word);
 *   - the preview renders the draft with the storefront's own renderer, inert,
 *     at a phone, tablet or desktop width (the blocks respond to the frame's
 *     width through container queries — no iframe, which the CSP forbids);
 *   - «Publish» makes the draft what visitors see, in one atomic step;
 *   - every published version is listed and can be previewed, restored into
 *     the draft, or restored and published.
 *
 * Self-contained: it asks the server for the merchant's own store and layout,
 * so the wave-3 workspace can mount it unchanged. Two-step confirmations stay
 * inline — no native dialogs.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { History, Palette, RotateCcw, Upload } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { merchantApi, storefrontApi } from '../../../lib/merchant';
import Segmented from '../../ui/Segmented';
import Spinner from '../../ui/Spinner';
import { ErrorState } from '../../ui/AsyncStates';
import StoreRenderer from '../../storefront/StoreRenderer';
import StoreTheme from '../../storefront/StoreTheme';
import '../../storefront/styles';
import { StorefrontRuntimeProvider } from '../../storefront/runtime';
import { previewRuntime } from '../../storefront/preview';
import type { StorefrontStore } from '../../storefront/types';
import { applyTheme } from '../../../../packages/storeLayout/src/normalize';
import { defaultLayoutFromStore } from '../../../../packages/storeLayout/src/defaults';
import { THEME_NAMES, THEME_PRESETS, type ThemeName } from '../../../../packages/storeLayout/src/tokens';
import type { BlockData } from '../../../../packages/storeLayout/src/data';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { storeLayoutApi, type LayoutRevision, type LayoutState } from './storeLayoutApi';

type Loc = (ar: string, en: string, ckb?: string) => string;

// OWNER: Sorani to be written by hand — every string in this panel passes only
// Arabic and English (docs/DECISIONS.md row 11).
function themeCopy(loc: Loc): Record<ThemeName, { name: string; line: string }> {
  return {
    classic: { name: loc('الكلاسيكي', 'Classic'), line: loc('صفحة متجرك كما عرفها زبائنك', 'Your store page as customers know it') },
    minimal: { name: loc('البسيط', 'Minimal'), line: loc('هدوء ومساحات واسعة وصور طولية', 'Quiet, roomy, tall pictures') },
    modern: { name: loc('العصري', 'Modern'), line: loc('بطاقات بارزة وزوايا دائرية', 'Raised cards, round corners') },
    premium_dark: { name: loc('الداكن الفاخر', 'Premium dark'), line: loc('أسود عميق وأسماء فوق الصور', 'Deep black, names over pictures') },
    workshop: { name: loc('الورشة', 'Workshop'), line: loc('كثيف وعملي لمن يعرض قدراته', 'Dense and practical, for capabilities') },
    portfolio: { name: loc('معرض الأعمال', 'Portfolio'), line: loc('الصور أولًا لأعمالك', 'Pictures first, for your work') },
    product_focused: { name: loc('المنتجات أولًا', 'Product focused'), line: loc('شبكة منتجات أوسع', 'A wider product grid') },
  };
}

function refusal(e: unknown, loc: Loc): string {
  const code = e instanceof ApiError ? e.code : '';
  switch (code) {
    case 'DRAFT_CHANGED':
      return loc('تغيّرت المسودة من مكان آخر — حمّلنا آخر نسخة، أعد المحاولة.', 'The draft changed elsewhere — the latest one is loaded, try again.');
    case 'LAYOUT_REJECTED':
      return loc('في التصميم ما لا يمكن أن تحمله صفحة متجر.', 'This design holds something a store page cannot.');
    case 'LAYOUT_EMPTY':
      return loc('صفحة المتجر تحتاج قسمًا ظاهرًا واحدًا على الأقل.', 'A store page needs at least one visible section.');
    case 'LAYOUT_TOO_LARGE':
      return loc('التصميم أكبر مما تسمح به صفحة المتجر.', 'This design is larger than a store page may be.');
    case 'REVISION_NOT_FOUND':
      return loc('هذه النسخة لم تعد موجودة.', 'That version no longer exists.');
    default:
      return loc('تعذّر الحفظ — حاول مجددًا.', 'Could not save — try again.');
  }
}

const WIDTHS = { phone: 390, tablet: 768, desktop: 1280 } as const;
type Device = keyof typeof WIDTHS;

export default function StoreDesignPanel() {
  const { loc, lang } = useLanguage();
  const [state, setState] = useState<LayoutState | null>(null);
  const [store, setStore] = useState<StorefrontStore | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<{ label: string; layout: StoreLayout; data: BlockData } | null>(null);
  const [device, setDevice] = useState<Device>('phone');
  const [confirm, setConfirm] = useState<{ revision: number; publish: boolean } | null>(null);

  const loadPreview = useCallback(
    async (revision?: number) => {
      const p = await storeLayoutApi.preview(revision);
      setPreview({
        label: revision ? loc(`النسخة ${revision}`, `Version ${revision}`) : loc('المسودة', 'Draft'),
        layout: p.layout,
        data: p.blocks_data,
      });
    },
    [loc]
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, me] = await Promise.all([storeLayoutApi.get(), merchantApi.me()]);
      setState(s);
      if (me.store) {
        // The public profile (stats included) is what the page renders around
        // the layout; a store the public cannot see falls back to the owner's.
        const pub = await storefrontApi.store(me.store.slug).then((d) => d.store as StorefrontStore).catch(() => me.store as StorefrontStore);
        setStore(pub);
      }
      await loadPreview();
    } catch (e) {
      setError(e);
    }
  }, [loadPreview]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, work: () => Promise<string>) {
    setBusy(label);
    setMessage(null);
    try {
      const text = await work();
      setMessage({ ok: true, text });
      setConfirm(null);
      await load();
    } catch (e) {
      setMessage({ ok: false, text: refusal(e, loc) });
      if (e instanceof ApiError && e.code === 'DRAFT_CHANGED') await load();
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorState error={error} onRetry={() => void load()} compact />;
  if (!state || !store) {
    return (
      <div className="py-10 flex justify-center">
        <Spinner size="md" />
      </div>
    );
  }

  const draft = state.draft;
  const copy = themeCopy(loc);
  const published = state.published;
  const when = (iso: string | null | undefined) =>
    // Arabic month names, Latin digits — the digits every other figure on the dashboard uses.
    iso ? new Date(iso).toLocaleString(lang === 'en' ? 'en-US' : 'ar-IQ-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  const chooseTheme = (theme: ThemeName) =>
    run(`theme:${theme}`, async () => {
      await storeLayoutApi.saveDraft(applyTheme(draft.layout, theme), draft.version);
      return loc(`حُفظ نمط «${copy[theme].name}» في المسودة — انشره ليراه زبائنك.`, `«${copy[theme].name}» saved to the draft — publish it for customers to see.`);
    });

  const publish = () =>
    run('publish', async () => {
      let version = draft.version;
      // Nothing saved yet: the draft is what the editor shows; save it first.
      if (version === 0) version = (await storeLayoutApi.saveDraft(draft.layout, 0)).draft.version;
      const r = await storeLayoutApi.publish(version);
      return loc(`نُشرت النسخة ${r.published.revision} — هذا ما يراه زبائنك الآن.`, `Version ${r.published.revision} is live — this is what customers see now.`);
    });

  const restore = (revision: number, andPublish: boolean) =>
    run(`restore:${revision}`, async () => {
      const r = await storeLayoutApi.restore(revision, draft.version, andPublish);
      return r.published
        ? loc(`أُعيدت النسخة ${revision} ونُشرت كنسخة ${r.published.revision}.`, `Version ${revision} restored and published as version ${r.published.revision}.`)
        : loc(`أُعيدت النسخة ${revision} إلى المسودة.`, `Version ${revision} restored to the draft.`);
    });

  const resetClassic = () =>
    run('reset', async () => {
      await storeLayoutApi.saveDraft(defaultLayoutFromStore(store), draft.version);
      return loc('عادت المسودة إلى الصفحة الكلاسيكية.', 'The draft is back to the classic page.');
    });

  return (
    <div className="space-y-4" data-store-design>
      {/* What visitors see, and whether the draft differs. */}
      <section className="lv-surface p-4 space-y-2" aria-labelledby="sd-status">
        <h2 id="sd-status" className="text-white font-bold text-[15px] flex items-center gap-2">
          <Palette className="w-4 h-4 text-gold" aria-hidden="true" />
          {loc('تصميم المتجر', 'Store design')}
        </h2>
        <p className="text-zinc-400 text-[12.5px] leading-relaxed">
          {published
            ? loc(`يرى زبائنك النسخة ${published.revision}، نُشرت ${when(published.published_at)}.`, `Customers see version ${published.revision}, published ${when(published.published_at)}.`)
            : loc('لم تنشر تصميمًا بعد — يرى زبائنك صفحتك الكلاسيكية المأخوذة من إعدادات متجرك.', 'You have not published a design yet — customers see your classic page, built from your store settings.')}
        </p>
        {state.dirty && (
          <p className="text-amber-300/90 text-[12px]">{loc('في المسودة تغييرات لم تُنشر.', 'The draft has changes that are not published.')}</p>
        )}
      </section>

      {/* Theme */}
      <section aria-labelledby="sd-theme">
        <h3 id="sd-theme" className="text-zinc-300 text-[13px] font-bold mb-2">
          {loc('النمط', 'Theme')}
        </h3>
        <div role="radiogroup" aria-labelledby="sd-theme" className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {THEME_NAMES.map((t) => {
            const selected = draft.layout.theme === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!!busy}
                onClick={() => !selected && void chooseTheme(t)}
                className="lv-choice text-start p-2.5 flex flex-col gap-2 disabled:opacity-60"
              >
                <ThemeSwatch theme={t} storeAccent={store.accent} />
                <span className="min-w-0">
                  <span className="block text-white text-[12.5px] font-bold truncate">{copy[t].name}</span>
                  <span className="block text-zinc-500 text-[11px] leading-snug line-clamp-2">{copy[t].line}</span>
                </span>
                {busy === `theme:${t}` && <Spinner size="xs" decorative />}
              </button>
            );
          })}
        </div>
      </section>

      {/* Preview */}
      <section aria-labelledby="sd-preview" className="space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 id="sd-preview" className="text-zinc-300 text-[13px] font-bold">
            {loc('معاينة', 'Preview')}
            {preview ? <span className="text-zinc-500 font-medium"> — {preview.label}</span> : null}
          </h3>
          <Segmented
            group="store-design-device"
            label={loc('عرض المعاينة على', 'Preview on')}
            value={device}
            onChange={(id) => setDevice(id as Device)}
            items={[
              { id: 'phone', label: loc('هاتف', 'Phone') },
              { id: 'tablet', label: loc('لوحي', 'Tablet') },
              { id: 'desktop', label: loc('حاسوب', 'Desktop') },
            ]}
          />
        </div>
        {preview ? (
          <PreviewFrame width={WIDTHS[device]}>
            <StorefrontRuntimeProvider value={previewRuntime()}>
              <StoreRenderer store={store} layout={preview.layout} data={preview.data} className="min-h-[480px] pb-6" />
            </StorefrontRuntimeProvider>
          </PreviewFrame>
        ) : (
          <div className="py-10 flex justify-center">
            <Spinner />
          </div>
        )}
      </section>

      {/* Publish */}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="lv-button lv-button-primary" disabled={!!busy || (!state.dirty && !!published)} onClick={() => void publish()}>
          {busy === 'publish' ? <Spinner size="xs" decorative /> : <Upload className="w-4 h-4" aria-hidden="true" />}
          {loc('انشر التصميم', 'Publish design')}
        </button>
        {!published && draft.exists && draft.layout.theme !== 'classic' && (
          <button type="button" className="lv-button lv-button-ghost" disabled={!!busy} onClick={() => void resetClassic()}>
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
            {loc('عودة للكلاسيكي', 'Back to classic')}
          </button>
        )}
      </div>
      <p aria-live="polite" className={message ? `text-[12.5px] ${message.ok ? 'text-emerald-300' : 'text-red-300'}` : 'sr-only'}>
        {message?.text}
      </p>

      {/* History */}
      <section aria-labelledby="sd-history" className="space-y-2">
        <h3 id="sd-history" className="text-zinc-300 text-[13px] font-bold flex items-center gap-1.5">
          <History className="w-4 h-4" aria-hidden="true" />
          {loc('النسخ المنشورة', 'Published versions')}
          <span className="text-zinc-500 font-medium">
            ({state.revision_count}/{state.limits.max_revisions})
          </span>
        </h3>
        {state.revisions.length === 0 ? (
          <p className="text-zinc-500 text-[12px]">{loc('لا نسخ بعد — كل نشر يحفظ نسخة يمكنك العودة إليها.', 'No versions yet — every publish keeps one you can return to.')}</p>
        ) : (
          <ul className="space-y-2">
            {state.revisions.map((r) => (
              <RevisionRow
                key={r.id}
                r={r}
                when={when(r.published_at)}
                busy={busy}
                confirming={confirm?.revision === r.revision ? confirm : null}
                onPreview={() => void loadPreview(r.revision)}
                onAsk={(publishToo) => setConfirm({ revision: r.revision, publish: publishToo })}
                onCancel={() => setConfirm(null)}
                onConfirm={() => void restore(r.revision, !!confirm?.publish)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RevisionRow({
  r,
  when,
  busy,
  confirming,
  onPreview,
  onAsk,
  onCancel,
  onConfirm,
}: {
  r: LayoutRevision;
  when: string;
  busy: string | null;
  confirming: { revision: number; publish: boolean } | null;
  onPreview: () => void;
  onAsk: (publishToo: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { loc } = useLanguage();
  return (
    <li className="lv-surface p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-white text-[13px] font-bold tabular-nums">{loc(`النسخة ${r.revision}`, `Version ${r.revision}`)}</span>
        {r.live && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">{loc('منشورة الآن', 'Live')}</span>}
        {r.restored_from && <span className="text-zinc-500 text-[11px]">{loc(`من النسخة ${r.restored_from}`, `from version ${r.restored_from}`)}</span>}
        <span className="text-zinc-500 text-[11.5px] ms-auto">{when}</span>
      </div>
      {confirming ? (
        <div className="mt-2.5 space-y-2" role="group" aria-label={loc('تأكيد الاستعادة', 'Confirm restore')}>
          <p className="text-zinc-300 text-[12px]">
            {confirming.publish
              ? loc(`ستحل النسخة ${r.revision} محل مسودتك وتُنشر فورًا.`, `Version ${r.revision} will replace your draft and go live now.`)
              : loc(`ستحل النسخة ${r.revision} محل مسودتك. ما يراه زبائنك لن يتغير حتى تنشر.`, `Version ${r.revision} will replace your draft. What customers see does not change until you publish.`)}
          </p>
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="lv-button lv-button-primary lv-button-sm" disabled={!!busy} onClick={onConfirm}>
              {busy === `restore:${r.revision}` && <Spinner size="xs" decorative />}
              {confirming.publish ? loc('استعد وانشر', 'Restore and publish') : loc('استعد إلى المسودة', 'Restore to draft')}
            </button>
            <button type="button" className="lv-button lv-button-ghost lv-button-sm" disabled={!!busy} onClick={onCancel}>
              {loc('إلغاء', 'Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2 flex-wrap">
          <button type="button" className="lv-button lv-button-secondary lv-button-sm" onClick={onPreview}>
            {loc('معاينة', 'Preview')}
          </button>
          {!r.live && (
            <>
              <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={!!busy} onClick={() => onAsk(false)}>
                {loc('استعد إلى المسودة', 'Restore to draft')}
              </button>
              <button type="button" className="lv-button lv-button-ghost lv-button-sm" disabled={!!busy} onClick={() => onAsk(true)}>
                {loc('استعد وانشر', 'Restore and publish')}
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** A small, faithful sample of a preset: its ground, a card, a product tile and the accent. */
function ThemeSwatch({ theme, storeAccent }: { theme: ThemeName; storeAccent: unknown }) {
  const tokens = THEME_PRESETS[theme];
  return (
    <StoreTheme tokens={tokens} storeAccent={storeAccent} className="relative h-16 w-full overflow-hidden rounded-lg border border-white/10 p-2">
      <SwatchBody />
    </StoreTheme>
  );
}

function SwatchBody() {
  return (
    <div className="flex gap-1.5 h-full" aria-hidden="true">
      <div className="sf-tile w-8 h-full">
        <div className="sf-well h-2/3" />
      </div>
      <div className="flex-1 flex flex-col gap-1.5">
        <div className="sf-card h-5" />
        <div className="sf-card h-5" />
      </div>
    </div>
  );
}

/**
 * The preview: the page laid out at `width` (the blocks answer the frame's
 * width, not the screen's) and scaled down to fit. `inert`: nothing in it can
 * be focused or clicked — it is a picture of the page that uses the real code.
 */
function PreviewFrame({ width, children }: { width: number; children: React.ReactNode }) {
  const { loc, dir } = useLanguage();
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(width);
  const [height, setHeight] = useState(480);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setAvail(o.clientWidth);
      setHeight(i.scrollHeight);
    });
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, avail / width);
  // Centred when the device is narrower than the panel; scaled from the top
  // left corner when it is wider.
  const style = useMemo(
    () => ({ width: `${width}px`, transform: `scale(${scale})`, transformOrigin: 'top left', marginInline: scale === 1 ? 'auto' : undefined }),
    [width, scale]
  );
  return (
    <div
      ref={outer}
      dir="ltr"
      className="relative w-full overflow-y-auto overflow-x-hidden rounded-xl border border-white/10 max-h-[560px] overscroll-contain"
      aria-label={loc('معاينة صفحة المتجر', 'Store page preview')}
      role="img"
    >
      <div style={{ height: `${Math.ceil(height * scale)}px` }}>
        <div ref={inner} style={style} inert>
          {/* The frame is laid out left-to-right so the scale anchors at
              one known corner; the page inside keeps the reader's direction. */}
          <div dir={dir}>{children}</div>
        </div>
      </div>
    </div>
  );
}
