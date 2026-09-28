/**
 * «اختر شكل متجرك» — THE TEMPLATES, SEEN BEFORE THEY ARE CHOSEN.
 *
 * Each of the seven starters (packages/storeLayout/src/starters.ts) is drawn
 * by the storefront's own renderer with the merchant's OWN products,
 * collections, services, works and reviews — the rows the server reads for
 * that layout without saving it (POST /api/merchant/store/layout/preview).
 * The choice used to be made from a colour strip and a list of section names
 * (review of the store builder, 2026-09-28).
 *
 *   - a card per template: the top of the page as it would look, its name,
 *     what it puts first, and «مقترح لمتجرك» on the one that fits what the
 *     store has (services and machines → the workshop; finished work → the
 *     portfolio; many products → products first; …);
 *   - «معاينة» opens the whole page, scrollable, on a phone's width, with the
 *     two ways to use it: the WHOLE page, or only its LOOK over the
 *     merchant's own sections;
 *   - nothing is written until one of those is pressed, and then only to the
 *     draft.
 */
import { useEffect, useMemo, useState } from 'react';
import { Eye, Sparkles } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Button } from '../../ui/Button';
import { Sheet } from '../../ui/Sheet';
import StoreRenderer from '../../storefront/StoreRenderer';
import '../../storefront/styles';
import { StorefrontRuntimeProvider } from '../../storefront/runtime';
import { previewRuntime } from '../../storefront/preview';
import type { StorefrontStore } from '../../storefront/types';
import { THEME_NAMES, type ThemeName } from '../../../../packages/storeLayout/src/tokens';
import { starterLayout } from '../../../../packages/storeLayout/src/starters';
import { emptyBlockData, type BlockData } from '../../../../packages/storeLayout/src/data';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { say, STARTER_COPY, THEME_COPY } from './catalog';
import PreviewCanvas from './PreviewCanvas';
import { recommendStarter } from './templatePick';
import { storeLayoutApi } from './storeLayoutApi';

const runtime = previewRuntime();

export type StarterUse = 'page' | 'look';

/** The last answer, kept a minute: closing and reopening the gallery does not ask again. */
let lastRows: { at: number; rows: Partial<Record<ThemeName, BlockData>> } | null = null;

/** The rows each starter shows, read when the gallery opens (seven small reads, in parallel). */
function useStarterRows(active: boolean) {
  const fresh = lastRows && Date.now() - lastRows.at < 60_000 ? lastRows.rows : null;
  const [rows, setRows] = useState<Partial<Record<ThemeName, BlockData>>>(() => fresh ?? {});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active || fresh) return;
    let alive = true;
    setFailed(false);
    Promise.all(
      THEME_NAMES.map((t) =>
        storeLayoutApi
          .previewLayout(starterLayout(t))
          .then((r) => [t, r.blocks_data] as const)
          .catch(() => null)
      )
    ).then((answers) => {
      if (!alive) return;
      const got = answers.filter((a): a is readonly [ThemeName, BlockData] => !!a);
      if (!got.length) setFailed(true);
      const next = Object.fromEntries(got) as Partial<Record<ThemeName, BlockData>>;
      if (got.length) lastRows = { at: Date.now(), rows: next };
      setRows(next);
    });
    return () => {
      alive = false;
    };
    // `fresh` is read once, at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return { rows, failed };
}

function PagePicture({ layout, store, data, height }: { layout: StoreLayout; store: StorefrontStore; data: BlockData | undefined; height: string }) {
  const { loc } = useLanguage();
  if (!data) {
    return <div className="w-full animate-pulse rounded-2xl bg-surface-raised motion-reduce:animate-none" style={{ height }} aria-label={loc('جارٍ رسم القالب…', 'Drawing the template…')} role="img" />;
  }
  return (
    <PreviewCanvas width={360} maxHeight={height} label={loc('صورة القالب بمنتجاتك', 'The template with your products')}>
      <StorefrontRuntimeProvider value={runtime}>
        <StoreRenderer store={store} layout={layout} data={data} />
      </StorefrontRuntimeProvider>
    </PreviewCanvas>
  );
}

