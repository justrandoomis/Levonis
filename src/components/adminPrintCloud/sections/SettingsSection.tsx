/**
 * SETTINGS — every key of the Print Cloud configuration (settings.ts), one
 * versioned row edited with `PATCH /settings { version, config }`.
 *
 * ONLY THE CHANGED KEYS TRAVEL. The server merges a patch key by key at every
 * level — one failure-policy party, one delivery value, one governorate fee
 * (a fee set to null removes that governorate) — and replaces the import
 * providers whole; so the form sends exactly what the admin changed, and
 * nothing it merely displayed.
 *
 * OPTIMISTIC VERSION. The save names the version it read; if someone saved in
 * between, the server answers STATE_CHANGED and nothing was written. The form
 * then reloads the stored settings and says which keys the admin had changed,
 * so they can apply them again on top of what is there now — it never
 * re-sends a draft over a newer save.
 *
 * WHO. Changing settings is a money act (`requireFinancialScope`); the cost
 * key is the owner's (`COST_SETTING_KEYS`) and is not even drawn for a reader
 * who may not see it. Opening or closing the service is the owner's switch,
 * asked twice, in its own request.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Power, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Switch } from '../../ui/Switch';
import { StatusChip } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { GOVERNORATES } from '../../../lib/governorates';
import { ApiError } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { usePcAccess } from '../access';
import { pc, type ImportProvider, type PrintCloudConfig, type SettingsAnswer } from '../api';
import { pick, tri, type Tri } from '../i18n';
import { bytesCount, duration, megabytes, num } from '../format';
import { pcRefusal } from '../refusal';
import {
  GOVERNORATE_KEY_RE,
  HOST_RE,
  HTTPS_URL_RE,
  MAX_GOVERNORATE_FEES,
  MAX_PROVIDERS,
  MODEL_UPLOAD_CEILING_BYTES,
  PROVIDER_ID_RE,
  SETTING_FIELDS,
  SETTING_GROUPS,
  UNIT_LABEL,
  type SettingField,
} from '../settingsFields';
import { Act, IntField, LoadState, Note, RefreshButton, SectionHead, SelectField, T, TextField, Tray, W, useLoad, usePcLang } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('الإعدادات', 'Settings', 'ڕێکخستنەکان'),
  desc: tri(
    'قواعد الخدمة كلها في مكان واحد؛ يُحفظ ما غيّرته فقط، والخادم يرفض أي قيمة خارج حدودها.',
    'Every rule of the service in one place; only what you changed is saved, and the server refuses any value out of its range.',
    'هەموو یاساکانی خزمەتگوزاری لە یەک شوێن؛ تەنها ئەوەی گۆڕیت پاشەکەوت دەکرێت، و ڕاژەکار هەر بەهایەک لە دەرەوەی سنوورەکەی ڕەتدەکاتەوە.'
  ),
  version: tri('الإصدار', 'Version', 'وەشان'),
  readOnly: tri(
    'للقراءة فقط: تغيير الإعدادات للمالك أو المدير المالي.',
    'Read only: changing settings is for the owner or a full admin.',
    'تەنها خوێندنەوە: گۆڕینی ڕێکخستنەکان بۆ خاوەن یان بەڕێوەبەری داراییە.'
  ),
  open: tri('مفتوحة للعملاء', 'Open to customers', 'بۆ کڕیاران کراوەیە'),
  closed: tri('مغلقة للعملاء', 'Closed to customers', 'بۆ کڕیاران داخراوە'),
  openIt: tri('فتح الخدمة', 'Open the service', 'کردنەوەی خزمەتگوزاری'),
  closeIt: tri('إغلاق الخدمة', 'Close the service', 'داخستنی خزمەتگوزاری'),
  ownerSwitch: tri('فتح الخدمة وإغلاقها للمالك وحده.', 'Only the owner opens or closes the service.', 'تەنها خاوەن خزمەتگوزاری دەکاتەوە یان دایدەخات.'),
  openTitle: tri('فتح الطباعة السحابية للعملاء؟', 'Open Print Cloud to customers?', 'چاپی هەوری بۆ کڕیاران بکرێتەوە؟'),
  openBody: tri(
    'سيتمكن العملاء فوراً من شراء الساعات والمواد بأسعار الكتالوج الحالية، ورفع النماذج، وإرسال مهام تُطبع على طابعات الورشة الحقيقية. تأكّد أن الكتالوج والأسعار والمخزون جاهزة قبل الفتح.',
    'Customers will at once be able to buy hours and material at the catalogue’s current prices, upload models, and send jobs that print on the workshop’s real printers. Make sure the catalogue, prices and stock are ready first.',
    'کڕیاران یەکسەر دەتوانن کاتژمێر و کەرەستە بە نرخەکانی ئێستای کاتالۆگ بکڕن، مۆدێل بار بکەن، و کار بنێرن کە لەسەر چاپکەرە ڕاستەقینەکانی کارگە چاپ دەکرێن. پێشتر دڵنیابە کە کاتالۆگ و نرخ و کۆگا ئامادەن.'
  ),
  closeTitle: tri('إغلاق الطباعة السحابية أمام العملاء؟', 'Close Print Cloud to customers?', 'چاپی هەوری لە ڕووی کڕیاران دابخرێت؟'),
  closeBody: tri(
    'ستجيب كل أبواب العملاء «غير مفتوحة بعد»: لا شراء ولا مهام جديدة. ما دُفع يبقى لأصحابه، وهذه اللوحة تبقى تعمل للورشة.',
    'Every customer door will answer “not open yet”: no purchases and no new jobs. What was paid stays its owners’, and this console keeps working for the workshop.',
    'هەموو دەرگاکانی کڕیار دەڵێن «هێشتا نەکراوەتەوە»: نە کڕین و نە کاری نوێ. ئەوەی پارەی دراوە هی خاوەنەکانی دەمێنێتەوە، و ئەم داشبۆردە بۆ کارگە کار دەکات.'
  ),
  opened: tri('الخدمة مفتوحة الآن للعملاء.', 'The service is now open to customers.', 'خزمەتگوزاری ئێستا بۆ کڕیاران کراوەیە.'),
  closedNow: tri('الخدمة مغلقة الآن أمام العملاء.', 'The service is now closed to customers.', 'خزمەتگوزاری ئێستا لە ڕووی کڕیاران داخراوە.'),
  save: tri('حفظ التغييرات', 'Save changes', 'پاشەکەوتکردنی گۆڕانکارییەکان'),
  discard: tri('تجاهل التغييرات', 'Discard changes', 'وازهێنان لە گۆڕانکارییەکان'),
  changed: tri('تغييرات غير محفوظة', 'unsaved changes', 'گۆڕانکاریی پاشەکەوت نەکراو'),
  saved: tri('حُفظت الإعدادات — الإصدار', 'Settings saved — version', 'ڕێکخستنەکان پاشەکەوت کران — وەشان'),
  nothing: tri('لا تغيير لحفظه.', 'Nothing changed to save.', 'هیچ گۆڕانکارییەک نییە بۆ پاشەکەوت.'),
  invalid: tri('صحّح الحقول المعلَّمة أولاً.', 'Correct the marked fields first.', 'سەرەتا خانە نیشانەکراوەکان ڕاست بکەرەوە.'),
  conflict: tri(
    'غيّر شخص آخر الإعدادات قبلك، فلم يُحفظ شيء. أُعيد تحميل القيم الحالية؛ أعد تطبيق ما غيّرته:',
    'Someone else saved the settings first, so nothing was saved. The current values were reloaded; apply your changes again:',
    'کەسێکی تر پێشتر ڕێکخستنەکانی پاشەکەوت کرد، بۆیە هیچ پاشەکەوت نەکرا. بەها ئێستاییەکان بارکرانەوە؛ گۆڕانکارییەکانت دووبارە جێبەجێ بکەرەوە:'
  ),
  outOfRange: tri('خارج الحدود', 'Out of range', 'لە دەرەوەی سنوورە'),
  range: tri('المسموح', 'Allowed', 'ڕێگەپێدراو'),
  on: tri('مفعّل', 'On', 'هەڵکراو'),
  off: tri('متوقف', 'Off', 'کوژاوە'),
  addGov: tri('إضافة محافظة', 'Add a governorate', 'زیادکردنی پارێزگا'),
  noGov: tri('لا رسوم خاصة بمحافظة: الرسوم الثابتة على الجميع.', 'No governorate-specific fees: the flat fee applies everywhere.', 'هیچ کرێیەکی تایبەت بە پارێزگا نییە: کرێی جێگیر بۆ هەمووانە.'),
  remove: tri('حذف', 'Remove', 'سڕینەوە'),
  provider: tri('المزوّد', 'Provider', 'دابینکەر'),
  providerId: tri('معرّف المزوّد', 'Provider id', 'ناسنامەی دابینکەر'),
  hosts: tri('النطاقات المقبولة (مفصولة بفواصل)', 'Accepted hosts (comma-separated)', 'دۆمەینە وەرگیراوەکان (بە کۆما جیاکراونەتەوە)'),
  apiUrl: tri('رابط واجهة المزوّد (https، ‏{id} يُستبدل)', 'Provider API URL (https, {id} is substituted)', 'بەستەری API-ی دابینکەر (https، ‏{id} دەگۆڕدرێت)'),
  downloadHosts: tri('نطاقات التنزيل المرخّص (فارغة = لا تنزيل)', 'Licensed download hosts (empty = never download)', 'دۆمەینەکانی داگرتنی مۆڵەتدار (بەتاڵ = هەرگیز دانابەزێنرێت)'),
  providerOn: tri('مفعّل', 'Enabled', 'چالاک'),
  addProvider: tri('إضافة مزوّد', 'Add a provider', 'زیادکردنی دابینکەر'),
  badHosts: tri('نطاقات غير صالحة', 'Invalid hosts', 'دۆمەینی نادروست'),
  badId: tri('معرّف غير صالح (a-z و0-9 و- و_، من 2 إلى 40)', 'Invalid id (a-z, 0-9, - and _, 2 to 40)', 'ناسنامەی نادروست (a-z و 0-9 و - و _، لە 2 تا 40)'),
  dupId: tri('معرّف مكرر', 'Duplicate id', 'ناسنامەی دووبارە'),
  badUrl: tri('رابط https فقط، أو فارغ', 'An https link only, or empty', 'تەنها بەستەری https، یان بەتاڵ'),
  needHost: tri('نطاق صالح واحد على الأقل', 'At least one valid host', 'لانیکەم یەک دۆمەینی دروست'),
  mb: tri('بالميغابايت', 'In megabytes', 'بە مێگابایت'),
  bytesNow: tri('بالبايت', 'in bytes', 'بە بایت'),
  costHidden: tri('التكلفة للمالك وحده.', 'Cost is the owner’s alone.', 'تێچوو تەنها هی خاوەنە.'),
} satisfies Record<string, Tri>;

type Draft = PrintCloudConfig;

/** A dotted path's value. */
function at(cfg: Draft, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), cfg);
}

