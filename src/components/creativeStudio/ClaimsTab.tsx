/**
 * «الخدمات المعتمدة» — the documented service texts a service post is built
 * from (spec §7-ج, §19; the third of the three Phase-1 templates).
 *
 * The OWNER writes a claim in Arabic, English and Sorani — title, summary,
 * conditions — with the page on the site that documents it, the products it
 * covers and its validity, and approves it. Every save is a NEW pending
 * version (POST /claims, PUT /claims/:id); approving it (POST
 * /claims/:id/approve) retires the older approved one, and the designs bound
 * to the older one are marked for review by the server. Each claim lists the
 * designs that use it (GET /claims/:id/documents). Full admins read only; the
 * server refuses their writes either way (OWNER_ONLY).
 */
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Textarea } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import type { ClaimDto } from '../../../packages/creativeDoc/src/api';
import { localized, type Localized } from '../../../packages/creativeDoc/src/snapshot';
import { claims as claimsApi } from './client';
import { ProductChip, ProductPicker } from './ProductPicker';
import { STATUS_TEXT, S, fill, type Tri } from './strings';
import { RemoteView, failText, useRemote, useStudio, useText } from './shared';
import { claimApprovable, claimBody, claimForm, claimFormProblems, groupClaims, type ClaimForm, type ClaimGroup, type ClaimProblem } from './screensModel';

const PROBLEM_TEXT: Readonly<Record<ClaimProblem, Tri>> = {
  key: S.claimsProblemKey,
  title: S.claimsProblemTitle,
  ckb_copy: S.claimsProblemCkb,
  dates: S.claimsProblemDates,
  path: S.claimsProblemPath,
};

type Message = { tone: 'ok' | 'error'; text: string } | null;

