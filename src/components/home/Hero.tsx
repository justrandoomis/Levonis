import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, Layers, ShoppingBag } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { STUDIO_URL } from '../../translations';
import { pickText, type HomeBanner } from '../../lib/api';
import type { HeroVisual } from '../../lib/homeLayout';
import SafeImage from '../ui/SafeImage';
import PromoPhoto from './v2/PromoPhoto';

/**
 * The home hero.
 *
 * TWO MODES, and the second one is the point. When the owner has configured
 * banners it is their carousel — image, headline, sub-line and a call to
 * action, each authored per language. When they have configured NONE — which
 * is the live state today — the page used to open on a bare Services card
 * with nothing above it, so this falls back to a brand hero that says what
 * LEVONIS is and offers the two things a first-time visitor actually wants:
 * the catalogue and the Studio.
 *
 * The fallback deliberately carries NO search box: the site header already
 * renders one directly above this on the home page, and a second would eat a
 * third of a phone screen to do the same job.
 *
 * The Studio link is a PLAIN full-page navigation to the standalone subdomain
 * — no iframe, no prefetch, no Studio code in this bundle (docs/STUDIO_PLAN.md
 * decision 6, pinned by tests/store-isolation.test.ts).
 */
export default function Hero({
  banners,
  visual = null,
  loading,
}: {
  banners: HomeBanner[];
  /** The brand hero's picture (src/lib/homeLayout.ts `resolveHeroVisual`). */
  visual?: HeroVisual | null;
  loading: boolean;
}) {
  const { t, dir, lang, loc } = useLanguage();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);

  const count = banners.length;

  useEffect(() => {
    setIndex((i) => (count === 0 || i >= count ? 0 : i));
  }, [count]);

  const next = useCallback(() => {
    if (count > 1) setIndex((i) => (i + 1) % count);
  }, [count]);
  const prev = useCallback(() => {
    if (count > 1) setIndex((i) => (i - 1 + count) % count);
  }, [count]);

  useEffect(() => {
    if (!playing || count < 2) return;
    const id = setInterval(next, 5000);
    return () => clearInterval(id);
  }, [playing, next, count]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
    touchEndX.current = 0;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };
  const onTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    if (Math.abs(distance) < 50) return;
    const forward = distance > 0;
    if (dir === 'rtl' ? !forward : forward) next();
    else prev();
    touchStartX.current = 0;
    touchEndX.current = 0;
  };

  // Reserve the height while /api/home is in flight so the page below does
  // not jump when the banners (or the fallback) resolve.
  if (loading && count === 0) {
    return (
      <div
        aria-hidden="true"
        data-hero="loading"
        className="w-full h-[380px] md:h-[460px] bg-zinc-900/80 animate-pulse motion-reduce:animate-none"
      />
    );
  }

  if (count === 0) return <DefaultHero visual={visual} />;

  return (
    <section
      data-hero="banners"
      data-theme="dark"
      aria-roledescription="carousel"
      aria-label={t('heroTitle')}
      className="relative w-full h-[380px] md:h-[460px] overflow-hidden bg-olive-dark"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div
        className="flex h-full transition-transform duration-500 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(${dir === 'rtl' ? index * 100 : -index * 100}%)` }}
      >
        {banners.map((banner, i) => (
          <BannerSlide key={banner.id} banner={banner} lang={lang} dir={dir} active={i === index} />
        ))}
      </div>

      {count > 1 && (
        <div className="absolute bottom-4 inset-x-0 flex items-center justify-between px-4 sm:px-6 z-20 gap-3">
          <button
            type="button"
            onClick={dir === 'rtl' ? next : prev}
            aria-label={loc('السابق', 'Previous', 'پێشوو')}
            className="w-11 h-11 rounded-full bg-black/50 backdrop-blur text-white flex items-center justify-center hover:bg-black/70 transition-colors shrink-0"
          >
            {dir === 'rtl' ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
          </button>

          <div className="flex items-center gap-1.5 bg-black/50 backdrop-blur px-3 py-2 rounded-full min-h-[44px]">
            {banners.map((b, i) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`${i + 1} / ${count}`}
                aria-current={i === index}
                data-hero-dot={i}
                className={`rounded-full transition-all ${
                  i === index ? 'w-6 h-2 bg-white' : 'w-2 h-2 bg-white/40 hover:bg-white/70'
                }`}
              />
            ))}
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause' : 'Play'}
              className="ms-1.5 w-7 h-7 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/30 transition-colors"
            >
              {playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            </button>
          </div>

          <button
            type="button"
            onClick={dir === 'rtl' ? prev : next}
            aria-label={loc('التالي', 'Next', 'دواتر')}
            className="w-11 h-11 rounded-full bg-black/50 backdrop-blur text-white flex items-center justify-center hover:bg-black/70 transition-colors shrink-0"
          >
            {dir === 'rtl' ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </button>
        </div>
      )}
    </section>
  );
}