function setAt(cfg: Draft, path: string, value: unknown): Draft {
  const [head, sub] = path.split('.');
  if (!sub) return { ...cfg, [head]: value } as Draft;
  return { ...cfg, [head]: { ...(cfg as unknown as Record<string, Record<string, unknown>>)[head], [sub]: value } } as Draft;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The patch: changed keys only, nested keys one by one, removed governorate
 * fees as null, the providers whole. `enabled` never rides with it — it is
 * the owner's switch, sent on its own.
 */
export function settingsPatch(saved: Draft, draft: Draft, includeCost: boolean): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of SETTING_FIELDS) {
    if (f.path === 'enabled' || f.path.includes('.') || f.kind === 'providers') continue;
    if (f.cost && !includeCost) continue;
    if (!same(at(saved, f.path), at(draft, f.path))) patch[f.path] = at(draft, f.path);
  }
  const fp: Record<string, unknown> = {};
  for (const k of Object.keys(draft.failure_policy)) if (draft.failure_policy[k] !== saved.failure_policy[k]) fp[k] = draft.failure_policy[k];
  if (Object.keys(fp).length) patch.failure_policy = fp;
  const del: Record<string, unknown> = {};
  for (const k of ['enabled', 'pickup_enabled', 'flat_fee_iqd'] as const) if (draft.delivery[k] !== saved.delivery[k]) del[k] = draft.delivery[k];
  const fees: Record<string, number | null> = {};
  for (const [g, fee] of Object.entries(draft.delivery.fee_by_governorate)) if (saved.delivery.fee_by_governorate[g] !== fee) fees[g] = fee;
  for (const g of Object.keys(saved.delivery.fee_by_governorate)) if (!(g in draft.delivery.fee_by_governorate)) fees[g] = null;
  if (Object.keys(fees).length) del.fee_by_governorate = fees;
  if (Object.keys(del).length) patch.delivery = del;
  if (!same(saved.import_providers, draft.import_providers)) patch.import_providers = draft.import_providers;
  return patch;
}

