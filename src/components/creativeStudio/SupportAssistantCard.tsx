/**
 * The support chat's Claude switch, for the owner (DECISIONS row 348;
 * worker/lib/assist/ai/settings.ts). It sits on the provider page because the
 * key there serves both the studio and the chat. The model comes from the
 * provider's live list (the same GET /provider/models), never a typed name.
 */
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select } from '../ui/Field';
import { Switch } from '../ui/Switch';
import type { ModelDto } from '../../../packages/creativeDoc/src/api';
import { provider as providerApi, type SupportAssistantDto } from './client';
import { S, fill } from './strings';
import { RemoteView, failText, useRemote, useText } from './shared';

export default function SupportAssistantCard({ models, onLoadModels }: { models: ModelDto[] | null; onLoadModels(): void }) {
  const { lang, w } = useText();
  const [remote, reload] = useRemote(() => providerApi.supportAssistant(), []);
  return (
    <Card title={w(S.saTitle)} description={w(S.saNote)}>
      <RemoteView remote={remote} onRetry={reload} compact>
        {(s) => <Body s={s} models={models} onLoadModels={onLoadModels} lang={lang} w={w} onSaved={reload} />}
      </RemoteView>
    </Card>
  );
}

function Body({
  s, models, onLoadModels, lang, w, onSaved,
}: {
  s: SupportAssistantDto;
  models: ModelDto[] | null;
  onLoadModels(): void;
  lang: ReturnType<typeof useText>['lang'];
  w: ReturnType<typeof useText>['w'];
  onSaved(): void;
}) {
  const [draft, setDraft] = useState(s);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(s), [s]);
  const num = (v: string) => (v.trim() === '' ? 0 : Math.round(Number(v)));

  const save = async () => {
    setMessage(null);
    setBusy(true);
    try {
      await providerApi.saveSupportAssistant({
        enabled: draft.enabled,
        // Sent only when changed: the server checks a model against the live list.
        ...(draft.model !== s.model ? { model: draft.model } : {}),
        guests: draft.guests,
        ckb: draft.ckb,
        wiki: draft.wiki,
        photos: draft.photos,
        daily_turns: draft.daily_turns,
        guest_share_pct: draft.guest_share_pct,
      });
      setMessage({ tone: 'ok', text: w(S.setSaved) });
      onSaved();
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-support-assistant>
      <p className="text-xs text-text-muted">{fill(w(S.saToday), { n: s.today.turns, g: s.today.guest_turns })}</p>
      <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label={w(S.saEnabled)} disabled={busy} />
      <Field label={w(S.saModel)}>
        {models ? (
          <Select value={draft.model ?? ''} onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}>
            <option value="">{w(S.setModelNone)}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.display_name} ({m.id})</option>)}
          </Select>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-text-primary" dir="ltr">{s.model ?? w(S.setModelNone)}</span>
            <Button size="sm" onClick={onLoadModels} disabled={s.key_source === 'none'}>{w(S.setModelLoad)}</Button>
          </div>
        )}
      </Field>
      <Switch checked={draft.guests} onChange={(v) => setDraft({ ...draft, guests: v })} label={w(S.saGuests)} disabled={busy} />
      <Switch checked={draft.ckb} onChange={(v) => setDraft({ ...draft, ckb: v })} label={w(S.saCkb)} description={w(S.saCkbHint)} disabled={busy} />
      <Switch checked={draft.wiki} onChange={(v) => setDraft({ ...draft, wiki: v })} label={w(S.saWiki)} description={w(S.saWikiHint)} disabled={busy} />
      <Switch checked={draft.photos} onChange={(v) => setDraft({ ...draft, photos: v })} label={w(S.saPhotos)} description={w(S.saPhotosHint)} disabled={busy} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={w(S.saDaily)}><Input type="number" ltr min={1} max={5000} value={draft.daily_turns} onChange={(e) => setDraft({ ...draft, daily_turns: num(e.target.value) })} /></Field>
        <Field label={w(S.saGuestShare)}><Input type="number" ltr min={0} max={100} value={draft.guest_share_pct} onChange={(e) => setDraft({ ...draft, guest_share_pct: num(e.target.value) })} /></Field>
      </div>
      <div>
        <Button variant="primary" onClick={save} disabled={busy} data-save-support-assistant>{w(S.saSave)}</Button>
      </div>
      {message ? <p className={`text-sm ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}
    </div>
  );
}
