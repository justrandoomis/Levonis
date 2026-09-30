/**
 * «شارات الثقة» — /community/badges (docs/COMMUNITY_ECOSYSTEM.md §9.6,
 * Reputation V2). The page every «لماذا؟» leads to: the five badges a store
 * can hold, each with its rule in the reader's language (ar / en / ckb), and
 * how they are made — nightly, from the store's own conversations and orders,
 * never bought and never chosen by the merchant.
 *
 * THE NUMBERS ARE THE SERVER'S. The catalogue (`GET /api/community/badges`,
 * edge-cached for guests) carries each rule's `rule_params`; the sentences are
 * built from them (../../components/community/reputation/strings.ts), so a
 * re-tuned rule reads right the night it changes. The page draws at once with
 * the numbers published when this build was written and takes the catalogue's
 * when it lands; a failed read says so in one quiet line and keeps the list.
 *
 * `#<key>` (a chip's «عن الشارات») scrolls to that badge and marks it — one
 * selection cue, the selected surface.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useGoBack } from '../../lib/useGoBack';
import { BADGE_ICONS, loadRules } from '../../components/community/reputation/BadgeChips';
import { BADGE_KEYS, isBadgeKey, type BadgeKey, type BadgeRuleParams } from '../../components/community/reputation/api';
import { repLang, reputationStrings, ruleSentence } from '../../components/community/reputation/strings';

export default function BadgesPage() {
  const goBack = useGoBack('/community');
  const { lang, dir } = useLanguage();
  const l = repLang(lang);
  const s = reputationStrings(l);
  const { hash } = useLocation();
  const picked = decodeURIComponent(hash.replace(/^#/, ''));
  const selected: BadgeKey | null = isBadgeKey(picked) ? picked : null;
  const [rules, setRules] = useState<Map<BadgeKey, BadgeRuleParams> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadRules().then((r) => {
      if (!alive) return;
      if (r) setRules(r);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The badge a «لماذا؟» sent the reader to, in view once the page is drawn.
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => document.getElementById(selected)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  return (
    <div className="min-h-screen bg-canvas pb-28 text-text-primary" data-badges-page>
      <div className="material scroll-edge sticky top-0 z-40 h-14 px-4">
        <div className="mx-auto flex h-full max-w-3xl items-center gap-2">
          <button
            type="button"
            aria-label={s.page.back}
            onClick={goBack}
            className="press-scale -ms-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Back className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4">
        <header className="pt-4">
          <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
            <span aria-hidden="true" className="h-px w-4 bg-gold" />
            {s.page.kicker}
          </p>
          <h1 className="mt-1 text-[24px] font-black leading-tight">{s.page.title}</h1>
          <p className="mt-2 text-balance text-[14px] leading-relaxed text-text-secondary">{s.page.intro}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-text-muted" data-badges-how>
            {s.page.how}
          </p>
          {failed && (
            <p role="status" className="mt-3 text-[12.5px] text-text-muted" data-badges-failed>
              {s.page.failed}
            </p>
          )}
        </header>

        <ul className="mt-6 flex flex-col gap-3" aria-label={s.page.title}>
          {BADGE_KEYS.map((key) => {
            const Icon = BADGE_ICONS[key];
            const on = key === selected;
            return (
              <li
                key={key}
                id={key}
                data-badge={key}
                aria-current={on ? 'true' : undefined}
                className={`scroll-mt-14 rounded-2xl border p-4 ${on ? 'border-border-subtle bg-surface-selected' : 'border-border-subtle/60 bg-surface'}`}
              >
                <h2 className="flex items-center gap-2 text-[15px] font-bold">
                  <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-raised text-gold">
                    <Icon className="h-4 w-4" />
                  </span>
                  {s.names[key]}
                </h2>
                <p className="mt-2.5 text-[11.5px] font-semibold text-text-muted">{s.page.rule}</p>
                <p className="mt-0.5 text-[13.5px] leading-relaxed text-text-secondary" data-badge-rule>
                  {ruleSentence(key, rules?.get(key), l)}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