/** What the form refuses before the server would: one message per path. */
function validate(draft: Draft, lang: 'ar' | 'en' | 'ckb'): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of SETTING_FIELDS) {
    if (f.kind !== 'int') continue;
    const v = at(draft, f.path);
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) {
      if (v === undefined && f.cost) continue;
      errors[f.path] = `${pick(S.outOfRange, lang)} — ${pick(S.range, lang)}: ${num(f.min)}–${num(f.max)}`;
    }
  }
  const fees = draft.delivery.fee_by_governorate;
  if (Object.keys(fees).length > MAX_GOVERNORATE_FEES) errors['delivery.fee_by_governorate'] = pick(S.outOfRange, lang);
  for (const [g, fee] of Object.entries(fees)) {
    if (!GOVERNORATE_KEY_RE.test(g) || !Number.isSafeInteger(fee) || fee < 0 || fee > 1_000_000) errors[`fee.${g}`] = `${pick(S.outOfRange, lang)} — 0–1,000,000`;
  }
  if (draft.import_providers.length > MAX_PROVIDERS) errors.import_providers = pick(S.outOfRange, lang);
  const ids = new Set<string>();
  draft.import_providers.forEach((p, i) => {
    if (!PROVIDER_ID_RE.test(p.id)) errors[`provider.${i}.id`] = pick(S.badId, lang);
    else if (ids.has(p.id)) errors[`provider.${i}.id`] = pick(S.dupId, lang);
    ids.add(p.id);
    if (!p.hosts.length) errors[`provider.${i}.hosts`] = pick(S.needHost, lang);
    else if (p.hosts.some((h) => !HOST_RE.test(h))) errors[`provider.${i}.hosts`] = pick(S.badHosts, lang);
    if (p.api_url && !HTTPS_URL_RE.test(p.api_url)) errors[`provider.${i}.api_url`] = pick(S.badUrl, lang);
    if (p.download_hosts.some((h) => !HOST_RE.test(h))) errors[`provider.${i}.download_hosts`] = pick(S.badHosts, lang);
  });
  return errors;
}