export default function TemplateGallery({
  store,
  onChoose,
  busy,
  canUseLook = true,
}: {
  store: StorefrontStore;
  onChoose: (theme: ThemeName, use: StarterUse) => void;
  busy?: ThemeName | null;
  /** «الشكل فقط» needs sections of the merchant's own to dress (not on the first run). */
  canUseLook?: boolean;
}) {
  const { loc } = useLanguage();
  const starters = useMemo(() => THEME_NAMES.map((t) => ({ theme: t, layout: starterLayout(t) })), []);
  const { rows, failed } = useStarterRows(true);
  const loaded = Object.keys(rows).length > 0;
  const pick = loaded ? recommendStarter(store, rows) : null;
  const [looking, setLooking] = useState<ThemeName | null>(null);
  const looked = looking ? starters.find((s) => s.theme === looking) ?? null : null;

  // OWNER: Sorani to be written by hand (every string in this file).
  const reasonWords: Record<string, string> = {
    workshop: loc('لأن متجرك يعرض خدمات وطابعات.', 'Because your store shows services and printers.'),
    portfolio: loc('لأن عندك أعمالًا منجزة في المعرض.', 'Because you have finished work in your showcase.'),
    products: loc('لأن عندك منتجات كثيرة.', 'Because you have many products.'),
    collections: loc('لأن منتجاتك مرتّبة في مجموعات.', 'Because your products are arranged in collections.'),
    start: loc('بداية هادئة تناسب متجرًا جديدًا.', 'A quiet start for a new store.'),
  };

  return (
    <div className="space-y-3" data-sd-gallery>
      {failed && (
        <p className="text-[12px] text-warning" role="status">
          {loc('تعذّر رسم القوالب بمنتجاتك الآن — تظهر بالشكل فقط.', 'Could not draw the templates with your products now — they show their look only.')}
        </p>
      )}
      <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-3">
        {starters.map(({ theme, layout }) => {
          const recommended = pick?.theme === theme;
          return (
            <li key={theme} className={`lv-surface flex flex-col overflow-hidden ${recommended ? 'ring-1 ring-gold/50' : ''}`} data-sd-starter-card={theme}>
              {/* The picture is a whole store page (with its own inert buttons),
                  so the door to the full preview lies OVER it, as a sibling —
                  a button may not contain another. */}
              <div className="relative">
                <div className="pointer-events-none">
                  <PagePicture layout={layout} store={store} data={failed ? emptyBlockData() : rows[theme]} height="20rem" />
                </div>
                <button
                  type="button"
                  onClick={() => setLooking(theme)}
                  className="absolute inset-0 flex items-end justify-end p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                  aria-label={loc(`معاينة «${say(loc, THEME_COPY[theme].name)}»`, `Preview «${say(loc, THEME_COPY[theme].name)}»`)}
                  data-sd-starter-preview={theme}
                >
                  <span className="inline-flex items-center gap-1 rounded-full bg-canvas/85 px-2.5 py-1 text-[11.5px] font-semibold text-text-primary shadow-1 backdrop-blur">
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    {loc('معاينة', 'Preview')}
                  </span>
                </button>
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[14px] font-bold text-text-primary">{say(loc, THEME_COPY[theme].name)}</h3>
                  {recommended && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold" data-sd-recommended>
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      {loc('مقترح لمتجرك', 'Suggested for your store')}
                    </span>
                  )}
                </div>
                <p className="text-[12px] leading-relaxed text-text-muted">{say(loc, STARTER_COPY[theme])}</p>
                {recommended && pick && <p className="text-[11.5px] text-text-secondary">{reasonWords[pick.reason]}</p>}
                <div className="mt-auto pt-2">
                  <Button
                    size="sm"
                    variant={recommended ? 'primary' : 'secondary'}
                    className="w-full"
                    loading={busy === theme}
                    disabled={!!busy}
                    onClick={() => onChoose(theme, 'page')}
                    data-sd-starter={theme}
                  >
                    {loc('استخدم هذا القالب', 'Use this template')}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Sheet
        open={!!looked}
        onClose={() => setLooking(null)}
        label={looked ? say(loc, THEME_COPY[looked.theme].name) : ''}
        detents={['large']}
        panelClassName="sm:max-w-xl"
        testId="sd-starter-look"
        header={
          looked ? (
            <div className="px-4 pb-2 pt-1">
              <h2 className="text-[15px] font-bold text-text-primary">{say(loc, THEME_COPY[looked.theme].name)}</h2>
              <p className="text-[12px] text-text-muted">{say(loc, STARTER_COPY[looked.theme])}</p>
            </div>
          ) : null
        }
        footer={
          looked ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                className="flex-1 whitespace-nowrap"
                disabled={!!busy}
                loading={busy === looked.theme}
                onClick={() => {
                  onChoose(looked.theme, 'page');
                  setLooking(null);
                }}
                data-sd-look-use-page
              >
                {loc('استخدم الصفحة كاملة', 'Use the whole page')}
              </Button>
              {canUseLook && (
                <Button
                  variant="secondary"
                  className="flex-1 whitespace-nowrap"
                  disabled={!!busy}
                  onClick={() => {
                    onChoose(looked.theme, 'look');
                    setLooking(null);
                  }}
                  data-sd-look-use-look
                >
                  {loc('الشكل فقط — أبقِ أقسامي', 'The look only — keep my sections')}
                </Button>
              )}
            </div>
          ) : null
        }
      >
        {looked && (
          <div className="px-4 pb-4">
            <PagePicture layout={looked.layout} store={store} data={failed ? emptyBlockData() : rows[looked.theme]} height="min(70dvh, 720px)" />
            <p className="mt-2 text-[11.5px] text-text-muted">
              {loc('بمنتجاتك وبياناتك أنت. لا يُحفظ شيء حتى تختار.', 'With your own products and data. Nothing is saved until you choose.')}
            </p>
          </div>
        )}
      </Sheet>
    </div>
  );
}
