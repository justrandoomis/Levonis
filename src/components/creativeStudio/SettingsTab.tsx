/**
 * «الإعدادات» — the AI provider, for the owner (spec §27, §29).
 *
 * THE KEY. Typed into a password field (autocomplete off), sent once in the
 * body of PUT /provider/key, sealed by the server, and CLEARED from the field
 * the moment the server confirms. It is never put in localStorage,
 * sessionStorage, IndexedDB, a cookie, the URL or a log; the server answers
 * with a 4-character hint only (tests/creativeStudioUiSource.test.ts holds
 * this file to that). The Worker secret ANTHROPIC_API_KEY works without any
 * of this and is shown as the source when it is the one in use.
 *
 * THE MODEL comes from Anthropic’s live list (GET /provider/models), never a
 * name written in the code, and is sent only when the owner changed it — the
 * server checks a model against that live list, which is down while a key is
 * revoked, and the caps must stay savable then (screensModel.settingsPayload).
 * THE OWNER'S PRIORITIES are typed here, one per line, and are what Claude is
 * told the owner prioritises. Costs are ESTIMATES from rates the owner typed,
 * with their source and date. Everyone but the owner reads the status only.
 * There is no «automatic fix rounds» field: the studio has no automatic fix
 * loop, so the setting would control nothing.
 */
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Switch } from '../ui/Switch';
import { StatusChip } from '../ui/Badge';
import type { BudgetSettings, Effort, ModelDto, ProviderStatusDto, Rates, UsageTotals } from '../../../packages/creativeDoc/src/api';
import { provider as providerApi } from './client';
import { EFFORT_TEXT, ERROR_TEXT, JOB_TEXT, S, TASK_TEXT, fill } from './strings';
import { RemoteView, failText, shortTime, useRemote, useStudio, useText } from './shared';
import { settingsPayload } from './screensModel';

export default function SettingsTab() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [status, reload] = useRemote(() => providerApi.status(), []);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4" data-settings-tab>
      <RemoteView remote={status} onRetry={reload}>
        {(s) => <SettingsBody s={s} owner={studio.user.isOwner && s.can_manage} lang={lang} w={w} onChanged={() => { reload(); studio.reloadProvider(); }} />}
      </RemoteView>
    </div>
  );
}

function Totals({ title, t }: { title: string; t: UsageTotals }) {
  const { w } = useText();
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <p className="text-xs text-text-muted">{title}</p>
      <p className="text-sm text-text-primary">{fill(w(S.usageRequests), { n: t.requests })} · {w(S.usageTokens)}: <span dir="ltr">{t.input_tokens + t.output_tokens}</span></p>
      {t.est_cost_usd !== null ? <p className="text-xs text-text-secondary" dir="ltr">≈ ${t.est_cost_usd.toFixed(2)} ({w(S.aiEstimated)})</p> : null}
    </div>
  );
}

