/**
 * THE LIBRARY INDEX — eighteen documents as a shelf, not as a list.
 *
 * THE SECTIONS ARE THE REGISTRY'S OWN. worker/lib/policies/index.ts already
 * groups the corpus into six themed sections and proves at compile time that
 * every document sits in one; this renders that grouping rather than inventing
 * a second one that would drift from it. A customer hunting the transit-damage
 * clause looks under delivery, not under "D".
 *
 * WHAT A CARD SAYS is what a reader needs before deciding to open a legal
 * document: its title, the line IT uses to state its own scope, the version and
 * the date that version took effect. The version and the date are not
 * decoration — they are how a customer and the store establish that they are
 * arguing about the same text.
 */
import { Link } from 'react-router-dom';
import { FileText, ShieldCheck } from 'lucide-react';
import { formatPolicyDate, usePolicyStrings } from './policyStrings';
import type { PolicyListItem, PolicySectionItem } from './usePolicyCorpus';

function titleOf(titles: Record<string, string>, lang: string, fallback: string): string {
  return titles[lang]?.trim() || titles.ar?.trim() || fallback;
}

function DocumentCard({ item, lang, summary }: { item: PolicyListItem; lang: string; summary?: string }) {
  const s = usePolicyStrings();
  const effective = formatPolicyDate(item.effective_at, lang);

  return (
    <li>
      <Link
        to={`/policies/${encodeURIComponent(item.key)}`}
        data-policy-card={item.key}
        className="lv-surface flex h-full min-h-[44px] flex-col gap-2 rounded-[var(--radius-lg)] p-4 transition-colors hover:border-gold/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <div className="flex items-start gap-3">
          <FileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
          <h3 className="min-w-0 flex-1 text-[15px] font-bold leading-[1.6] text-text-primary">
            {titleOf(item.titles, lang, item.key)}
          </h3>
          {item.required_for_checkout && (
            <span
              title={s.requiredExplain}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gold/12 px-2 py-1 text-[10px] font-bold leading-[1.4] text-gold"
            >
              <ShieldCheck aria-hidden="true" className="h-3 w-3" />
              {s.requiredBadge}
            </span>
          )}
        </div>

        {/* The scope line arrives with the document, so the card is complete
            from the first paint and gains its summary a moment later rather
            than holding the whole index back for it. */}
        {summary && <p className="line-clamp-2 text-[13px] leading-[1.85] text-text-secondary">{summary}</p>}

        <p dir="ltr" className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] leading-[1.6] text-text-muted text-start">
          <span>v{item.version}</span>
          {effective && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                <span className="sr-only">{s.effective}: </span>
                {effective}
              </span>
            </>
          )}
        </p>
      </Link>
    </li>
  );
}

export interface PolicyLibraryProps {
  sections: PolicySectionItem[];
  list: PolicyListItem[];
  summaries: Record<string, string>;
  lang: string;
}

export default function PolicyLibrary({ sections, list, summaries, lang }: PolicyLibraryProps) {
  const byKey = new Map(list.map((item) => [item.key, item]));
  const placed = new Set<string>();

  const groups = sections.map((section) => {
    const items = section.keys.flatMap((key) => {
      const item = byKey.get(key);
      if (!item) return [];
      placed.add(key);
      return [item];
    });
    return { id: section.id, title: titleOf(section.titles, lang, section.id), items };
  });

  // A document the server lists but places in no section still has to be
  // reachable: silently dropping it would hide a published policy from the
  // only page that lists them.
  const orphans = list.filter((item) => !placed.has(item.key));
  if (orphans.length > 0) groups.push({ id: 'other', title: '', items: orphans });

  return (
    <div className="space-y-10">
      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <section key={group.id} aria-labelledby={`policy-section-${group.id}`}>
            <h2
              id={`policy-section-${group.id}`}
              className="mb-3 border-b border-border-subtle pb-2 text-[13px] font-bold uppercase leading-[1.6] tracking-wide text-text-muted"
            >
              {group.title}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {group.items.map((item) => (
                <DocumentCard key={item.key} item={item} lang={lang} summary={summaries[item.key]} />
              ))}
            </ul>
          </section>
        )
      )}
    </div>
  );
}
