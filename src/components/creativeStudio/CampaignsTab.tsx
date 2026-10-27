/**
 * «الحملات» — named groups of designs (spec §21, §35 Phase 4; migration 0216).
 * A campaign lists its designs with their STUDIO statuses; designs are added
 * from the recent list or chosen at creation (carousel, batch), and taken out
 * again. Moving a design between campaigns makes no new version and leaves an
 * approval standing. Nothing here publishes anywhere.
 */
import { useState, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import VariantImg from '../ui/VariantImg';
import type { CampaignDto, DocumentSummaryDto } from '../../../packages/creativeDoc/src/api';
import { campaigns as campaignsApi, documents, exportFileUrl } from './client';
import { STATUS_TEXT, S, fill } from './strings';
import { RemoteView, failText, useRemote, useStudio, useText } from './shared';

/** The campaign a new design joins ('' = none); archived campaigns are not offered. */
export function CampaignSelect({ value, onChange }: { value: string; onChange(id: string): void }) {
  const { w } = useText();
  const [list] = useRemote(() => campaignsApi.list(), []);
  const open = list.status === 'ready' ? list.data.campaigns.filter((c) => !c.archived) : [];
  return (
    <Field label={w(S.campaignPick)} optional>
      <Select value={value} onChange={(e) => onChange(e.target.value)} data-campaign-select>
        <option value="">{w(S.campaignNone)}</option>
        {open.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
    </Field>
  );
}

export function statusTone(status: DocumentSummaryDto['status']): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  return status === 'approved' ? 'success' : status === 'in_review' ? 'info' : status === 'failed' ? 'danger' : status === 'scheduled' ? 'warning' : 'neutral';
}

/** A design row: its latest export as the picture when it has one, its title, its studio status. */
export function DesignRow({ d, children }: { d: DocumentSummaryDto; children?: ReactNode }) {
  const studio = useStudio();
  const { w } = useText();
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-border-subtle p-2" data-design-row={d.id}>
      <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface">
        {d.thumb_export_id ? <VariantImg src={exportFileUrl(d.thumb_export_id)} sizes="48px" alt="" className="h-full w-full object-cover" /> : null}
      </span>
      <button type="button" className="min-w-0 flex-1 truncate text-start text-sm text-text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => studio.openDocument(d.id)}>
        {d.title || d.id}
      </button>
      <StatusChip tone={statusTone(d.status)}>{w(STATUS_TEXT[d.status])}</StatusChip>
      {children}
    </li>
  );
}

function CampaignView({ campaign, onChanged }: { campaign: CampaignDto; onChanged(): void }) {
  const { lang, w } = useText();
  const [designs, reload] = useRemote(() => documents.list({ campaign_id: campaign.id, limit: 100 }), [campaign.id]);
  const [adding, setAdding] = useState(false);
  const [recent, reloadRecent] = useRemote(() => (adding ? documents.list({ limit: 60 }) : Promise.resolve({ documents: [], migrated: true })), [adding]);
  const [error, setError] = useState('');

  const attach = async (id: string, to: string | null) => {
    setError('');
    try {
      await campaignsApi.attach(id, to);
      reload();
      reloadRecent();
      onChanged();
    } catch (e) {
      setError(failText(e, lang));
    }
  };
  const toggleArchive = async () => {
    setError('');
    try {
      await campaignsApi.update(campaign.id, { archived: !campaign.archived });
      onChanged();
    } catch (e) {
      setError(failText(e, lang));
    }
  };

  return (
    <Card title={campaign.name} description={[campaign.starts_on, campaign.ends_on].filter(Boolean).join(' → ') || undefined} action={<Button size="sm" variant="ghost" onClick={toggleArchive}>{w(campaign.archived ? S.campUnarchive : S.campArchive)}</Button>}>
      {campaign.notes ? <p className="mb-2 text-sm text-text-secondary">{campaign.notes}</p> : null}
      <p className="mb-2 text-xs text-text-muted">{w(S.campStatusNote)}</p>
      <RemoteView remote={designs} onRetry={reload} compact>
        {(data) => data.documents.length ? (
          <ul className="flex flex-col gap-2" data-campaign-designs>
            {data.documents.map((d) => (
              <DesignRow key={d.id} d={d}><Button size="sm" variant="ghost" onClick={() => attach(d.id, null)}>{w(S.campRemoveDesign)}</Button></DesignRow>
            ))}
          </ul>
        ) : <p className="text-sm text-text-muted">{w(S.campNoDesigns)}</p>}
      </RemoteView>
      {!campaign.archived ? <Button className="mt-3" size="sm" onClick={() => setAdding(!adding)} aria-expanded={adding}>{w(S.campAddDesigns)}</Button> : null}
      {adding ? (
        <RemoteView remote={recent} onRetry={reloadRecent} compact>
          {(data) => (
            <ul className="mt-2 flex max-h-80 flex-col gap-2 overflow-y-auto">
              {data.documents.filter((d) => d.campaign_id !== campaign.id).map((d) => (
                <DesignRow key={d.id} d={d}><Button size="sm" onClick={() => attach(d.id, campaign.id)}>{w(S.campAdd)}</Button></DesignRow>
              ))}
            </ul>
          )}
        </RemoteView>
      ) : null}
      {error ? <p className="mt-2 text-sm text-danger" role="alert">{error}</p> : null}
    </Card>
  );
}