const hostsText = (hosts: string[]) => hosts.join(', ');
const hostsOf = (text: string) => text.split(/[\s,،]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);

export default function SettingsSection({ onSaved }: SectionProps & { onSaved: () => void }) {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const settings = useLoad(() => pc.get<SettingsAnswer>('/settings'), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState<null | boolean>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const saved = settings.data?.config ?? null;
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const canEdit = access.money;
  const includeCost = access.costWrite && saved?.cost_electricity_iqd_per_kwh !== undefined;
  const patch = useMemo(() => (saved && draft ? settingsPatch(saved, draft, includeCost) : {}), [saved, draft, includeCost]);
  const dirty = Object.keys(patch).length > 0;
  const errors = useMemo(() => (draft ? validate(draft, lang) : {}), [draft, lang]);

  const change = (path: string, value: unknown) => {
    setFailure(null);
    setDraft((d) => (d ? setAt(d, path, value) : d));
  };

  const save = async () => {
    if (!settings.data || !draft) return;
    setFailure(null);
    setConflict(null);
    if (!dirty) {
      setFailure(t(S.nothing));
      return;
    }
    if (Object.keys(errors).length) {
      setFailure(t(S.invalid));
      return;
    }
    try {
      const out = await pc.patch<SettingsAnswer>('/settings', { version: settings.data.version, config: patch });
      settings.setData(out);
      toast.success(`${t(S.saved)} ${out.version}`);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STATE_CHANGED') {
        // Nothing was written. Show what is stored now, and what the admin had changed.
        setConflict(Object.keys(patch));
        await settings.reload();
        return;
      }
      setFailure(pcRefusal(e, lang, t(W.failed), (field) => labelOfPath(field, lang)));
    }
  };

  const flipService = async (open: boolean) => {
    if (!settings.data) return;
    setSwitchError(null);
    try {
      const out = await pc.patch<SettingsAnswer>('/settings', { version: settings.data.version, config: { enabled: open } });
      settings.setData(out);
      setAsking(null);
      toast.success(t(open ? S.opened : S.closedNow));
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STATE_CHANGED') void settings.reload();
      setSwitchError(pcRefusal(e, lang, t(W.failed)));
    }
  };

  return (
    <div className="space-y-4">
      <SectionHead
        title={t(S.title)}
        description={t(S.desc)}
        actions={
          <>
            {settings.data && (
              <StatusChip tone="neutral">
                {t(S.version)} <bdi dir="ltr">{settings.data.version}</bdi>
              </StatusChip>
            )}
            <RefreshButton onClick={() => settings.reload()} loading={settings.loading} />
          </>
        }
      />
      {!canEdit && <Note tone="info">{t(S.readOnly)}</Note>}
      {conflict && (
        <Note tone="warning">
          {t(S.conflict)} <bdi dir="ltr" className="font-mono">{conflict.join(', ')}</bdi>
        </Note>
      )}

      <LoadState state={settings}>
        {(answer) =>
          draft && (
            <div className="space-y-4">
              {/* THE OWNER'S SWITCH, on its own: never saved by accident with the rest. */}
              <Tray title={pick(SETTING_GROUPS[0].label, lang)}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <StatusChip tone={answer.config.enabled ? 'success' : 'warning'}>{t(answer.config.enabled ? S.open : S.closed)}</StatusChip>
                    <p className={`text-[12px] leading-relaxed ${T.text3}`}>{pick(SETTING_GROUPS[0].fields[0].help, lang)}</p>
                  </div>
                  {access.owner && access.money ? (
                    <Act kind={answer.config.enabled ? 'danger' : 'primary'} icon={<Power size={14} aria-hidden />} onClick={() => setAsking(!answer.config.enabled)}>
                      {t(answer.config.enabled ? S.closeIt : S.openIt)}
                    </Act>
                  ) : (
                    <span className={`text-[12px] ${T.text3}`}>{t(S.ownerSwitch)}</span>
                  )}
                </div>
              </Tray>

              {SETTING_GROUPS.slice(1).map((group) => {
                const fields = group.fields.filter((f) => !f.cost || (access.costRead && at(draft, f.path) !== undefined));
                if (!fields.length) return null;
                return (
                  <Tray key={group.id} title={pick(group.label, lang)}>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {fields.map((f) => (
                        <SettingInput
                          key={f.path}
                          field={f}
                          draft={draft}
                          errors={errors}
                          disabled={!canEdit || (!!f.cost && !access.costWrite)}
                          onChange={change}
                        />
                      ))}
                    </div>
                  </Tray>
                );
              })}

              {canEdit && (
                <div className="sticky bottom-0 z-[1] flex flex-wrap items-center gap-2 rounded-[var(--ap-radius-lg)] bg-[var(--ap-surface-2)] p-3">
                  <Act kind="primary" onClick={save} disabled={!dirty}>
                    {t(S.save)}
                  </Act>
                  <Act kind="ghost" disabled={!dirty} onClick={() => saved && setDraft(saved)}>
                    {t(S.discard)}
                  </Act>
                  {dirty && <span className={`text-[12px] ${T.text3}`}>{Object.keys(patch).length} · {t(S.changed)}</span>}
                  {failure && <p className="lv-field-error w-full">{failure}</p>}
                </div>
              )}
            </div>
          )
        }
      </LoadState>

      <ConfirmDialog
        open={asking !== null}
        title={t(asking ? S.openTitle : S.closeTitle)}
        consequence={t(asking ? S.openBody : S.closeBody)}
        confirmLabel={t(asking ? S.openIt : S.closeIt)}
        destructive={asking === false}
        error={switchError}
        onCancel={() => {
          setAsking(null);
          setSwitchError(null);
        }}
        onConfirm={() => flipService(!!asking)}
      />
    </div>
  );
}

