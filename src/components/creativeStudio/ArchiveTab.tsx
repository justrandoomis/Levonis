/**
 * «الأرشيف» — every design, filtered by status, size, product (chosen by its
 * name, sent as `product_id`) and date — the «to» date includes its own day
 * (screensModel.archiveQuery) — with a title search (spec §22). Any design
 * can be duplicated as a new draft (POST /documents/:id/duplicate) and opens
 * in the editor; switching the copy to another product is not built yet. Each design’s versions say who changed it and how
 * (by hand, by Claude, from a template, a restore); two versions can be drawn
 * side by side through the real renderer, and any version restored — as a
 * NEW version, so nothing is lost by restoring.
 */
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import { Checkbox } from '../ui/Switch';
import type { DocStatus, DocumentSummaryDto, ProductListItemDto, VersionDto } from '../../../packages/creativeDoc/src/api';
import { normalizeDocument } from '../../../packages/creativeDoc/src/normalize';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import { localized } from '../../../packages/creativeDoc/src/snapshot';
import { documents, type DocumentFilters } from './client';
import DocThumb from './DocThumb';
import { ProductChip, ProductPicker } from './ProductPicker';
import { FORMAT_TEXT, ORIGIN_TEXT, STATUS_TEXT, S, fill } from './strings';
import { RemoteView, failText, shortTime, useRemote, useStudio, useText } from './shared';
import { archiveQuery } from './screensModel';

const STATUSES: DocStatus[] = ['idea', 'draft', 'in_review', 'approved', 'scheduled', 'published', 'archived', 'failed'];

export default function ArchiveTab() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [filters, setFilters] = useState<DocumentFilters>({ status: '', format: '', q: '', product_id: '', from: '', to: '' });
  const [applied, setApplied] = useState<DocumentFilters>(filters);
  const [list, reload] = useRemote(() => documents.list({ ...archiveQuery(applied), limit: 60 }), [applied]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [product, setProduct] = useState<Pick<ProductListItemDto, 'id' | 'name'> | null>(null);
  const [message, setMessage] = useState('');

  const pickProduct = (p: Pick<ProductListItemDto, 'id' | 'name'> | null) => {
    setProduct(p);
    const next = { ...filters, product_id: p?.id ?? '' };
    setFilters(next);
    setApplied(next);
  };
  const duplicate = async (d: DocumentSummaryDto) => {
    setMessage('');
    try {
      const copy = await documents.duplicate(d.id);
      studio.openDocument(copy.id);
    } catch (e) {
      setMessage(failText(e, lang));
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-archive-tab>
      <Card>
        <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" onSubmit={(e) => { e.preventDefault(); setApplied({ ...filters }); }}>
          <Field label={w(S.archiveSearch)} className="sm:col-span-2"><Input type="search" value={filters.q ?? ''} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /></Field>
          <Field label={w(S.archiveStatus)}>
            <Select value={filters.status ?? ''} onChange={(e) => setFilters({ ...filters, status: e.target.value as DocStatus | '' })}>
              <option value="">{w(S.archiveAll)}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{w(STATUS_TEXT[s])}</option>)}
            </Select>
          </Field>
          <Field label={w(S.archiveFormat)}>
            <Select value={filters.format ?? ''} onChange={(e) => setFilters({ ...filters, format: e.target.value })}>
              <option value="">{w(S.archiveAll)}</option>
              {(['square', 'portrait', 'story', 'custom'] as const).map((f) => <option key={f} value={f}>{w(FORMAT_TEXT[f])}</option>)}
            </Select>
          </Field>
          <Field label={w(S.archiveFrom)}><Input type="date" ltr value={filters.from ?? ''} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field>
          <Field label={w(S.archiveTo)}><Input type="date" ltr value={filters.to ?? ''} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field>
          <div className="flex items-end"><Button type="submit" variant="primary" block>{w(S.archiveSearch)}</Button></div>
        </form>
        <div className="mt-3 flex flex-col gap-2 sm:max-w-md" data-archive-product>
          {product ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold text-text-secondary">{w(S.archiveProduct)}:</span>
              <ProductChip id={product.id} name={product.name} onRemove={() => pickProduct(null)} />
            </div>
          ) : (
            <ProductPicker label={w(S.archiveProduct)} hint={w(S.archiveProductSearch)} onPick={(p) => pickProduct(p)} />
          )}
        </div>
      </Card>
      <p className="text-xs text-text-muted">{w(S.archiveDuplicateHint)}</p>
      {message ? <p className="text-sm text-danger" role="alert">{message}</p> : null}
      <RemoteView remote={list} onRetry={reload}>
        {({ documents: items, migrated }) => (
          !migrated ? <p className="text-sm text-text-muted">{w(S.notMigrated)}</p>
            : items.length === 0 ? <p className="text-sm text-text-muted">{w(S.archiveEmpty)}</p>
            : (
              <ul className="flex flex-col gap-2" data-archive-list>
                {items.map((d) => (
                  <li key={d.id} className="rounded-xl border border-border-subtle bg-surface p-3">
                    <Row d={d} lang={lang} onOpen={() => studio.openDocument(d.id)} onDuplicate={() => duplicate(d)} expanded={openId === d.id} onToggle={() => setOpenId(openId === d.id ? null : d.id)} />
                    {openId === d.id ? <Versions doc={d} onRestored={reload} /> : null}
                  </li>
                ))}
              </ul>
            )
        )}
      </RemoteView>
    </div>
  );
}