export default function CampaignsTab() {
  const { lang, w } = useText();
  const [list, reload] = useRemote(() => campaignsApi.list(), []);
  const [form, setForm] = useState({ name: '', starts_on: '', ends_on: '', notes: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setError('');
    setBusy(true);
    try {
      const c = await campaignsApi.create({ name: form.name.trim(), notes: form.notes.trim(), starts_on: form.starts_on || null, ends_on: form.ends_on || null });
      setForm({ name: '', starts_on: '', ends_on: '', notes: '' });
      setOpenId(c.id);
      reload();
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-campaigns-tab>
      <p className="rounded-xl bg-surface p-3 text-sm text-text-secondary" role="note">{w(S.noPublishing)}</p>
      <Card title={w(S.campNew)}>
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) void create(); }}>
          <Field label={w(S.campName)} className="sm:col-span-2"><Input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={w(S.campStarts)} optional><Input type="date" ltr value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} /></Field>
          <Field label={w(S.campEnds)} optional><Input type="date" ltr value={form.ends_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} /></Field>
          <Field label={w(S.campNotes)} optional className="sm:col-span-2 lg:col-span-3"><Textarea rows={2} value={form.notes} maxLength={600} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <div className="flex items-end"><Button type="submit" variant="primary" block loading={busy} disabled={!form.name.trim()}>{w(S.campCreate)}</Button></div>
        </form>
        {error ? <p className="mt-2 text-sm text-danger" role="alert">{error}</p> : null}
      </Card>
      <RemoteView remote={list} onRetry={reload}>
        {(data) => {
          if (!data.migrated) return <p className="text-sm text-warning" role="status">{w(S.notMigrated)}</p>;
          if (!data.campaigns.length) return <p className="text-sm text-text-muted">{w(S.campEmpty)}</p>;
          const open = data.campaigns.find((c) => c.id === openId) ?? null;
          return (
            <>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-campaign-list>
                {data.campaigns.map((c) => (
                  <li key={c.id}>
                    <button type="button" aria-pressed={openId === c.id} className="w-full rounded-xl border border-border-subtle p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" style={{ boxShadow: openId === c.id ? 'inset 0 0 0 2px #3b82f6' : undefined }} onClick={() => setOpenId(c.id)}>
                      <span className="block truncate text-sm font-semibold text-text-primary">{c.name}</span>
                      <span className="block text-xs text-text-muted">{fill(w(S.campDesigns), { n: c.document_count })}{c.archived ? ` · ${w(S.campArchived)}` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {open ? <CampaignView key={open.id} campaign={open} onChanged={reload} /> : null}
            </>
          );
        }}
      </RemoteView>
    </div>
  );
}