/** The label of a setting by the path the server named (`delivery.flat_fee_iqd`, `import_providers[0]`). */
function labelOfPath(path: string, lang: 'ar' | 'en' | 'ckb'): string | null {
  const clean = path.replace(/\[\d+\].*$/, '').replace(/^delivery\.fee_by_governorate\..*$/, 'delivery.fee_by_governorate');
  const f = SETTING_FIELDS.find((x) => x.path === clean);
  return f ? pick(f.label, lang) : null;
}

function unitText(f: SettingField, lang: 'ar' | 'en' | 'ckb'): string | undefined {
  return f.unit ? pick(UNIT_LABEL[f.unit], lang) : undefined;
}

function SettingInput({
  field: f,
  draft,
  errors,
  disabled,
  onChange,
}: {
  field: SettingField;
  draft: Draft;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (path: string, value: unknown) => void;
}) {
  const { t, lang } = usePcLang();
  const value = at(draft, f.path);
  const label = pick(f.label, lang);
  const help = f.help ? pick(f.help, lang) : undefined;

  if (f.kind === 'bool') {
    return (
      <div className="md:col-span-2">
        <Switch checked={value === true} onChange={(v) => onChange(f.path, v)} label={label} description={help} disabled={disabled} />
      </div>
    );
  }
  if (f.kind === 'enum') {
    return (
      <SelectField
        label={label}
        hint={help}
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(v) => onChange(f.path, v)}
        options={(f.values ?? []).map((v) => ({ value: v, label: f.valueLabels?.[v] ? pick(f.valueLabels[v], lang) : v }))}
      />
    );
  }
  if (f.kind === 'int' && f.unit === 'bytes') {
    return <BytesInput field={f} value={Number(value)} disabled={disabled} error={errors[f.path]} onChange={(v) => onChange(f.path, v)} />;
  }
  if (f.kind === 'int') {
    const n = typeof value === 'number' ? value : null;
    const preview =
      f.unit === 'minutes' && n !== null ? duration(n * 60, lang) : f.unit === 'iqd' && n !== null ? <Money iqd={n} /> : null;
    return (
      <IntField
        label={label}
        unit={unitText(f, lang)}
        value={n}
        disabled={disabled}
        error={errors[f.path]}
        hint={
          <>
            {help && <span>{help} · </span>}
            <span>
              {t(S.range)}: <bdi dir="ltr">{num(f.min)}–{num(f.max)}</bdi>
            </span>
            {preview && <span> · {preview}</span>}
          </>
        }
        onChange={(v) => onChange(f.path, v ?? Number.NaN)}
      />
    );
  }
  if (f.kind === 'governorate_fees') return <GovernorateFees field={f} draft={draft} errors={errors} disabled={disabled} onChange={onChange} />;
  if (f.kind === 'providers') return <Providers field={f} draft={draft} errors={errors} disabled={disabled} onChange={onChange} />;
  return null;
}

