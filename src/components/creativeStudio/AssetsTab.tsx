/**
 * «الأصول» — logos, backgrounds, extra product shots, icons and references
 * uploaded by a person (spec §38: every asset keeps where it came from and
 * its review state). The SERVER sets an upload's review: the owner's is
 * approved at once, another admin's starts as «بانتظار المراجعة». Every text
 * here follows the review the server answered with (`uploadedText`), never an
 * assumption; only approved assets can enter a design or reach Claude. The
 * file is checked by the server by its bytes, not its name; the studio serves
 * it back only through its own route.
 */
import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import VariantImg from '../ui/VariantImg';
import type { AssetDto, AssetKind } from '../../../packages/creativeDoc/src/api';
import { assets as assetsApi } from './client';
import { ASSET_KIND_TEXT, REVIEW_STATE_TEXT, S, fill } from './strings';
import { RemoteView, failText, shortTime, useRemote, useText } from './shared';
import { uploadedText } from './screensModel';

const KINDS: AssetKind[] = ['logo', 'background', 'product_extra', 'icon', 'element', 'reference_liked', 'reference_rejected'];

export default function AssetsTab() {
  const { lang, w } = useText();
  const [list, reload, setList] = useRemote(() => assetsApi.list(), []);
  const [kind, setKind] = useState<AssetKind>('background');
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = async () => {
    if (!file) return;
    setMessage(null);
    setBusy(true);
    try {
      const created = await assetsApi.upload(file, kind, label.trim().slice(0, 80));
      if (list.status === 'ready') setList([created, ...list.data]);
      setFile(null);
      setLabel('');
      if (input.current) input.current.value = '';
      setMessage({ tone: 'ok', text: w(uploadedText(created.review)) });
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    } finally {
      setBusy(false);
    }
  };

  const review = async (a: AssetDto, state: AssetDto['review']) => {
    setMessage(null);
    try {
      await assetsApi.review(a.id, state);
      reload();
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };

  const remove = async (a: AssetDto) => {
    setMessage(null);
    try {
      await assetsApi.remove(a.id);
      if (list.status === 'ready') setList(list.data.filter((x) => x.id !== a.id));
      setMessage({ tone: 'ok', text: w(S.assetsDeleted) });
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };

  const provenance = (p: AssetDto['provenance']) => w(p === 'uploaded' ? S.provUploaded : p === 'catalog' ? S.provCatalog : p === 'generated' ? S.provGenerated : S.provDerived);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-assets-tab>
      <Card title={w(S.assetsUpload)} description={w(S.assetsReviewHelp)}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={w(S.assetsKind)}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{w(ASSET_KIND_TEXT[k])}</option>)}
            </Select>
          </Field>
          <Field label={w(S.assetsLabel)}><Input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></Field>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-text-secondary">{w(S.assetsFile)}</span>
            {/* The browser’s own file control speaks the browser’s language; this button speaks the reader’s. */}
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button onClick={() => input.current?.click()}>{w(S.assetsChoose)}</Button>
            <span className="truncate text-xs text-text-muted" dir="auto">{file ? file.name : w(S.assetsNoFile)}</span>
          </div>
        </div>
        <Button className="mt-3" variant="primary" disabled={!file} loading={busy} onClick={upload}>{w(S.assetsUpload)}</Button>
        {message ? <p className={`mt-2 text-sm ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}
      </Card>

      <RemoteView remote={list} onRetry={reload}>
        {(items) => items.length === 0 ? <p className="text-sm text-text-muted">{w(S.assetsEmpty)}</p> : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-asset-list>
            {items.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface p-3">
                <div className="aspect-video overflow-hidden rounded-lg" style={{ background: 'repeating-conic-gradient(rgba(127,127,127,0.12) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px' }}>
                  <VariantImg src={a.url} sizes="320px" alt={a.label} className="h-full w-full object-contain" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{a.label || w(ASSET_KIND_TEXT[a.kind])}</span>
                  <StatusChip tone={a.review === 'approved' ? 'success' : a.review === 'rejected' ? 'danger' : 'warning'}>{w(REVIEW_STATE_TEXT[a.review])}</StatusChip>
                </div>
                <p className="text-xs text-text-muted">
                  {w(ASSET_KIND_TEXT[a.kind])} · {a.width && a.height ? `${a.width}×${a.height}` : ''} · {fill(w(S.assetsProvenance), { p: provenance(a.provenance) })} · {shortTime(a.created_at, lang)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {a.review !== 'approved' ? <Button size="sm" onClick={() => review(a, 'approved')}>{w(S.assetsApprove)}</Button> : null}
                  {a.review !== 'rejected' ? <Button size="sm" variant="ghost" onClick={() => review(a, 'rejected')}>{w(S.assetsReject)}</Button> : null}
                  <Button size="sm" variant="danger" onClick={() => remove(a)}>{w(S.remove)}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </RemoteView>
    </div>
  );
}
