/**
 * THE PRODUCT'S KNOWLEDGE TABS (the Bambu import spec §G.1, §G.2, §G.4).
 *
 * Its own lazy chunk (src/pages/Product.tsx mounts it when it nears the
 * viewport, IntersectionObserver rootMargin 400 px), and it fetches
 * `/api/products/:slug/knowledge` only then — never on first paint. Phones get
 * the page's own accordion (`Section`), one per tab; from 1024 px a tab strip.
 *
 * What it draws is decided in src/lib/productKnowledge.ts (pure, tested): the
 * tabs that have something to show, the rows for the selection on screen
 * (variant-scoped rows first, rows for other values under «إصدارات أخرى»),
 * the value or the state's words — never 0 or «No» for a missing value — and
 * every word in Arabic, English and Sorani. Numbers sit in <bdi> with the
 * unit as published. Documents open in a new tab with `noopener noreferrer`,
 * show their host and say they open on the manufacturer's site; a compatible
 * product is an in-app link (the router's, no reload).
 *
 * «إصدارات أخرى» — the rows of other versions and the US 110 V table (L-20) —
 * is a collapsed disclosure that SAYS it opens (a chevron that turns). Each
 * fact is one `div` of its `<dl>` holding the `<dt>`, the value's `<dd>` and
 * one `<dd>` per note (the HTML content model: a div of a dl holds dt and dd
 * only). The desktop strip WRAPS rather than clip a label at the column's
 * edge (the section is capped at 68ch beside the buy column).
 *
 * Nothing here is a price, a cost or a stock fact: the answer carries none.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Box, ChevronDown, ExternalLink, FileText, Info, Link2, Package, Settings2, Thermometer } from 'lucide-react';
import { api } from '../../lib/api';
import { useMediaQuery } from '../../lib/useMediaQuery';
import SafeImage from '../ui/SafeImage';
import { TabPanels, TabStrip } from '../ui/Tabs';
import Section from './Section';
import {
  KNOWLEDGE_WORDS,
  STATE_WORDS,
  TAB_WORDS,
  US_110V_NOTE,
  documentTitle,
  knowledgeCovers,
  knowledgeTabs,
  rowsForSelection,
  sourceLine,
  valueText,
  w,
  type KnowledgeAnswer,
  type KnowledgeLang,
  type KnowledgeRow,
  type KnowledgeSelection,
  type KnowledgeTabId,
  type PackagingLine,
} from '../../lib/productKnowledge';

export interface ProductKnowledgeTabsProps {
  slug: string;
  lang: KnowledgeLang;
  /** The values on screen: the explicit selection, else the default selection (§G.3). */
  selection: KnowledgeSelection;
  /** Value id → its name, and variant id → its values' names («خاص بـ …»). */
  scopeNames: Record<string, string>;
  /** Tells the page what the answer covers, so its older sections step aside (and whether anything is drawn). */
  onCovers?: (covers: { specs: boolean; box: boolean; any: boolean }) => void;
}

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; k: KnowledgeAnswer };

/** Label and value side by side, the label never squeezed under a long value (2 : 3); a note spans both. */
const ROW_GRID = 'grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-0.5';
/** A row's quiet note (US version, applies to, test method, source): a `<dd>` of its own across the row. */
const NOTE = 'col-span-2 text-[11px] text-text-muted';

/** «المصدر: رسمي (Bambu Lab)» once under a tab's heading when any of its rows comes from the manufacturer's page. */
function OfficialNote({ rows, lang }: { rows: readonly KnowledgeRow[]; lang: KnowledgeLang }) {
  if (!rows.some((r) => r.source && !r.source.title && (r.source.kind === 'store_page' || r.source.kind === 'store_messages' || r.source.kind === 'store_doc'))) return null;
  return (
    <p className="text-[11px] text-text-muted" data-knowledge-source-note>
      {w(KNOWLEDGE_WORDS.source, lang)} {w(KNOWLEDGE_WORDS.official, lang)}
    </p>
  );
}

/*
 * QUIET UNTIL THERE IS SOMETHING TO SAY. Every catalogue page mounts this below the
 * fold, and most products have no knowledge row: while the answer is on its way, and
 * when it is empty or did not arrive (an older Worker, a dropped connection), nothing
 * is drawn and the page's own sections stay — the page reads exactly as before.
 */