export default function ClaimsTab() {
  const studio = useStudio();
  const { lang, w } = useText();
  const owner = studio.user.isOwner;
  const [list, reload] = useRemote(() => claimsApi.list(), []);
  // null: no form; { group: null }: a new claim; { group }: a new version of that claim.
  const [editing, setEditing] = useState<{ group: ClaimGroup | null } | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const approve = async (g: ClaimGroup) => {
    if (!g.pending) return;
    setMessage(null);
    try {
      const out = await claimsApi.approve(g.id, g.pending.version);
      setMessage({ tone: 'ok', text: fill(w(S.claimsApproved), { n: out.marked }) });
      reload();
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-claims-tab>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 text-xl font-bold text-text-primary">{w(S.tabClaims)}</h1>
        {owner && !editing ? <Button variant="primary" onClick={() => { setMessage(null); setEditing({ group: null }); }} data-claim-new>{w(S.claimsNew)}</Button> : null}
      </div>
      <p className="text-sm text-text-secondary">{w(S.claimsIntro)}</p>
      {!owner ? <p className="text-sm text-text-muted" role="status" data-claims-read-only>{w(S.claimsOwnerOnly)}</p> : null}
      {message ? <p className={`text-sm ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'} data-claims-message>{message.text}</p> : null}

      {owner && editing ? (
        <ClaimEditor
          key={editing.group?.id ?? 'new'}
          group={editing.group}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); setMessage({ tone: 'ok', text: w(S.claimsSaved) }); reload(); }}
        />
      ) : null}

      <RemoteView remote={list} onRetry={reload}>
        {(items) => {
          const groups = groupClaims(items);
          if (!groups.length) return <p className="text-sm text-text-muted">{w(S.claimsEmpty)}</p>;
          return (
            <ul className="flex flex-col gap-3" data-claim-list>
              {groups.map((g) => (
                <li key={g.id}>
                  <ClaimCard group={g} owner={owner} onEdit={() => { setMessage(null); setEditing({ group: g }); }} onApprove={() => approve(g)} />
                </li>
              ))}
            </ul>
          );
        }}
      </RemoteView>
    </div>
  );
}

function ClaimCard({ group, owner, onEdit, onApprove }: { group: ClaimGroup; owner: boolean; onEdit(): void; onApprove(): Promise<void> }) {
  const { lang, w } = useText();
  const [showDocs, setShowDocs] = useState(false);
  const shown = (group.pending ?? group.approved) as ClaimDto;
  const approvable = group.pending ? claimApprovable(group.pending) : false;
  return (
    <Card padding="md" level={3} title={localized(shown.title, lang) || group.key}>
      <div className="flex flex-col gap-2" data-claim={group.id}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-muted" dir="ltr">{group.key}</span>
          {group.approved ? <StatusChip tone="success">{fill(w(S.claimsApprovedVersion), { n: group.approved.version })}</StatusChip> : null}
          {group.pending ? <StatusChip tone="warning">{fill(w(S.claimsPendingVersion), { n: group.pending.version })}</StatusChip> : null}
        </div>
        {localized(shown.summary, lang) ? <p className="text-sm text-text-secondary">{localized(shown.summary, lang)}</p> : null}
        {localized(shown.conditions, lang) ? <p className="whitespace-pre-line text-sm text-text-secondary"><span className="text-text-muted">{w(S.claimsFieldConditions)}: </span>{localized(shown.conditions, lang)}</p> : null}
        <p className="text-xs text-text-muted">
          {fill(w(S.claimsValidity), { from: shown.valid_from?.slice(0, 10) ?? w(S.claimsOpenEnded), until: shown.valid_until?.slice(0, 10) ?? w(S.claimsOpenEnded) })}
          {' · '}
          {shown.product_ids.length ? fill(w(S.claimsProductsCount), { n: shown.product_ids.length }) : w(S.claimsGeneral)}
          {shown.details_path ? <> · <span dir="ltr">{shown.details_path}</span></> : null}
        </p>
        {shown.source_note ? <p className="text-xs text-text-muted">{w(S.claimsSource)}: {shown.source_note}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          {owner ? <Button size="sm" onClick={onEdit} data-claim-edit={group.id}>{w(S.claimsEdit)}</Button> : null}
          {owner && group.pending ? (
            <Button size="sm" variant="primary" disabled={!approvable} onClick={onApprove} data-claim-approve={group.id}>{fill(w(S.claimsApprove), { n: group.pending.version })}</Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-expanded={showDocs} onClick={() => setShowDocs(!showDocs)}>{w(S.claimsDesigns)}</Button>
        </div>
        {owner && group.pending && !approvable ? <p className="text-xs text-warning">{w(S.claimsApproveNeeds)}</p> : null}
        {showDocs ? <ClaimDesigns id={group.id} /> : null}
      </div>
    </Card>
  );
}

function ClaimDesigns({ id }: { id: string }) {
  const studio = useStudio();
  const { w } = useText();
  const [docs, reload] = useRemote(() => claimsApi.documents(id), [id]);
  return (
    <div className="border-t border-border-subtle pt-2" data-claim-designs={id}>
      <RemoteView remote={docs} onRetry={reload} compact>
        {(list) => list.length === 0 ? <p className="text-sm text-text-muted">{w(S.claimsNoDesigns)}</p> : (
          <ul className="flex flex-col gap-1">
            {list.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{d.title}</span>
                <StatusChip tone={d.needs_review.length ? 'warning' : 'neutral'}>{w(STATUS_TEXT[d.status])}</StatusChip>
                <Button size="sm" onClick={() => studio.openDocument(d.id)}>{w(S.open)}</Button>
              </li>
            ))}
          </ul>
        )}
      </RemoteView>
    </div>
  );
}

const LANGS = [['ar', S.claimsLangAr, 'rtl'], ['en', S.claimsLangEn, 'ltr'], ['ckb', S.claimsLangCkb, 'rtl']] as const;

/** Three slots of one field, each in its own direction. */
function LocalizedFields({ legend, value, onChange, multiline, max }: { legend: string; value: Localized; onChange(v: Localized): void; multiline: boolean; max: number }) {
  const { w } = useText();
  return (
    <fieldset className="grid gap-2 rounded-lg border border-border-subtle p-3 md:grid-cols-3">
      <legend className="px-1 text-sm font-semibold text-text-primary">{legend}</legend>
      {LANGS.map(([l, label, dir]) => (
        <Field key={l} label={w(label)}>
          {multiline
            ? <Textarea rows={3} dir={dir} maxLength={max} value={value[l]} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />
            : <Input dir={dir} maxLength={max} value={value[l]} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />}
        </Field>
      ))}
    </fieldset>
  );
}

function ClaimEditor({ group, onCancel, onSaved }: { group: ClaimGroup | null; onCancel(): void; onSaved(): void }) {
  const { lang, w } = useText();
  const base = group ? group.pending ?? group.approved : null;
  const [form, setForm] = useState<ClaimForm>(() => claimForm(base));
  const [names, setNames] = useState<Record<string, Localized>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isNew = !group;
  const problems = claimFormProblems(form, isNew);
  const set = (patch: Partial<ClaimForm>) => setForm({ ...form, ...patch });

  const save = async () => {
    setError('');
    if (problems.length) return;
    setBusy(true);
    try {
      if (group) await claimsApi.revise(group.id, claimBody(form));
      else await claimsApi.create(form.key, claimBody(form));
      onSaved();
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={group ? fill(w(S.claimsEditing), { title: localized((base as ClaimDto).title, lang) || group.key }) : w(S.claimsNew)}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }} data-claim-form>
        {isNew ? (
          <Field label={w(S.claimsKey)} hint={w(S.claimsKeyHint)}>
            <Input ltr value={form.key} maxLength={60} autoComplete="off" spellCheck={false} onChange={(e) => set({ key: e.target.value.trim().toLowerCase() })} data-claim-key />
          </Field>
        ) : null}
        <LocalizedFields legend={w(S.claimsFieldTitle)} value={form.title} max={120} multiline={false} onChange={(title) => set({ title })} />
        <LocalizedFields legend={w(S.claimsFieldSummary)} value={form.summary} max={400} multiline onChange={(summary) => set({ summary })} />
        <LocalizedFields legend={w(S.claimsFieldConditions)} value={form.conditions} max={800} multiline onChange={(conditions) => set({ conditions })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={w(S.claimsDetailsPath)} hint={w(S.claimsDetailsHint)}>
            <Input ltr value={form.details_path} maxLength={200} onChange={(e) => set({ details_path: e.target.value })} data-claim-path />
          </Field>
          <Field label={w(S.claimsSource)} hint={w(S.claimsSourceHint)} optional>
            <Input value={form.source_note} maxLength={400} onChange={(e) => set({ source_note: e.target.value })} />
          </Field>
          <Field label={w(S.claimsValidFrom)} optional><Input type="date" ltr value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} /></Field>
          <Field label={w(S.claimsValidUntil)} optional><Input type="date" ltr value={form.valid_until} onChange={(e) => set({ valid_until: e.target.value })} /></Field>
          <Field label={w(S.claimsVerified)} optional><Input type="date" ltr value={form.last_verified_at} onChange={(e) => set({ last_verified_at: e.target.value })} /></Field>
        </div>
        <div className="flex flex-col gap-2">
          <ProductPicker
            label={w(S.claimsProducts)}
            hint={w(S.claimsProductsHint)}
            onPick={(p) => { setNames({ ...names, [p.id]: p.name }); if (!form.product_ids.includes(p.id)) set({ product_ids: [...form.product_ids, p.id] }); }}
          />
          {form.product_ids.length ? (
            <div className="flex flex-wrap gap-2">
              {form.product_ids.map((id) => <ProductChip key={id} id={id} name={names[id] ?? null} onRemove={() => set({ product_ids: form.product_ids.filter((x) => x !== id) })} />)}
            </div>
          ) : <p className="text-xs text-text-muted">{w(S.claimsGeneral)}</p>}
        </div>
        {problems.length ? (
          <ul className="list-disc ps-5 text-sm text-warning" role="status" data-claim-problems>
            {problems.map((p) => <li key={p}>{w(PROBLEM_TEXT[p])}</li>)}
          </ul>
        ) : null}
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={problems.length > 0} data-claim-save>{w(S.claimsSave)}</Button>
          <Button onClick={onCancel}>{w(S.cancel)}</Button>
        </div>
      </form>
    </Card>
  );
}
