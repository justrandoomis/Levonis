/**
 * «خدمات الطابعة» — inside the PRINTER's product edit form (owner, 2026-11-17:
 * «on product edit [printers], not a new setting»; DECISIONS row 339): which
 * warranty family and delivery class this printer (or each of its versions)
 * belongs to, then — folded — the price list every printer shares, the two
 * packages and a preview, and save / publish.
 *
 * Nothing reaches a customer until the OWNER publishes; a draft can be
 * incomplete, a publish cannot (the server lists what blocks it). Prices are
 * whole dinars; an empty box means «not offered», never 0.
 *
 * Saving the draft is the owner's too (the server refuses anyone else): any
 * other admin sees the list read-only. Unsaved edits are reported to the form
 * (`onDirtyChange`), whose leave guard asks before they are lost. When someone
 * else saved first (409), the admin chooses: reload and keep their own edits
 * on top of the fresh copy, or take the fresh copy.
 */
import { useEffect, useMemo, useState } from 'react';
import { useOptionalAuth } from '../../AuthContext';
import { Layers, Save, Send, Power } from 'lucide-react';
import { KitsPanel, MembershipPanel, issueText as extrasIssueText, kitsBlocked } from './PrinterExtrasPanels';
import { CareTermsPanel, InspectionLaborField, careIssueText } from './CareTermsPanel';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, formatIqd } from '../../lib/api';
import {
  DELIVERY_CLASSES,
  WARRANTY_FAMILIES,
  classesFor,
  servicesOffer,
  type DeliveryClass,
  type PrinterServicesConfig,
  type WarrantyFamily,
} from '../../../packages/pricing/src/printerServices';

interface Printer { id: string; slug: string; name: string; status: string; is_used: boolean; versions: Array<{ id: string; name: string }> }
interface State {
  draft: PrinterServicesConfig;
  published: PrinterServicesConfig | null;
  published_at: string | null;
  draft_issues: string[];
  publish_issues: string[];
  printers: Printer[];
}

type Loc = (ar: string, en: string, ckb: string) => string;
const FAMILY_LABEL: Record<WarrantyFamily, string> = { a1: 'A1', xpa2: 'X / P / A2', h2: 'H2', h3c: 'H3C' };
const CLASS_LABEL: Record<DeliveryClass, string> = {
  d1: 'A1 mini · A1', d2: 'A1 Combo · P1S · P2S · X2D · Snapmaker U1', d3: 'A2L', d4: 'H2', d5: 'H3C',
};

/** A server issue in the reader's language: the Care terms' own (phase 3) first, then the rest of the list's. */
const issueText: typeof extrasIssueText = (issue, loc, kits) => {
  const care = careIssueText(issue, loc);
  return care ? { text: care, translated: true } : extrasIssueText(issue, loc, kits);
};