/** Bytes, typed in megabytes (two decimals) and stored as whole bytes. */
function BytesInput({ field: f, value, disabled, error, onChange }: { field: SettingField; value: number; disabled: boolean; error?: string; onChange: (v: number) => void }) {
  const { t, lang } = usePcLang();
  const [text, setText] = useState(Number.isFinite(value) ? String(Math.round((value / 1048576) * 100) / 100) : '');
  useEffect(() => {
    if (Number.isFinite(value)) setText((cur) => (Math.round(Number(cur) * 1048576) === value ? cur : String(Math.round((value / 1048576) * 100) / 100)));
  }, [value]);
  return (
    <TextField
      label={`${pick(f.label, lang)} (${pick(UNIT_LABEL.bytes, lang)})`}
      value={text}
      ltr
      inputMode="decimal"
      disabled={disabled}
      error={error}
      hint={
        <>
          {f.help && <span>{pick(f.help, lang)} · </span>}
          <bdi>
            {megabytes(value, lang)} = {bytesCount(value, lang)} · {t(S.range)} {num(f.min)}–{bytesCount(MODEL_UPLOAD_CEILING_BYTES, lang)}
          </bdi>
        </>
      }
      onChange={(raw) => {
        const cleaned = raw.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
        setText(cleaned);
        const mb = Number(cleaned);
        onChange(cleaned === '' || !Number.isFinite(mb) ? Number.NaN : Math.round(mb * 1048576));
      }}
    />
  );
}