function SettingsBody({ s, owner, lang, w, onChanged }: { s: ProviderStatusDto; owner: boolean; lang: ReturnType<typeof useText>['lang']; w: ReturnType<typeof useText>['w']; onChanged(): void }) {
  const [key, setKey] = useState('');
  const [models, setModels] = useState<ModelDto[] | null>(null);
  const [model, setModel] = useState(s.model ?? '');
  const [effort, setEffort] = useState<Effort | ''>(s.effort ?? '');
  const [budget, setBudget] = useState<BudgetSettings>(s.budget);
  const [rates, setRates] = useState<Rates | null>(s.rates);
  const [vision, setVision] = useState(s.vision_review);
  const [priorities, setPriorities] = useState((s.priorities ?? []).join('\n'));
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [usage, reloadUsage] = useRemote(() => providerApi.usage(), []);
  useEffect(() => {
    setModel(s.model ?? '');
    setEffort(s.effort ?? '');
    setBudget(s.budget);
    setRates(s.rates);
    setVision(s.vision_review);
    setPriorities((s.priorities ?? []).join('\n'));
  }, [s]);

  const say = (tone: 'ok' | 'error', text: string) => setMessage({ tone, text });

  const saveKey = async () => {
    setMessage(null);
    try {
      await providerApi.saveKey(key.trim());
      // The key leaves the page’s memory as soon as the server has it.
      setKey('');
      say('ok', w(S.setKeySaved));
      onChanged();
    } catch (e) {
      say('error', failText(e, lang));
    }
  };
  const removeKey = async () => {
    setMessage(null);
    try {
      await providerApi.removeKey();
      say('ok', w(S.setKeyRemoved));
      onChanged();
    } catch (e) {
      say('error', failText(e, lang));
    }
  };
  const test = async () => {
    setMessage(null);
    try {
      await providerApi.test();
    } catch (e) {
      say('error', failText(e, lang));
    } finally {
      onChanged();
    }
  };
  const loadModels = async () => {
    setMessage(null);
    try {
      setModels(await providerApi.models());
    } catch (e) {
      say('error', failText(e, lang));
    }
  };
  const saveSettings = async () => {
    setMessage(null);
    try {
      await providerApi.saveSettings(settingsPayload(s, { model, effort, budget, rates, vision, priorities }));
      say('ok', w(S.setSaved));
      onChanged();
    } catch (e) {
      say('error', failText(e, lang));
    }
  };

  const keySource = s.key.source === 'stored' ? fill(w(S.setKeySourceStored), { hint: s.key.hint ?? '' }) : s.key.source === 'worker_secret' ? w(S.setKeySourceWorker) : w(S.setKeySourceNone);
  const cap = (v: boolean | null) => (v === null ? w(S.capUnknown) : v ? w(S.yes) : w(S.no));
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v));
  const notReady = s.not_ready_code && s.not_ready_code in ERROR_TEXT ? w(ERROR_TEXT[s.not_ready_code]) : s.not_ready_code;

  return (
    <>
      {!owner ? <p className="text-sm text-text-muted" role="status">{w(S.setReadOnly)}</p> : null}
      <Card title={w(S.setProvider)} action={<StatusChip tone={s.ready ? 'success' : 'warning'}>{s.ready ? w(S.setReady) : w(S.aiNotReady)}</StatusChip>}>
        {!s.ready && notReady ? <p className="mb-3 text-sm text-text-secondary">{notReady}</p> : null}
        <p className="text-sm text-text-primary" data-key-source={s.key.source}>{keySource}{s.key.set_at ? ` · ${shortTime(s.key.set_at, lang)}` : ''}</p>
        {s.last_test ? (
          <p className={`mt-1 text-sm ${s.last_test.ok ? 'text-success' : 'text-danger'}`}>
            {s.last_test.ok ? fill(w(S.setTestOk), { time: shortTime(s.last_test.at, lang) }) : fill(w(S.setTestFailed), { time: shortTime(s.last_test.at, lang), code: s.last_test.code && s.last_test.code in ERROR_TEXT ? w(ERROR_TEXT[s.last_test.code as keyof typeof ERROR_TEXT]) : s.last_test.code ?? '' })}
          </p>
        ) : <p className="mt-1 text-sm text-text-muted">{w(S.setTestNever)}</p>}
        {owner ? (
          <div className="mt-4 flex flex-col gap-3">
            {!s.encryption_ready ? <p className="text-sm text-warning">{w(S.setEncryptionMissing)}</p> : null}
            <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void saveKey(); }} autoComplete="off">
              <Field label={w(S.setKey)} hint={w(S.setKeyHint)}>
                <Input type="password" autoComplete="off" spellCheck={false} ltr value={key} onChange={(e) => setKey(e.target.value)} data-api-key-input disabled={!s.encryption_ready} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={!key.trim() || !s.encryption_ready}>{w(S.setKeySave)}</Button>
                {s.key.source === 'stored' ? <Button variant="danger" onClick={removeKey}>{w(S.setKeyRemove)}</Button> : null}
                <Button onClick={test} disabled={s.key.source === 'none'}>{w(S.setTest)}</Button>
              </div>
            </form>
          </div>
        ) : null}
      </Card>

      <Card title={w(S.setModel)}>
        <p className="text-sm text-text-primary" dir="ltr">{s.model ?? w(S.setModelNone)}</p>
        <p className="mt-1 text-xs text-text-muted">{w(S.setCapabilities)}: {w(S.capStructured)} {cap(s.capabilities.structured_outputs)} · {w(S.capVision)} {cap(s.capabilities.vision)} · {w(S.capEffort)} {cap(s.capabilities.effort)}</p>
        {owner ? (
          <div className="mt-3 flex flex-col gap-3">
            <Button size="sm" onClick={loadModels} disabled={s.key.source === 'none'}>{w(S.setModelLoad)}</Button>
            {models ? (
              <Field label={w(S.setModelPick)}>
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">{w(S.setModelNone)}</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.display_name} ({m.id})</option>)}
                </Select>
              </Field>
            ) : null}
            <Field label={w(S.setEffort)}>
              <Select value={effort} onChange={(e) => setEffort(e.target.value as Effort | '')}>
                <option value="">—</option>
                {(['low', 'medium', 'high'] as const).map((x) => <option key={x} value={x}>{w(EFFORT_TEXT[x])}</option>)}
              </Select>
            </Field>
          </div>
        ) : null}
      </Card>

      <Card title={w(S.setBudget)}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Totals title={w(S.setToday)} t={s.today} />
          <Totals title={w(S.setMonth)} t={s.month} />
        </div>
        <fieldset disabled={!owner} className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label={w(S.setDailyRequests)}><Input type="number" ltr min={0} value={budget.daily_requests} onChange={(e) => setBudget({ ...budget, daily_requests: num(e.target.value) })} /></Field>
          <Field label={w(S.setDailyTokens)}><Input type="number" ltr min={0} value={budget.daily_tokens} onChange={(e) => setBudget({ ...budget, daily_tokens: num(e.target.value) })} /></Field>
          <Field label={w(S.setMaxParallel)}><Input type="number" ltr min={1} value={budget.max_parallel} onChange={(e) => setBudget({ ...budget, max_parallel: num(e.target.value) })} /></Field>
          <Field label={w(S.setDailyUsd)}><Input type="number" ltr min={0} step="0.01" value={budget.daily_usd ?? ''} onChange={(e) => setBudget({ ...budget, daily_usd: e.target.value === '' ? null : num(e.target.value) })} /></Field>
          <Field label={w(S.setMonthlyUsd)}><Input type="number" ltr min={0} step="0.01" value={budget.monthly_usd ?? ''} onChange={(e) => setBudget({ ...budget, monthly_usd: e.target.value === '' ? null : num(e.target.value) })} /></Field>
        </fieldset>
      </Card>

      <Card title={w(S.setRates)} description={w(S.setRatesNote)}>
        <fieldset disabled={!owner} className="flex flex-col gap-3">
          <Switch checked={rates === null} onChange={(none) => setRates(none ? null : { input_per_mtok_usd: 0, output_per_mtok_usd: 0, source: '', as_of: new Date().toISOString().slice(0, 10) })} label={w(S.setRatesClear)} />
          {rates ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={w(S.setRateIn)}><Input type="number" ltr min={0} step="0.01" value={rates.input_per_mtok_usd} onChange={(e) => setRates({ ...rates, input_per_mtok_usd: num(e.target.value) })} /></Field>
              <Field label={w(S.setRateOut)}><Input type="number" ltr min={0} step="0.01" value={rates.output_per_mtok_usd} onChange={(e) => setRates({ ...rates, output_per_mtok_usd: num(e.target.value) })} /></Field>
              <Field label={w(S.setRateSource)}><Input value={rates.source} maxLength={200} onChange={(e) => setRates({ ...rates, source: e.target.value })} /></Field>
              <Field label={w(S.setRateDate)}><Input type="date" ltr value={rates.as_of} onChange={(e) => setRates({ ...rates, as_of: e.target.value })} /></Field>
            </div>
          ) : null}
          <Switch checked={vision} onChange={setVision} label={w(S.setVision)} description={w(S.setVisionHint)} disabled={!owner} />
        </fieldset>
      </Card>

      <Card title={w(S.setPriorities)}>
        <fieldset disabled={!owner}>
          <Field label={w(S.setPriorities)} hint={w(S.setPrioritiesHint)}>
            <Textarea rows={3} value={priorities} onChange={(e) => setPriorities(e.target.value)} data-owner-priorities />
          </Field>
        </fieldset>
        {owner ? <Button className="mt-3" variant="primary" onClick={saveSettings} data-save-settings>{w(S.setSaveSettings)}</Button> : null}
      </Card>

      {message ? <p className={`text-sm ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'} data-settings-message>{message.text}</p> : null}

      <Card title={w(S.setUsage)}>
        <RemoteView remote={usage} onRetry={reloadUsage} compact>
          {(rows) => rows.length === 0 ? <p className="text-sm text-text-muted">{w(S.setUsageEmpty)}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-xs text-text-muted">
                    <th className="p-1 text-start">{w(S.usageWhen)}</th>
                    <th className="p-1 text-start">{w(S.usageTask)}</th>
                    <th className="p-1 text-start">{w(S.usageStatus)}</th>
                    <th className="p-1 text-start">{w(S.usageTokens)}</th>
                    <th className="p-1 text-start">{w(S.usageCost)}</th>
                    <th className="p-1 text-start">{w(S.usageWho)}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-border-subtle">
                      <td className="p-1">{shortTime(r.created_at, lang)}</td>
                      <td className="p-1">{w(TASK_TEXT[r.task])}</td>
                      <td className="p-1">{w(JOB_TEXT[r.status])}{r.error_code && r.error_code in ERROR_TEXT ? ` — ${w(ERROR_TEXT[r.error_code as keyof typeof ERROR_TEXT])}` : ''}</td>
                      <td className="p-1" dir="ltr">{(r.input_tokens ?? 0) + (r.output_tokens ?? 0)}</td>
                      <td className="p-1" dir="ltr">{r.est_cost_usd !== null ? `≈ $${r.est_cost_usd.toFixed(4)}` : '—'}</td>
                      <td className="p-1">{r.actor_name ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </RemoteView>
      </Card>

      <Card title={w(S.capabilitiesNotConnected)}>
        <p className="text-sm text-text-secondary">{w(S.capabilitiesNote)}</p>
      </Card>
    </>
  );
}