export default function AdminPrinterServices({ productId, onDirtyChange }: { productId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const { loc, dir, lang } = useLanguage() as { loc: Loc; dir: 'rtl' | 'ltr'; lang: string };
  // A server hint, never the gate: the routes refuse a non-owner regardless.
  const isOwner = useOptionalAuth()?.user?.is_owner === true;
  const readOnly = !isOwner;
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<PrinterServicesConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** Someone else saved first: the fresh copy, waiting for the admin's choice. */
  const [stale, setStale] = useState<State | null>(null);
  const [preview, setPreview] = useState<string>(`${productId}|`);

  const fetchState = () => api.get<State & { success: true }>('/api/admin/printer-services');
  const load = async () => {
    const data = await fetchState();
    setState(data);
    setDraft(data.draft);
  };
  useEffect(() => { void load().catch((e) => setMessage(String(e instanceof Error ? e.message : e))); }, []);

  const dirty = !readOnly && !!state && !!draft && JSON.stringify(state.draft) !== JSON.stringify(draft);
  // The form's leave guard asks before unsaved price-list edits are lost.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const act = async (fn: () => Promise<State & { success: true }>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const data = await fn();
      setState((prev) => ({ ...(prev as State), ...data }));
      setDraft(data.draft);
      setStale(null);
      setMessage(ok);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone else changed the list: read the fresh copy, keep these edits until the admin chooses.
        try {
          setStale(await fetchState());
          setMessage(loc(
            'غيّر شخص آخر قائمة الأسعار منذ فتحتها. تعديلاتك لم تُفقد — اختر ما تريد:',
            'Someone else changed the price list since you opened it. Your edits are kept — choose what to do:',
            'کەسێکی تر لیستی نرخەکانی گۆڕیوە لەو کاتەوەی کردتەوە. دەستکارییەکانت ماون — هەڵبژێرە چی بکەیت:'
          ));
        } catch (re) {
          setMessage(re instanceof Error ? re.message : String(re));
        }
      } else if (e instanceof ApiError && (e.code === 'PRINTER_SERVICES_INVALID' || e.code === 'PRINTER_SERVICES_NOT_READY')) {
        // The server lists its issues in English (`…: path: message; …`): each is said in the reader's language.
        const list = e.message.replace(/^[^:]*?: /, '').split('; ').map((i) => issueText(i, loc, draft?.kits ?? []).text);
        setMessage(`${e.code === 'PRINTER_SERVICES_NOT_READY' ? loc('غير جاهزة للنشر', 'Not ready to publish', 'ئامادە نییە بۆ بڵاوکردنەوە') : loc('لم تُحفظ', 'Not saved', 'پاشەکەوت نەکرا')}: ${list.join(' · ')}`);
      } else if (e instanceof ApiError && e.code === 'CARE_POLICY_VERSION_REUSED') {
        // Phase 3: the published version's Care terms are frozen — said by its code, in the reader's language.
        setMessage(apiRefusal(e, refusalLang(lang), e.message));
      } else {
        setMessage(e instanceof ApiError ? `${e.message}` : String(e));
      }
    } finally {
      setBusy(false);
    }
  };
  /** The fresh copy underneath, the admin's edits on top: the next save is fenced by the fresh revision. */
  const keepMine = () => {
    if (!stale || !draft) return;
    setState(stale);
    setDraft({ ...draft, revision: stale.draft.revision });
    setStale(null);
    setMessage(loc('أُعيد التحميل مع إبقاء تعديلاتك — راجعها ثم احفظ.', 'Reloaded with your edits kept — review them, then save.', 'دووبارە بارکرا و دەستکارییەکانت مانەوە — پێداچوونەوەیان بکە و پاشەکەوت بکە.'));
  };
  const takeTheirs = () => {
    if (!stale) return;
    setState(stale);
    setDraft(stale.draft);
    setStale(null);
    setMessage(null);
  };
  const save = () => act(() => api.put('/api/admin/printer-services/draft', { draft, base_revision: state!.draft.revision }), loc('حُفظت المسودة.', 'Draft saved.', 'ڕەشنووس پاشەکەوت کرا.'));
  const publish = () => act(() => api.post('/api/admin/printer-services/publish', { base_revision: state!.draft.revision }), loc('نُشرت للزبائن.', 'Published to customers.', 'بۆ کڕیاران بڵاوکرایەوە.'));
  const unpublish = () => act(() => api.post('/api/admin/printer-services/unpublish', {}), loc('أُوقفت الخدمات.', 'Services switched off.', 'خزمەتگوزارییەکان ڕاگیران.'));

  const offer = useMemo(() => {
    if (!draft || !preview) return null;
    const [pid, ov] = preview.split('|');
    const cls = classesFor(draft, pid, ov ? [ov] : []);
    return cls ? servicesOffer(draft, cls) : null;
  }, [draft, preview]);

  if (!state || !draft) return <p className="p-4 text-sm text-text-secondary">{message ?? loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')}</p>;

  const money = (v: number | null) => (v === null ? '—' : formatIqd(v));
  // The kit editor's own checks (U9): a save the server would refuse is not sent; each problem is said on its kit.
  const kitsHeld = kitsBlocked(draft.kits ?? [], new Set([...state.printers.map((p) => p.id), ...Object.keys(draft.products)]));
  const num = (v: number | null, on: (n: number | null) => void, label: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
      {label}
      <input
        className="lv-input h-10 px-2 tabular-nums"
        inputMode="numeric"
        dir="ltr"
        value={v === null ? '' : String(v)}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d]/g, '');
          on(t === '' ? null : Number(t));
        }}
      />
    </label>
  );
  const upd = (fn: (d: PrinterServicesConfig) => void) => {
    const next = JSON.parse(JSON.stringify(draft)) as PrinterServicesConfig;
    fn(next);
    setDraft(next);
  };
  const mapping = (pid: string) => draft.products[pid] ?? null;
  const setMap = (pid: string, field: 'warranty_family' | 'delivery_class', value: string, ov?: string) => upd((d) => {
    const m = d.products[pid] ?? {};
    if (ov) {
      const by = { ...(m.by_option_value ?? {}) };
      const row = { ...(by[ov] ?? {}) };
      if (value) (row as Record<string, string>)[field] = value; else delete (row as Record<string, string>)[field];
      if (Object.keys(row).length) by[ov] = row; else delete by[ov];
      m.by_option_value = by;
      if (!Object.keys(by).length) delete m.by_option_value;
    } else if (value) (m as Record<string, unknown>)[field] = value;
    else delete (m as Record<string, unknown>)[field];
    if (Object.keys(m).length) d.products[pid] = m; else delete d.products[pid];
  });

  const select = (value: string, options: Array<[string, string]>, on: (v: string) => void, disabled = false, label?: string) => (
    <select className="lv-input h-9 px-2 text-[12px]" value={value} disabled={disabled} aria-label={label} onChange={(e) => on(e.target.value)}>
      <option value="">—</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const famOpts = WARRANTY_FAMILIES.map((f) => [f, FAMILY_LABEL[f]] as [string, string]);
  const clsOpts = DELIVERY_CLASSES.map((c) => [c, CLASS_LABEL[c]] as [string, string]);
  const famLabel = loc('عائلة الضمان', 'Warranty family', 'خێزانی گەرەنتی');
  const clsLabel = loc('فئة التوصيل', 'Delivery class', 'پۆلی گەیاندن');
  const thisPrinter = state.printers.filter((p) => p.id === productId);

  return (
    <div className="mt-5 space-y-4 border-t border-border-subtle pt-5" dir={dir} data-admin-printer-services>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold text-text-primary">
          <Layers aria-hidden="true" className="w-5 h-5" />
          {loc('خدمات الطابعة («خصص طابعتك»)', 'Printer services («Customize your printer»)', 'خزمەتگوزارییەکانی پرینتەر')}
        </h2>
        <p className="text-[12px] text-text-secondary">
          {state.published
            ? loc(`منشورة — الإصدار ${state.published.revision}`, `Published — revision ${state.published.revision}`, `بڵاوکراوە — وەشانی ${state.published.revision}`)
            : loc('غير منشورة: الطابعات تُباع كما كانت', 'Not published: printers sell as before', 'بڵاونەکراوە: پرینتەرەکان وەک پێشوو دەفرۆشرێن')}
        </p>
      </header>

      {readOnly ? (
        <p className="rounded-lg border border-border-subtle p-2 text-[12px] text-text-secondary" data-printer-services-readonly>
          {loc('للعرض فقط: حفظ قائمة أسعار خدمات الطابعة ونشرها للمالك وحده.', 'View only: saving and publishing the printer services price list is the owner\'s alone.', 'تەنها بۆ بینین: پاشەکەوتکردن و بڵاوکردنەوەی لیستی نرخی خزمەتگوزارییەکانی پرینتەر تەنها هی خاوەنەکەیە.')}
        </p>
      ) : null}

      <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-4 border-none p-0">
      <section className="lv-surface p-3">
        <h2 className="mb-2 text-[14px] font-bold text-text-primary">{loc('الطابعات', 'Printers', 'پرینتەرەکان')}</h2>
        {thisPrinter.length === 0 ? (
          <p className="text-[12px] text-text-secondary" data-printer-services-empty>
            {loc(
              'هذا المنتج ليس في قائمة الطابعات بعد: احفظه منشوراً تحت قسم طابعات ثم أعد فتح الصفحة لربطه بعائلة ضمان وفئة توصيل.',
              'This product is not in the printer list yet: save it under a printer section, then reopen this page to give it a warranty family and a delivery class.',
              'ئەم بەرهەمە هێشتا لە لیستی پرینتەرەکاندا نییە: لە بەشێکی پرینتەردا پاشەکەوتی بکە، پاشان ئەم پەڕەیە دووبارە بکەرەوە بۆ دانانی خێزانی گەرەنتی و پۆلی گەیاندن.'
            )}
          </p>
        ) : null}
        <div className="space-y-2">
          {thisPrinter.map((p) => {
            const m = mapping(p.id);
            return (
              <div key={p.id} className="rounded-lg border border-border-subtle p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-[13px] text-text-primary">{p.name}{p.is_used ? ` · ${loc('مستعمل — يبقى بضمانه', 'used — keeps its own warranty', 'بەکارهاتوو')}` : ''}</span>
                  {select(m?.warranty_family ?? '', famOpts, (v) => setMap(p.id, 'warranty_family', v), p.is_used, famLabel)}
                  {select(m?.delivery_class ?? '', clsOpts, (v) => setMap(p.id, 'delivery_class', v), p.is_used, clsLabel)}
                </div>
                {m && p.versions.length > 1 ? (
                  <div className="mt-2 space-y-1 ps-3">
                    {p.versions.map((v) => {
                      const o = m.by_option_value?.[v.id];
                      return (
                        <div key={v.id} className="flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
                          <span className="min-w-0 flex-1">{v.name}</span>
                          {select(o?.warranty_family ?? '', famOpts, (val) => setMap(p.id, 'warranty_family', val, v.id), p.is_used, `${famLabel} · ${v.name}`)}
                          {select(o?.delivery_class ?? '', clsOpts, (val) => setMap(p.id, 'delivery_class', val, v.id), p.is_used, `${clsLabel} · ${v.name}`)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <details className="lv-surface p-3">
        <summary className="cursor-pointer text-[14px] font-bold text-text-primary">{loc('الأسعار والباقات — مشتركة لكل الطابعات', 'Prices and packages — shared by every printer', 'نرخ و پاکێجەکان — هاوبەش بۆ هەموو پرینتەرەکان')}</summary>
      <section className="mt-3 grid gap-3 sm:grid-cols-2">
        <h2 className="text-[14px] font-bold text-text-primary sm:col-span-2">{loc('الأسعار (دينار، الفراغ = غير متوفر)', 'Prices (IQD, empty = not offered)', 'نرخەکان (دینار، بەتاڵ = بەردەست نییە)')}</h2>
        {WARRANTY_FAMILIES.map((f) => (
          <div key={f} className="grid grid-cols-2 gap-2">
            {num(draft.warranty.w12[f], (n) => upd((d) => { d.warranty.w12[f] = n; }), `${loc('ضمان 12 شهر', 'Warranty 12 mo', 'گەرەنتی 12 مانگ')} · ${FAMILY_LABEL[f]}`)}
            {num(draft.warranty.w24[f], (n) => upd((d) => { d.warranty.w24[f] = n; }), `${loc('ضمان 24 شهر', 'Warranty 24 mo', 'گەرەنتی 24 مانگ')} · ${FAMILY_LABEL[f]}`)}
          </div>
        ))}
        {num(draft.care.price_iqd, (n) => upd((d) => { d.care.price_iqd = n; }), 'Levo Care · 12')}
        {num(draft.care.max_discount_pct, (n) => upd((d) => { d.care.max_discount_pct = Math.min(90, n ?? 0); }), loc('أقصى خصم Care %', 'Care max discount %', 'زۆرترین داشکاندنی Care %'))}
        {num(draft.packaging.extra_iqd, (n) => upd((d) => { d.packaging.extra_iqd = n; }), loc('تغليف حماية إضافية', 'Extra packaging', 'پێچانەوەی زیادە'))}
        {num(draft.inspection.price_iqd, (n) => upd((d) => { d.inspection.price_iqd = n; }), loc('الفحص قبل الشحن', 'Pre-dispatch inspection', 'پشکنین پێش ناردن'))}
        <InspectionLaborField draft={draft} upd={upd} loc={loc} />
        {num(draft.academy.recorded_iqd, (n) => upd((d) => { d.academy.recorded_iqd = n; }), loc('فيديوهات مسجلة', 'Recorded videos', 'ڤیدیۆی تۆمارکراو'))}
        {num(draft.academy.live_iqd, (n) => upd((d) => { d.academy.live_iqd = n; }), loc('دورة مباشرة', 'Live course', 'خولی ڕاستەوخۆ'))}
        {DELIVERY_CLASSES.map((c) => (
          <div key={c} className="grid grid-cols-2 gap-2">
            {num(draft.delivery.classes[c].economy_iqd, (n) => upd((d) => { d.delivery.classes[c].economy_iqd = n; }), `${loc('اقتصادي', 'Economy', 'ئابووری')} · ${CLASS_LABEL[c]}`)}
            {num(draft.delivery.classes[c].personal_iqd, (n) => upd((d) => { d.delivery.classes[c].personal_iqd = n; }), `${loc('شخصي (الوسيط)', 'Personal (Al-Waseet)', 'تایبەت')} · ${CLASS_LABEL[c]}`)}
          </div>
        ))}
      </section>

      <section className="mt-3 grid gap-3 sm:grid-cols-2">
        <h2 className="text-[14px] font-bold text-text-primary sm:col-span-2">{loc('الباقات', 'Packages', 'پاکێجەکان')}</h2>
        {(['smart', 'complete'] as const).map((id) => (
          <div key={id} className="rounded-lg border border-border-subtle p-2 text-[12px] text-text-secondary">
            <label className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
              <input type="checkbox" checked={draft.packages[id].active} onChange={(e) => upd((d) => { d.packages[id].active = e.target.checked; })} />
              {id === 'smart' ? loc('الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک') : loc('التجربة الكاملة', 'Complete', 'ئەزموونی تەواو')}
            </label>
            <p className="mt-1">
              {[draft.packages[id].warranty, draft.packages[id].care, draft.packages[id].packaging, draft.packages[id].inspection].join(' · ')}
            </p>
            {/* No package discount (owner, 2026-11-17): a package is the sum of its parts; the server refuses one. */}
            {/* Phase 2: the membership a package PRESELECTS is set in the membership panel below (never priced in it). */}
          </div>
        ))}
      </section>

      <CareTermsPanel draft={draft} upd={upd} loc={loc} published={state.published} />
      <MembershipPanel draft={draft} upd={upd} loc={loc} />
      <KitsPanel draft={draft} upd={upd} loc={loc} lang={lang} printers={state.printers} productId={productId} />

      </details>
      </fieldset>

      <section className="lv-surface p-3">
        <h2 className="mb-2 text-[14px] font-bold text-text-primary">{loc('ما يراه الزبون لهذه الطابعة', 'What the customer sees for this printer', 'ئەوەی کڕیار دەیبینێت')}</h2>
        <select className="lv-input h-10 w-full px-2 text-[13px]" value={preview} onChange={(e) => setPreview(e.target.value)}>
          <option value="">—</option>
          {state.printers.filter((p) => p.id === productId && draft.products[p.id]).flatMap((p) => [
            <option key={p.id} value={`${p.id}|`}>{p.name}</option>,
            ...p.versions.map((v) => <option key={v.id} value={`${p.id}|${v.id}`}>{`${p.name} — ${v.name}`}</option>),
          ])}
        </select>
        {preview ? (
          offer ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-text-secondary">
              <dt>{loc('ضمان 12 / 24', 'Warranty 12 / 24', 'گەرەنتی 12 / 24')}</dt><dd dir="ltr" className="tabular-nums">{money(offer.warranty?.w12 ?? null)} / {money(offer.warranty?.w24 ?? null)}</dd>
              <dt>{loc('التوصيل اقتصادي / شخصي', 'Delivery economy / personal', 'گەیاندن')}</dt><dd dir="ltr" className="tabular-nums">{money(offer.delivery?.economy ?? null)} / {money(offer.delivery?.personal ?? null)}</dd>
              <dt>{loc('الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک')}</dt><dd dir="ltr" className="tabular-nums">{money(offer.packages.smart?.price_iqd ?? null)}</dd>
              <dt>{loc('التجربة الكاملة', 'Complete', 'ئەزموونی تەواو')}</dt><dd dir="ltr" className="tabular-nums">{money(offer.packages.complete?.price_iqd ?? null)}</dd>
            </dl>
          ) : <p className="mt-2 text-[12px] text-text-secondary">{loc('هذه النسخة بلا عائلة أو فئة توصيل — لن تُعرض لها الخدمات.', 'This version has no family or delivery class — no services will show.', 'ئەم وەشانە خێزان یان پۆلی گەیاندنی نییە.')}</p>
        ) : null}
      </section>

      {state.publish_issues.length ? (
        <section className="rounded-lg border border-border-subtle p-3 text-[12px] text-text-secondary">
          <p className="font-semibold text-text-primary">{loc('قبل النشر:', 'Before publishing:', 'پێش بڵاوکردنەوە:')}</p>
          <ul className="list-disc ps-5">{state.publish_issues.map((i) => {
            const said = issueText(i, loc, draft.kits ?? []);
            return <li key={i} dir={said.translated ? undefined : 'ltr'}>{said.text}</li>;
          })}</ul>
        </section>
      ) : null}

      {stale ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle p-3" role="alert" data-printer-services-stale>
          <button type="button" className="lv-button lv-button-primary" onClick={keepMine}>
            {loc('أعد التحميل واحتفظ بتعديلاتي', 'Reload and keep my edits', 'دووبارە بارکردن و هێشتنەوەی دەستکارییەکانم')}
          </button>
          <button type="button" className="lv-button lv-button-ghost" onClick={takeTheirs}>
            {loc('تجاهل تعديلاتي وخذ النسخة الجديدة', 'Discard my edits and take the new copy', 'دەستکارییەکانم فڕێبدە و وەشانە نوێیەکە وەربگرە')}
          </button>
        </div>
      ) : null}

      {readOnly ? null : (
      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
        <button type="button" className="lv-button lv-button-secondary" disabled={busy || !dirty || !!stale || kitsHeld} onClick={() => void save()}>
          <Save aria-hidden="true" className="w-4 h-4" /> {loc('حفظ المسودة', 'Save draft', 'پاشەکەوتی ڕەشنووس')}
        </button>
        <button type="button" className="lv-button lv-button-primary" disabled={busy || dirty || !!stale || state.publish_issues.length > 0} onClick={() => void publish()}>
          <Send aria-hidden="true" className="w-4 h-4" /> {loc('نشر للزبائن', 'Publish', 'بڵاوکردنەوە')}
        </button>
        {state.published ? (
          <button type="button" className="lv-button lv-button-ghost" disabled={busy} onClick={() => void unpublish()}>
            <Power aria-hidden="true" className="w-4 h-4" /> {loc('إيقاف', 'Switch off', 'ڕاگرتن')}
          </button>
        ) : null}
        {message ? <span role="status" className="text-[12px] text-text-secondary">{message}</span> : null}
      </div>
      )}
      {readOnly && message ? <p role="status" className="text-[12px] text-text-secondary">{message}</p> : null}
    </div>
  );
}
