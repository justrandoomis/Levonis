/**
 * «خدمات الطابعة» — inside the PRINTER's product edit form (owner, 2026-11-17:
 * «on product edit [printers], not a new setting»; DECISIONS row 339).
 *
 * PHASE 4 REDESIGN (owner, 2026-11-18; DECISIONS row 355): «I edit the A1 — no need to see the
 * other printers». The panel is about the EDITED printer only:
 *   - a status line (PrinterStatusLine): published and showing, or what is missing, in words;
 *   - three tabs: «هذه الطابعة» (its warranty family, delivery class, versions and the customer's
 *     view), «الباقات والإضافات» (its kits, add-ons and store bundles; other printers' are counted,
 *     never named) and «قائمة الأسعار المشتركة» (the list every printer shares, behind a banner);
 *   - a bar with save / publish that stays at the top while the long tabs scroll (the form's own
 *     save bar owns the bottom edge).
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
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useOptionalAuth } from '../../AuthContext';
import { Layers, Save, Send, Power } from 'lucide-react';
import { issueText as extrasIssueText, kitsBlocked } from './PrinterExtrasPanels';
import { careIssueText } from './CareTermsPanel';
import { addonsBlocked } from './AddonsPanel';
import PrinterStatusLine from './PrinterStatusLine';
import PrinterThisTab, { type ServicesPrinter } from './PrinterThisTab';
import PrinterOffersTab from './PrinterOffersTab';
import SharedPriceListTab from './SharedPriceListTab';
import { S, say, type Loc, type Tri } from './adminPrinterStrings';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import type { PrinterServicesConfig } from '../../../packages/pricing/src/printerServices';

interface State {
  draft: PrinterServicesConfig;
  published: PrinterServicesConfig | null;
  published_at: string | null;
  draft_issues: string[];
  publish_issues: string[];
  printers: ServicesPrinter[];
}

type Tab = 'this' | 'offers' | 'shared';
const TABS: ReadonlyArray<readonly [Tab, Tri]> = [['this', S.tabThis], ['offers', S.tabOffers], ['shared', S.tabShared]];

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
  const [tab, setTab] = useState<Tab>('this');
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

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

  if (!state || !draft) return <p className="p-4 text-sm text-text-secondary">{message ?? say(loc, S.loading)}</p>;

  const enrolledIds = Object.keys(draft.products);
  // The kit and add-on editors' own checks (U9): a save the server would refuse is not sent; each problem is said on its row.
  const held = kitsBlocked(draft.kits ?? [], new Set([...state.printers.map((p) => p.id), ...enrolledIds])) || addonsBlocked(draft.addons ?? []);
  const upd = (fn: (d: PrinterServicesConfig) => void) => {
    const next = JSON.parse(JSON.stringify(draft)) as PrinterServicesConfig;
    fn(next);
    setDraft(next);
  };
  // THIS printer only (owner, 2026-11-18): the other printers of the list are never rendered here.
  const printer = state.printers.find((p) => p.id === productId) ?? null;
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(([t]) => t === tab);
    const step = e.key === 'ArrowLeft' ? (dir === 'rtl' ? 1 : -1) : e.key === 'ArrowRight' ? (dir === 'rtl' ? -1 : 1) : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(at + step + TABS.length) % TABS.length][0];
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="mt-5 space-y-4 border-t border-border-subtle pt-5" dir={dir} data-admin-printer-services>
      <h3 className="flex items-center gap-2 text-base font-bold text-text-primary">
        <Layers aria-hidden="true" className="w-5 h-5" />
        {say(loc, S.title)}
      </h3>

      <PrinterStatusLine
        loc={loc}
        productId={productId}
        listed={!!printer}
        draft={draft}
        published={state.published}
        publishIssues={state.publish_issues}
        printerIds={[...state.printers.map((p) => p.id), ...enrolledIds]}
        dirty={dirty}
        issueSay={(i) => issueText(i, loc, draft.kits ?? [])}
      />

      {readOnly ? (
        <p className="rounded-lg border border-border-subtle p-2 text-[12px] text-text-secondary" data-printer-services-readonly>
          {loc('للعرض فقط: حفظ قائمة أسعار خدمات الطابعة ونشرها للمالك وحده.', 'View only: saving and publishing the printer services price list is the owner\'s alone.', 'تەنها بۆ بینین: پاشەکەوتکردن و بڵاوکردنەوەی لیستی نرخی خزمەتگوزارییەکانی پرینتەر تەنها هی خاوەنەکەیە.')}
        </p>
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

      {/* Stays at the top while the long tabs below scroll: the form's own save bar owns the bottom edge. */}
      {readOnly ? null : (
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-y border-border-subtle bg-surface-raised py-2" data-printer-services-actions>
        <button type="button" className="lv-button lv-button-secondary" disabled={busy || !dirty || !!stale || held} onClick={() => void save()}>
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

      <div role="tablist" aria-label={say(loc, S.tabsLabel)} className="flex flex-wrap gap-1.5" onKeyDown={onTabKey}>
        {TABS.map(([t, label]) => (
          <button
            key={t}
            ref={(el) => { tabRefs.current[t] = el; }}
            type="button"
            role="tab"
            id={`ps-tab-${t}`}
            aria-controls={`ps-panel-${t}`}
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            className={`lv-button lv-button-sm ${tab === t ? 'lv-button-primary' : 'lv-button-secondary'}`}
            onClick={() => setTab(t)}
            data-printer-services-tab={t}
          >
            {say(loc, label)}
          </button>
        ))}
      </div>

      <fieldset disabled={readOnly} className="m-0 min-w-0 border-none p-0">
        <div role="tabpanel" id={`ps-panel-${tab}`} aria-labelledby={`ps-tab-${tab}`}>
          {tab === 'this' ? <PrinterThisTab draft={draft} upd={upd} loc={loc} printer={printer} /> : null}
          {tab === 'offers' ? <PrinterOffersTab draft={draft} upd={upd} loc={loc} lang={lang} printers={state.printers} productId={productId} /> : null}
          {tab === 'shared' ? <SharedPriceListTab draft={draft} upd={upd} loc={loc} published={state.published} productId={productId} /> : null}
        </div>
      </fieldset>
    </div>
  );
}