/** One slide: the picture, a scrim, and whatever copy the owner wrote. */
function BannerSlide({
  banner,
  lang,
  dir,
  active,
}: {
  banner: HomeBanner;
  lang: string;
  dir: string;
  active: boolean;
}) {
  const title = pickText(banner.title, lang);
  const subtitle = pickText(banner.subtitle, lang);
  const cta = pickText(banner.cta, lang);
  const hasText = !!title || !!subtitle;

  const body = (
    <>
      {banner.image ? (
        <SafeImage src={banner.image} alt={title} aspect="auto" eager className="w-full h-full" />
      ) : (
        // Text-only banner: the owner wrote a headline but uploaded no
        // picture. Rendering the brand gradient beats rendering a grey box.
        <div className="w-full h-full bg-gradient-to-br from-olive-dark via-olive to-olive-light" />
      )}
      {/* The scrim exists so light photography cannot swallow the headline.
          Only drawn when there IS a headline. */}
      {hasText && (
        <div
          aria-hidden="true"
          className={`absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent ${
            dir === 'rtl' ? 'sm:bg-gradient-to-l' : 'sm:bg-gradient-to-r'
          } sm:from-black/85 sm:via-black/40 sm:to-transparent`}
        />
      )}
      {hasText && (
        <div className="absolute inset-0 flex items-end sm:items-center">
          <div
            // Same clearance as the default hero. On a phone the copy is
            // bottom-aligned and already well clear of the fixed header; from
            // `sm` up it centres, so the padding shifts the centring box down.
            className="w-full max-w-[1920px] mx-auto px-5 sm:px-6 lg:px-8 pb-16 sm:pb-0 sm:pt-[130px]"
          >
            <div className="max-w-xl min-w-0">
              {title && (
                <h2 data-hero-title className="text-white font-black tracking-tight text-2xl sm:text-4xl md:text-5xl leading-tight mb-2 sm:mb-3">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="text-zinc-200 text-sm sm:text-base md:text-lg leading-relaxed line-clamp-3 mb-4">
                  {subtitle}
                </p>
              )}
              {cta && (
                <span
                  data-hero-cta
                  className="inline-flex items-center gap-2 min-h-[44px] px-5 rounded-full bg-white text-black text-sm font-bold shadow-lg"
                >
                  {cta}
                  {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );

  // An inactive slide is off-screen; keeping its link out of the tab order
  // stops a keyboard user from tabbing into something they cannot see.
  const inert = active ? undefined : -1;

  const className = 'relative w-full h-full flex-shrink-0 bg-olive-dark';
  if (banner.link && banner.link.startsWith('/')) {
    return (
      <Link to={banner.link} data-hero-slide className={className} tabIndex={inert} aria-hidden={!active}>
        {body}
      </Link>
    );
  }
  if (banner.link) {
    return (
      <a
        href={banner.link}
        target="_blank"
        rel="noopener noreferrer"
        data-hero-slide
        className={className}
        tabIndex={inert}
        aria-hidden={!active}
      >
        {body}
      </a>
    );
  }
  return (
    <div data-hero-slide className={className} aria-hidden={!active}>
      {body}
    </div>
  );
}

/**
 * Shown when the owner has configured no banner at all. Not a placeholder and
 * not filler: it states what the store sells and links to the two places a
 * new visitor goes. It disappears the moment a real banner is uploaded.
 *
 * IT FOLLOWS THE THEME (owner, 2026-09-26: «في hero banner … تكون بلون أسود
 * وبأزرار سوداء او ذهبيه بالرغم هو الثيم فاتح»). Its type and buttons are
 * roles (`text-white` is the ink, `bg-white` the primary fill), so on the light
 * theme it is ink on cream with a charcoal primary, and on the dark theme
 * light on olive.
 *
 * A PANEL, WITH A PICTURE (owner, 2026-09-26: «النص يبدو متداخل مع بعضه ويبدو
 * كله على اليمين، كما أن الهيرو بانر أبيض لا يمكن فرزه بالعين عن القسم»):
 *   - the headline's leading is 1.35+, because Arabic at 48–60 px needs room
 *     for its ascenders (ا ل ط) and descenders (ي ج) — at 1.1 the two lines
 *     touched;
 *   - text on the reading side, a picture on the other (`HeroVisual`: the
 *     owner's light/dark pair, else a real printer), stacked on a phone;
 *   - its own surface: a rounded panel a step warmer and deeper than the page,
 *     with a hairline and a soft lift (`.lv-hero-panel`, src/index.css), so on
 *     the cream theme it reads as a block and not as more page.
 */
function DefaultHero({ visual }: { visual: HeroVisual | null }) {
  const { t, dir } = useLanguage();
  return (
    <section
      data-hero="default"
      data-feature=""
      // HEADER_CLEARANCE: the site header is `fixed` and paints over the top
      // of every page (Header.tsx) — roughly 124 px unscrolled — so the panel
      // starts below it. The bottom padding is where the ticker's cap
      // (Home.tsx, `-mt-7`) overlaps, so it never cuts into the panel.
      className="relative w-full px-4 pb-12 pt-[128px] sm:px-6 sm:pt-[146px] lg:px-8 lg:pb-14"
    >
      <div
        className={`lv-hero-panel relative mx-auto grid max-w-[1920px] overflow-hidden rounded-[22px] lg:rounded-[32px] ${
          visual ? 'md:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]' : ''
        }`}
      >
        {/* A quiet layer grid — a nod to what the machine actually does. No
            image request, so it costs nothing and cannot 404. */}
        <div aria-hidden="true" className="lv-hero-lines pointer-events-none absolute inset-0 opacity-[0.14]" />
        <div className="relative flex min-w-0 flex-col justify-center px-5 py-7 sm:px-8 sm:py-10 lg:px-12 lg:py-14 xl:px-16">
          <span className="mb-4 inline-block w-fit rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-[11px] font-bold tracking-widest text-gold sm:text-xs">
            LEVONIS
          </span>
          <h1
            data-hero-title
            className="mb-3 text-[28px] font-black leading-[1.4] text-white [text-wrap:balance] min-[400px]:text-[32px] sm:mb-4 sm:text-[40px] sm:leading-[1.35] lg:text-[52px] xl:text-[60px]"
          >
            {t('heroTitle')}
          </h1>
          <p className="mb-7 max-w-xl text-sm leading-relaxed text-zinc-200 sm:text-base lg:text-lg">{t('heroSubtitle')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/products"
              data-hero-cta="shop"
              className="inline-flex min-h-[48px] items-center gap-2 rounded-full bg-white px-6 text-sm font-bold text-black shadow-xl transition-colors hover:bg-zinc-200 sm:text-base"
            >
              <ShoppingBag aria-hidden="true" className="h-4 w-4" />
              {t('heroShop')}
              {dir === 'rtl' ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Link>
            {/* A new tab: the Studio is a separate app on a separate
                subdomain, and taking the store's tab costs the visitor their
                place on the page they were reading. */}
            <a
              href={STUDIO_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-hero-cta="studio"
              className="inline-flex min-h-[48px] items-center gap-2 rounded-full border border-white/25 bg-black/45 px-6 text-sm font-bold text-white backdrop-blur transition-colors hover:bg-black/65 sm:text-base"
            >
              <Layers aria-hidden="true" className="h-4 w-4" />
              {t('heroStudio')}
            </a>
          </div>
        </div>
        {visual ? <HeroPicture visual={visual} /> : null}
      </div>
    </section>
  );
}

/**
 * The hero's picture, in a rounded frame inset in the panel — the same frame
 * in both themes, so a dark studio photograph reads as a mounted print on the
 * cream panel rather than a smudge fading into it. A product photograph is
 * cropped to its middle band (`crop`) and opens its product; the owner's own
 * picture fills the frame whole.
 */
function HeroPicture({ visual }: { visual: HeroVisual }) {
  const frame = (
    <PromoPhoto
      src={visual.image}
      lightSrc={visual.lightImage}
      crop={visual.productPhoto}
      bleed
      eager
      width={720}
      height={720}
      className="inset-0"
    />
  );
  const cls =
    'group relative isolate mx-4 mb-4 block aspect-[16/10] overflow-hidden rounded-[16px] bg-onyx min-[480px]:aspect-[2/1] sm:mx-8 sm:mb-8 md:m-3 md:aspect-auto md:min-h-[320px] lg:m-4 lg:min-h-[400px] lg:rounded-[22px] xl:min-h-[440px]';
  if (visual.to) {
    return (
      <Link to={visual.to} data-hero-visual="product" aria-label={visual.alt} className={`${cls} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
        {frame}
      </Link>
    );
  }
  return (
    <div data-hero-visual="owner" className={cls}>
      {frame}
    </div>
  );
}