function Row({ d, lang, onOpen, onDuplicate, expanded, onToggle }: { d: DocumentSummaryDto; lang: ReturnType<typeof useText>['lang']; onOpen(): void; onDuplicate(): Promise<void>; expanded: boolean; onToggle(): void }) {
  const { w } = useText();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary">{d.title}</p>
        <p className="text-xs text-text-muted">
          {w(FORMAT_TEXT[d.format.id])} · {fill(w(S.saveVersion), { n: d.version })} · {fill(w(S.archiveUpdated), { time: shortTime(d.updated_at, lang) })}
          {d.product_name ? ` · ${localized(d.product_name, lang)}` : ''}
        </p>
        {d.needs_review.length ? <p className="text-xs text-warning">{fill(w(S.archiveNeedsReview), { list: d.needs_review.join('، ') })}</p> : null}
      </div>
      <StatusChip tone={d.status === 'approved' ? 'success' : d.status === 'failed' ? 'danger' : 'neutral'}>{w(STATUS_TEXT[d.status])}</StatusChip>
      <Button size="sm" aria-expanded={expanded} onClick={onToggle}>{w(S.archiveVersions)}</Button>
      <Button size="sm" onClick={onDuplicate} data-duplicate={d.id}>{w(S.archiveDuplicate)}</Button>
      <Button size="sm" variant="primary" onClick={onOpen}>{w(S.open)}</Button>
    </div>
  );
}

function Versions({ doc, onRestored }: { doc: DocumentSummaryDto; onRestored(): void }) {
  const { lang, w } = useText();
  const [list, reload] = useRemote(() => documents.versions(doc.id), [doc.id]);
  const [picked, setPicked] = useState<number[]>([]);
  const [compare, setCompare] = useState<Array<{ version: number; content: CreativeDocument }> | null>(null);
  const [message, setMessage] = useState('');

  const runCompare = async () => {
    setMessage('');
    try {
      const out = [];
      for (const v of picked.slice(0, 2).sort((a, b) => a - b)) {
        const { content } = await documents.version(doc.id, v);
        const n = normalizeDocument(content);
        if (!n.ok) throw new Error(w(S.editorLoadFailed));
        out.push({ version: v, content: n.doc });
      }
      setCompare(out);
    } catch (e) {
      setMessage(failText(e, lang));
    }
  };
  const restore = async (v: VersionDto) => {
    setMessage('');
    try {
      await documents.restore(doc.id, v.version, doc.version);
      setMessage(w(S.archiveRestored));
      reload();
      onRestored();
    } catch (e) {
      setMessage(failText(e, lang));
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3" data-versions={doc.id}>
      <RemoteView remote={list} onRetry={reload} compact>
        {(items) => (
          <ul className="flex flex-col gap-1">
            {items.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={picked.includes(v.version)}
                  onChange={(on) => setPicked(on ? [...picked, v.version].slice(-2) : picked.filter((x) => x !== v.version))}
                  label={`v${v.version} · ${w(ORIGIN_TEXT[v.origin])} · ${shortTime(v.created_at, lang)}${v.created_by_name ? ` · ${fill(w(S.archiveBy), { name: v.created_by_name })}` : ''}`}
                />
                {v.change_summary ? <span className="text-xs text-text-muted">{v.change_summary}</span> : null}
                {v.version !== doc.version ? <Button size="sm" variant="ghost" onClick={() => restore(v)}>{w(S.archiveRestore)}</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </RemoteView>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={picked.length !== 2} onClick={runCompare}>{w(S.archiveCompare)}</Button>
        {picked.length !== 2 ? <span className="text-xs text-text-muted">{w(S.archiveCompareHint)}</span> : null}
      </div>
      {message ? <p className="text-sm text-text-secondary" role="status">{message}</p> : null}
      {compare ? (
        <div className="grid gap-3 sm:grid-cols-2" data-compare>
          {compare.map((c) => <DocThumb key={c.version} doc={c.content} width={320} label={fill(w(S.archiveCompareRender), { n: c.version })} />)}
        </div>
      ) : null}
    </div>
  );
}