const ICONS: Record<KnowledgeTabId, React.ReactNode> = {
  specs: <Settings2 aria-hidden="true" className="w-5 h-5 text-text-secondary" />,
  materials: <Thermometer aria-hidden="true" className="w-5 h-5 text-text-secondary" />,
  packaging: <Package aria-hidden="true" className="w-5 h-5 text-text-secondary" />,
  compatibility: <Link2 aria-hidden="true" className="w-5 h-5 text-text-secondary" />,
  documents: <FileText aria-hidden="true" className="w-5 h-5 text-text-secondary" />,
};

export default function ProductKnowledgeTabs({ slug, lang, selection, scopeNames, onCovers }: ProductKnowledgeTabsProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const wide = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading' });
    api
      .get<KnowledgeAnswer & { success?: boolean }>(`/api/products/${slug}/knowledge`)
      .then((k) => {
        if (cancelled) return;
        setLoad({ state: 'ready', k });
        onCovers?.(knowledgeCovers(k));
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
    // `onCovers` is the page's state setter: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const tabs = useMemo(() => (load.state === 'ready' ? knowledgeTabs(load.k, selection) : null), [load, selection]);
  const [active, setActive] = useState<KnowledgeTabId | ''>('');
  const current: KnowledgeTabId | '' = tabs ? (tabs.order.includes(active as KnowledgeTabId) ? (active as KnowledgeTabId) : tabs.order[0] ?? '') : '';

  if (load.state === 'loading') return null;
  if (load.state === 'failed') return null;
  if (!tabs || tabs.order.length === 0) return null;

  const body = (id: KnowledgeTabId) => <TabBody id={id} tabs={tabs} lang={lang} selection={selection} scopeNames={scopeNames} />;

  if (!wide) {
    return (
      <div className="space-y-3" data-knowledge="sections">
        {tabs.order.map((id) => (
          <Section key={id} id={`knowledge-${id}`} title={w(TAB_WORDS[id], lang)} icon={ICONS[id]}>
            {body(id)}
          </Section>
        ))}
      </div>
    );
  }
  return (
    <section className="lv-surface overflow-hidden" data-knowledge="tabs" aria-label={w(KNOWLEDGE_WORDS.tabsLabel, lang)}>
      <TabStrip
        group="product-knowledge"
        panels
        fill={false}
        className="flex-wrap border-b border-border-subtle px-2"
        indicatorClassName="bg-gold"
        label={w(KNOWLEDGE_WORDS.tabsLabel, lang)}
        value={current}
        onChange={(id) => setActive(id as KnowledgeTabId)}
        items={tabs.order.map((id) => ({ id, label: w(TAB_WORDS[id], lang) }))}
      />
      <TabPanels value={current} order={tabs.order} group="product-knowledge" className="p-4">
        {current ? body(current) : null}
      </TabPanels>
    </section>
  );
}

// ------------------------------------------------------------------ the bodies

/** One tab's body (exported for the markup tests; the page mounts the default export). */
export function TabBody({
  id,
  tabs,
  lang,
  selection,
  scopeNames,
}: {
  id: KnowledgeTabId;
  tabs: NonNullable<ReturnType<typeof knowledgeTabs>>;
  lang: KnowledgeLang;
  selection: KnowledgeSelection;
  scopeNames: Record<string, string>;
}) {
  if (id === 'specs' || id === 'materials') {
    const groups = id === 'specs' ? tabs.specs : tabs.materials;
    return (
      <div className="space-y-4" data-knowledge-tab={id}>
        <OfficialNote rows={groups.flatMap((g) => g.rows)} lang={lang} />
        {groups.map((g) => (
          <RowsGroup key={g.group} title={w(g.label, lang)} rows={g.rows} lang={lang} selection={selection} scopeNames={scopeNames} />
        ))}
      </div>
    );
  }
  if (id === 'packaging') return <PackagingBody lines={tabs.packaging.lines} other={tabs.packaging.other} box={tabs.packaging.box} lang={lang} scopeNames={scopeNames} />;
  if (id === 'compatibility') {
    return (
      <div className="space-y-4" data-knowledge-tab="compatibility">
        {tabs.compatibility.map((b) => (
          <div key={b.bucket}>
            <h4 className="text-text-primary font-bold text-[13px] mb-2">{w(b.label, lang)}</h4>
            <ul className="flex flex-wrap gap-2">
              {b.items.map((item, i) => (
                <li key={`${item.label}-${i}`}>
                  {item.product ? (
                    <Link
                      to={`/product/${encodeURIComponent(item.product.slug)}`}
                      className="lv-choice inline-flex min-h-[44px] items-center gap-2 px-3 py-1.5 text-sm"
                    >
                      {item.product.image ? (
                        <SafeImage src={item.product.image} alt="" aspect="square" fit="contain" className="h-8 w-8 shrink-0 rounded-md" sizes="32px" bgClassName="bg-surface-raised" />
                      ) : null}
                      <span dir="auto">{w(item.product.name, lang) || item.label}</span>
                    </Link>
                  ) : (
                    <span className="inline-flex min-h-[36px] items-center rounded-full border border-border-subtle px-3 py-1 text-sm text-text-secondary" dir="auto">
                      {item.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  return (
    <ul className="space-y-2" data-knowledge-tab="documents">
      {tabs.documents.map((d) => (
        <li key={d.url}>
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[48px] items-center gap-3 rounded-xl border border-border-subtle px-3 py-2 hover:bg-white/5 transition-colors"
          >
            <FileText aria-hidden="true" className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-text-primary" dir="auto">{documentTitle(d, lang)}</span>
              <span className="block text-[11px] text-text-muted">
                <bdi>{d.host}</bdi> · {w(KNOWLEDGE_WORDS.opensExternal, lang)}
              </span>
            </span>
            <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function RowsGroup({
  title,
  rows,
  lang,
  selection,
  scopeNames,
}: {
  title: string;
  rows: KnowledgeRow[];
  lang: KnowledgeLang;
  selection: KnowledgeSelection;
  scopeNames: Record<string, string>;
}) {
  const { shown, hidden } = rowsForSelection(rows, selection);
  if (!shown.length && !hidden.length) return null;
  return (
    <div>
      <h4 className="text-text-primary font-bold text-[13px] mb-1">{title}</h4>
      {shown.length ? (
        <dl className="text-sm">
          {shown.map((r, i) => (
            <Row key={`${r.key}-${r.scope.id}-${r.region}-${i}`} r={r} lang={lang} scopeNames={scopeNames} />
          ))}
        </dl>
      ) : null}
      <OtherVersions rows={hidden} lang={lang} scopeNames={scopeNames} />
    </div>
  );
}

/** «إصدارات أخرى (n)»: collapsed, with a chevron that says it opens and turns when it does. */
function OtherVersions({ rows, lang, scopeNames }: { rows: KnowledgeRow[]; lang: KnowledgeLang; scopeNames: Record<string, string> }) {
  if (!rows.length) return null;
  return (
    <details className="group mt-1 text-[13px]" data-knowledge-other>
      <summary className="min-h-[44px] flex list-none items-center gap-1 cursor-pointer text-text-secondary [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
        {w(KNOWLEDGE_WORDS.otherVersions, lang)} <bdi className="ms-1 tabular-nums">({rows.length})</bdi>
      </summary>
      <dl className="text-sm">
        {rows.map((r, i) => (
          <Row key={`h-${r.key}-${r.scope.id}-${r.region}-${i}`} r={r} lang={lang} scopeNames={scopeNames} />
        ))}
      </dl>
    </details>
  );
}

/** One fact: the label, the value (or the state's words), and its quiet notes. */
function Row({ r, lang, scopeNames, label }: { r: KnowledgeRow; lang: KnowledgeLang; scopeNames: Record<string, string>; label?: string }) {
  const v = valueText(r, lang);
  // The manufacturer's own page is said once per tab («المصدر: رسمي (Bambu Lab)», TabBody); a row names
  // its source only when it is a document of its own (a manual, a TDS, a wiki page).
  const src = r.source?.title ? sourceLine(r, lang) : null;
  const scoped = r.scope.kind !== 'product' && r.scope.id;
  return (
    <div className={`py-2 border-b border-border-subtle last:border-0 ${ROW_GRID}`} data-knowledge-row={r.key} data-status={r.status}>
      <dt className="text-text-muted min-w-0 [overflow-wrap:anywhere]">{label ?? w(r.label, lang)}</dt>
        <dd className={`text-end min-w-0 [overflow-wrap:anywhere] ${v.absent ? 'text-text-muted' : 'text-text-primary'}`}>
          {r.status === 'not_found' && r.checked_sources?.length ? (
            <details className="inline-block text-start">
              <summary className="inline-flex cursor-pointer items-center gap-1">
                {v.text}
                <Info aria-hidden="true" className="h-3.5 w-3.5" />
              </summary>
              <div className="mt-1 rounded-lg border border-border-subtle bg-surface-raised p-2 text-[12px] text-text-secondary">
                <p className="font-semibold text-text-primary">{w(KNOWLEDGE_WORDS.sourcesChecked, lang)}</p>
                <ul className="mt-1 space-y-0.5">
                  {r.checked_sources.map((c, i) => (
                    <li key={i} dir="auto">
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                          {c.title || w(KNOWLEDGE_WORDS.official, lang)}
                        </a>
                      ) : (
                        c.title || w(KNOWLEDGE_WORDS.official, lang)
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : v.absent ? (
            v.text
          ) : (
            <bdi>{v.text}</bdi>
          )}
          {r.status === 'unverified' ? (
            <span className="ms-2 inline-flex items-center rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-text-secondary align-middle" data-unverified>
              {w(STATE_WORDS.unverified, lang)}
            </span>
          ) : null}
        </dd>
      {r.region === 'us_110v' ? <dd className={NOTE} data-knowledge-note="us_110v">{w(US_110V_NOTE, lang)}</dd> : null}
      {scoped && scopeNames[r.scope.id] ? (
        <dd className={NOTE} data-knowledge-note="applies-to">
          {w(KNOWLEDGE_WORDS.appliesTo, lang)} <bdi>{scopeNames[r.scope.id]}</bdi>
        </dd>
      ) : null}
      {r.test_method ? (
        <dd className={NOTE}>
          {w(KNOWLEDGE_WORDS.testMethod, lang)}: <bdi>{r.test_method}</bdi>
        </dd>
      ) : null}
      {src ? (
        <dd className={NOTE}>
          {src.url ? (
            <a href={src.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {src.text}
            </a>
          ) : (
            src.text
          )}
        </dd>
      ) : null}
    </div>
  );
}

function PackagingBody({
  lines,
  other,
  box,
  lang,
  scopeNames,
}: {
  lines: PackagingLine[];
  other: KnowledgeRow[];
  box: KnowledgeAnswer['in_the_box'];
  lang: KnowledgeLang;
  scopeNames: Record<string, string>;
}) {
  return (
    <div className="space-y-4" data-knowledge-tab="packaging">
      <OfficialNote rows={[...lines.flatMap((l) => l.rows), ...other]} lang={lang} />
      {lines.length ? (
        <dl className="text-sm">
          {lines.map((line, i) =>
            line.joined ? (
              <div key={i} className={`py-2 border-b border-border-subtle last:border-0 ${ROW_GRID}`} data-knowledge-row={line.rows[0].key.split('.')[0] + '.dimensions'}>
                <dt className="text-text-muted min-w-0">{w(line.label, lang)}</dt>
                <dd className="text-text-primary text-end min-w-0">
                  <bdi>{line.joined}</bdi>
                </dd>
              </div>
            ) : (
              <Row key={i} r={line.rows[0]} lang={lang} scopeNames={scopeNames} label={w(line.label, lang)} />
            )
          )}
        </dl>
      ) : null}
      <OtherVersions rows={other} lang={lang} scopeNames={scopeNames} />
      {box.length ? (
        <div>
          <h4 className="text-text-primary font-bold text-[13px] mb-2 flex items-center gap-2">
            <Box aria-hidden="true" className="h-4 w-4 text-text-secondary" />
            {w(KNOWLEDGE_WORDS.inTheBox, lang)}
          </h4>
          <ul className="space-y-2" data-knowledge-box>
            {box.map((item, i) => (
              <li key={i} className="flex items-center gap-3 text-sm text-text-secondary">
                {item.image ? (
                  <SafeImage src={item.image} alt="" aspect="square" fit="contain" className="h-12 w-12 shrink-0 rounded-lg" sizes="48px" bgClassName="bg-surface-raised" />
                ) : (
                  <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-gold shrink-0 mx-1" />
                )}
                <span dir="auto" className="min-w-0 flex-1">{item.text}</span>
                {item.qty && item.qty > 1 ? (
                  <bdi className="tabular-nums text-text-muted" aria-label={`${w(KNOWLEDGE_WORDS.qty, lang)} ${item.qty}`}>
                    ×{item.qty}
                  </bdi>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