function GovernorateFees({ field: f, draft, errors, disabled, onChange }: { field: SettingField; draft: Draft; errors: Record<string, string>; disabled: boolean; onChange: (path: string, value: unknown) => void }) {
  const { t, lang } = usePcLang();
  const fees = draft.delivery.fee_by_governorate;
  const used = Object.keys(fees);
  const free = GOVERNORATES.filter((g) => !used.includes(g.id));
  const nameOf = (id: string) => {
    const g = GOVERNORATES.find((x) => x.id === id);
    return g ? g[lang] : id;
  };
  const write = (next: Record<string, number>) => onChange('delivery.fee_by_governorate', next);
  return (
    <div className="space-y-2 md:col-span-2">
      <p className={`text-[12px] font-semibold ${T.text2}`}>{pick(f.label, lang)}</p>
      {f.help && <p className={`text-[11px] ${T.text3}`}>{pick(f.help, lang)}</p>}
      {used.length === 0 && <p className={`text-[12.5px] ${T.text3}`}>{t(S.noGov)}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {used.map((g) => (
          <div key={g} className="flex items-end gap-2">
            <IntField
              className="flex-1"
              label={nameOf(g)}
              unit={pick(UNIT_LABEL.iqd, lang)}
              value={Number.isFinite(fees[g]) ? fees[g] : null}
              disabled={disabled}
              error={errors[`fee.${g}`]}
              onChange={(v) => write({ ...fees, [g]: v ?? Number.NaN })}
            />
            {!disabled && (
              <button type="button" className={T.btnIconDanger} aria-label={`${t(S.remove)}: ${nameOf(g)}`} onClick={() => write(Object.fromEntries(Object.entries(fees).filter(([k]) => k !== g)))}>
                <Trash2 size={14} aria-hidden />
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && free.length > 0 && used.length < MAX_GOVERNORATE_FEES && (
        <SelectField
          label={t(S.addGov)}
          value=""
          placeholder="—"
          options={free.map((g) => ({ value: g.id, label: g[lang] }))}
          onChange={(id) => id && write({ ...fees, [id]: draft.delivery.flat_fee_iqd })}
        />
      )}
    </div>
  );
}

function Providers({ field: f, draft, errors, disabled, onChange }: { field: SettingField; draft: Draft; errors: Record<string, string>; disabled: boolean; onChange: (path: string, value: unknown) => void }) {
  const { t, lang } = usePcLang();
  const list = draft.import_providers;
  const write = (next: ImportProvider[]) => onChange('import_providers', next);
  const patchAt = (i: number, p: Partial<ImportProvider>) => write(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-3 md:col-span-2">
      {f.help && <p className={`text-[12px] leading-relaxed ${T.text3}`}>{pick(f.help, lang)}</p>}
      {list.map((p, i) => (
        <div key={i} className={`${T.surface} space-y-3 p-3`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={`text-[13px] font-bold ${T.text1}`}>
              {t(S.provider)} <bdi dir="ltr" className="font-mono">{p.id || '—'}</bdi>
            </p>
            {!disabled && (
              <button type="button" className={T.btnIconDanger} aria-label={`${t(S.remove)}: ${p.id}`} onClick={() => write(list.filter((_, j) => j !== i))}>
                <Trash2 size={14} aria-hidden />
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField label={t(S.providerId)} value={p.id} ltr disabled={disabled} error={errors[`provider.${i}.id`]} onChange={(v) => patchAt(i, { id: v.trim().toLowerCase() })} />
            <Switch checked={p.enabled} onChange={(v) => patchAt(i, { enabled: v })} label={t(S.providerOn)} disabled={disabled} />
            <HostsField label={t(S.hosts)} hosts={p.hosts} disabled={disabled} error={errors[`provider.${i}.hosts`]} onChange={(hosts) => patchAt(i, { hosts })} />
            <TextField label={t(S.apiUrl)} value={p.api_url} ltr disabled={disabled} error={errors[`provider.${i}.api_url`]} onChange={(v) => patchAt(i, { api_url: v.trim() })} />
            <HostsField
              className="md:col-span-2"
              label={t(S.downloadHosts)}
              hosts={p.download_hosts}
              disabled={disabled}
              error={errors[`provider.${i}.download_hosts`]}
              onChange={(download_hosts) => patchAt(i, { download_hosts })}
            />
          </div>
        </div>
      ))}
      {!disabled && list.length < MAX_PROVIDERS && (
        <Act icon={<Plus size={14} aria-hidden />} onClick={() => write([...list, { id: '', hosts: [], api_url: '', download_hosts: [], enabled: true }])}>
          {t(S.addProvider)}
        </Act>
      )}
    </div>
  );
}

/**
 * A list of host names typed as text. The box keeps what is typed (a trailing
 * comma is a state on the way to the next host); the list is parsed from it.
 */
function HostsField({ label, hosts, disabled, error, onChange, className }: { label: string; hosts: string[]; disabled: boolean; error?: string; onChange: (hosts: string[]) => void; className?: string }) {
  const [text, setText] = useState(hostsText(hosts));
  useEffect(() => {
    setText((cur) => (same(hostsOf(cur), hosts) ? cur : hostsText(hosts)));
  }, [hosts]);
  return (
    <TextField
      className={className}
      label={label}
      value={text}
      ltr
      disabled={disabled}
      error={error}
      onChange={(v) => {
        setText(v);
        onChange(hostsOf(v));
      }}
    />
  );
}
