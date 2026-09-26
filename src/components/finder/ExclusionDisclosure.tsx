import React, { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { FinderExcluded } from '../../../packages/catalog/src/discoveryTypes';
import { fetchCandidates, tri, type CompareLang } from '../../lib/compare';
import { resultsUi, type FinderLang } from './strings';

const GROUPS: Array<keyof FinderExcluded> = ['budget', 'tech', 'sale', 'ranked_lower'];

/**
 * «7 طابعات أخرى: 6 خارج ميزانيتك، و1 أقل ملاءمة لإجاباتك» — what was left
 * out and WHY, by the server's own grouping (`excluded`), collapsed.
 *
 * The response carries ids only. Opening the disclosure fetches the NAMES once,
 * from the compare picker's public list of machines like the first result
 * (`/api/compare/candidates?for=`), and prints each under its reason. A name
 * that list does not carry is simply not printed — the count stays true.
 */
export default function ExclusionDisclosure({
  excluded,
  anchorId,
  lang,
}: {
  excluded: FinderExcluded;
  anchorId: string | null;
  lang: FinderLang;
}) {
  const t = resultsUi(lang);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const [loading, setLoading] = useState(false);

  const counts = GROUPS.map((g) => ({ g, ids: excluded[g] ?? [] })).filter((x) => x.ids.length > 0);
  const total = counts.reduce((n, x) => n + x.ids.length, 0);

  useEffect(() => {
    if (!open || names || !anchorId) return;
    const controller = new AbortController();
    setLoading(true);
    fetchCandidates(anchorId, '', { signal: controller.signal, mascot: 'silent' })
      .then((res) => {
        const m = new Map<string, string>();
        for (const c of [res.for, ...res.products]) if (c) m.set(c.id, tri(c.name, lang as CompareLang));
        setNames(m);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNames(new Map());
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, names, anchorId, lang]);

  if (total === 0) return null;

  const phrase = (g: keyof FinderExcluded, n: number) =>
    g === 'budget' ? t.othersBudget(n) : g === 'tech' ? t.othersTech(n) : g === 'sale' ? t.othersSale(n) : t.othersRanked(n);
  const summary = counts.map((x) => phrase(x.g, x.ids.length)).join(lang === 'en' ? ', ' : '، ');

  return (
    <section className="rounded-[18px] border border-dashed border-border-subtle">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-[18px]"
      >
        <span className="min-w-0 flex-1 text-[13px] leading-[20px] text-text-secondary">
          <b className="font-bold text-text-primary">{t.othersTitle(total)}</b>
          {lang === 'en' ? ': ' : ': '}
          {summary}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-5 shrink-0 text-text-muted transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div id={panelId} hidden={!open} className="border-t border-dashed border-border-subtle px-4 pb-4 pt-3">
        {loading ? <p className="text-[12.5px] text-text-muted" aria-live="polite">{t.othersNamesLoading}</p> : null}
        <dl className="space-y-3">
          {counts.map(({ g, ids }) => {
            const known = names ? ids.map((id) => names.get(id)).filter((n): n is string => !!n) : [];
            return (
              <div key={g}>
                <dt className="text-[12.5px] font-bold text-text-primary">{phrase(g, ids.length)}</dt>
                {known.length > 0 ? (
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {known.map((n) => (
                      <bdi
                        key={n}
                        dir="ltr"
                        className="rounded-full bg-surface-selected px-2.5 py-1 text-[12px] font-semibold text-text-secondary"
                      >
                        {n.split(' / ')[0]}
                      </bdi>
                    ))}
                  </dd>
                ) : null}
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}
