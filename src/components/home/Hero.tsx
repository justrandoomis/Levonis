import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, Layers, ShoppingBag } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { STUDIO_URL } from '../../translations';
import { pickText, type HomeBanner } from '../../lib/api';
import SafeImage from '../ui/SafeImage';

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
export default function Hero({ banners, loading }: { banners: HomeBanner[]; loading: boolean }) {
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

  if (count === 0) return <DefaultHero />;

  return (
    <section
      data-hero="banners"
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
            className="w-full max-w-7xl mx-auto px-5 sm:px-10 pb-16 sm:pb-0 sm:pt-[130px]"
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
 */
function DefaultHero() {
  const { t, dir } = useLanguage();
  return (
    <section
      data-hero="default"
      className="relative w-full overflow-hidden bg-gradient-to-br from-olive-dark via-olive to-olive-light"
    >
      {/* A quiet layer grid — a nod to what the machine actually does. No
          image request, so it costs nothing and cannot 404. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,.6) 0px, rgba(255,255,255,.6) 1px, transparent 1px, transparent 14px)',
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30"
      />
      {/* HEADER_CLEARANCE: the site header is `fixed` and paints over the top
          of every page (Header.tsx). Unscrolled it is roughly 124px tall — two
          rows plus the search field — so hero copy starts below it. The
          background still runs full-bleed to the top; only the text moves. */}
      <div className="relative max-w-7xl mx-auto px-5 sm:px-10 pt-[132px] pb-14 sm:pt-[150px] sm:pb-20 md:pb-24">
        <div className="max-w-2xl min-w-0">
          <span className="inline-block text-olive-light bg-black/40 border border-white/15 rounded-full px-3 py-1 text-[11px] sm:text-xs font-bold tracking-widest mb-4">
            LEVONIS
          </span>
          <h1
            data-hero-title
            className="text-white font-black tracking-tight text-3xl sm:text-5xl md:text-6xl leading-[1.1] mb-3 sm:mb-4"
          >
            {t('heroTitle')}
          </h1>
          <p className="text-zinc-200 text-sm sm:text-lg leading-relaxed mb-7 max-w-xl">{t('heroSubtitle')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/products"
              data-hero-cta="shop"
              className="inline-flex items-center gap-2 min-h-[48px] px-6 rounded-full bg-white text-black text-sm sm:text-base font-bold hover:bg-zinc-200 transition-colors shadow-xl"
            >
              <ShoppingBag aria-hidden="true" className="w-4 h-4" />
              {t('heroShop')}
              {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </Link>
            {/* A new tab: the Studio is a separate app on a separate
                subdomain, and taking the store's tab costs the visitor their
                place on the page they were reading. */}
            <a
              href={STUDIO_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-hero-cta="studio"
              className="inline-flex items-center gap-2 min-h-[48px] px-6 rounded-full bg-black/45 backdrop-blur border border-white/25 text-white text-sm sm:text-base font-bold hover:bg-black/65 transition-colors"
            >
              <Layers aria-hidden="true" className="w-4 h-4" />
              {t('heroStudio')}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
