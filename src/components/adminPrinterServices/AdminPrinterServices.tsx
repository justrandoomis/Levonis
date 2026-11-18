/**
 * «خدمات الطابعة» — inside the PRINTER's product edit form (owner, 2026-11-17:
 * «on product edit [printers], not a new setting»; DECISIONS row 339).
 *
 * PHASE 5 REDESIGN (owner, 2026-11-18; DECISIONS row 358) — one calm screen about the EDITED
 * printer only (phase 4: «I edit the A1 — no need to see the other printers»), top to bottom:
 *   - the status header (PrinterStatusLine): what a customer sees for this printer NOW, in words,
 *     the single next step on the way choose → save → publish, and what still blocks a publish;
 *   - the save / publish bar, which says beside every switched-off button WHY it is off. It is
 *     repeated under the last step whenever one of its buttons can be pressed (visual QA,
 *     2026-11-18: the section card clips its content, so a sticky bar never stuck — an edit made
 *     in step ٢ or ٣ had its save two screens up);
 *   - step ١ «ضمان وتوصيل هذه الطابعة»: its warranty family and delivery class (PrinterThisTab);
 *   - «ما يراه الزبون» (CustomerPreview): everything this printer offers, from the draft on screen;
 *   - step ٢ «ما يُباع مع هذه الطابعة»: its kits, add-ons and store bundles, folded;
 *   - step ٣ «الأسعار المشتركة لكل الطابعات»: the shared list, folded AND locked until opened on
 *     purpose, with «إيقاف الخدمات عن كل الطابعات» behind a confirmation.
 *
 * WHAT BLOCKS A PUBLISH is worked out from the draft ON SCREEN (the same pure `publishIssues` the
 * server runs), so the list moves as the owner edits; the server's catalogue checks (a product
 * still exists, has a colour) are of the SAVED copy and are re-run by the save — said beside them.
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOptionalAuth } from '../../AuthContext';
import { Save, Send, Power } from 'lucide-react';
import { issueText } from './issueWords';
import { kitsBlocked } from './KitsPanel';
import { addonsBlocked } from './AddonsPanel';
import { Fold, onThisPrinter } from './itemToolkit';
import PrinterStatusLine from './PrinterStatusLine';
import PrinterThisTab, { type ServicesPrinter } from './PrinterThisTab';
import PrinterOffersTab from './PrinterOffersTab';
import SharedPriceListTab from './SharedPriceListTab';
import CustomerPreview from './CustomerPreview';
import { S, countLine, say, type Loc, type Tri } from './adminPrinterStrings';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import { addonsOf, kitsOf, mappingResolves, publishIssues, type PrinterServicesConfig } from '../../../packages/pricing/src/printerServices';

interface State {
  draft: PrinterServicesConfig;
  published: PrinterServicesConfig | null;
  published_at: string | null;
  draft_issues: string[];
  publish_issues: string[];
  printers: ServicesPrinter[];
}

/** What the product form's card says about this printer once the panel has read the list. */
export type PrinterServicesStatus = 'live' | 'not-live' | 'used' | 'unlisted';

/** The config's own publish blockers, from any copy of the draft; a malformed copy blocks nothing here (the server still judges). */
function localIssues(c: PrinterServicesConfig): string[] {
  try { return publishIssues(c); } catch { return []; }
}

export default function AdminPrinterServices({ productId, onDirtyChange, reloadKey, onStatus }: {
  productId: string; onDirtyChange?: (dirty: boolean) => void;
  /** Changes when the product form saved the product: the printers list is read again (a product just filed under a printer section appears). */
  reloadKey?: string | number;
  onStatus?: (status: PrinterServicesStatus) => void;
}) {
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
  const [confirmOff, setConfirmOff] = useState(false);

  const fetchState = () => api.get<State & { success: true }>('/api/admin/printer-services');
  const load = async () => {
    const data = await fetchState();
    setState(data);
    setDraft(data.draft);
  };
  useEffect(() => { void load().catch((e) => setMessage(String(e instanceof Error ? e.message : e))); }, []);
  /** The printers list alone, read again — the admin's edits on screen stay as they are. */
  const recheck = () => {
    if (!state) { void load().catch((e) => setMessage(String(e instanceof Error ? e.message : e))); return; }
    void fetchState().then((d) => setState((prev) => (prev ? { ...prev, printers: d.printers } : prev))).catch(() => undefined);
  };
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const dirty = !readOnly && !!state && !!draft && JSON.stringify(state.draft) !== JSON.stringify(draft);
  // The form's leave guard asks before unsaved price-list edits are lost.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // THIS printer only (owner, 2026-11-18): the other printers of the list are never rendered here.
  const printer = state ? state.printers.find((p) => p.id === productId) ?? null : null;
  const status: PrinterServicesStatus | null = !state ? null
    : !printer ? 'unlisted' : printer.is_used ? 'used' : state.published && mappingResolves(state.published, productId) ? 'live' : 'not-live';
  useEffect(() => { if (status) onStatus?.(status); }, [status, onStatus]);

  // What blocks a publish, from the draft ON SCREEN; the server's catalogue checks ride along from the saved copy.
  const issues = useMemo(() => {
    if (!state || !draft) return [] as string[];
    if (!dirty) return state.publish_issues;
    const savedLocal = new Set(localIssues(state.draft));
    return [...localIssues(draft), ...state.publish_issues.filter((i) => !savedLocal.has(i))];
  }, [state, draft, dirty]);

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
        const list = e.message.replace(/^[^:]*?: /, '').split('; ').map((i) => issueText(i, loc, draft?.kits ?? [], draft?.addons ?? []).text);
        setMessage(`${e.code === 'PRINTER_SERVICES_NOT_READY' ? loc('غير جاهزة للنشر', 'Not ready to publish', 'ئامادە نییە بۆ بڵاوکردنەوە') : loc('لم تُحفظ', 'Not saved', 'پاشەکەوت نەکرا')}: ${list.join(' · ')}`);
      } else if (e instanceof ApiError && e.code === 'PRINTER_SERVICES_USED_UNIT') {
        setMessage(loc('لم تُحفظ: طابعة مستعملة لا تأخذ الخدمات — أزل اختياراتها ثم احفظ.', 'Not saved: a used printer takes no services — remove its choices, then save.', 'پاشەکەوت نەکرا: پرینتەری بەکارهاتوو خزمەتگوزاری وەرناگرێت — هەڵبژاردنەکانی لابە، پاشان پاشەکەوتی بکە.'));
      } else if (e instanceof ApiError && e.code === 'PRINTER_SERVICES_NOT_PRINTER') {
        setMessage(loc('لم تُحفظ: المنتج لم يُحفظ تحت قسم طابعات بعد. احفظ المنتج أولاً.', 'Not saved: the product is not saved under a printer section yet. Save the product first.', 'پاشەکەوت نەکرا: بەرهەمەکە هێشتا لە ژێر بەشێکی پرینتەردا پاشەکەوت نەکراوە. سەرەتا بەرهەمەکە پاشەکەوت بکە.'));
      } else if (e instanceof ApiError && e.code === 'CARE_POLICY_VERSION_REUSED') {
        // Phase 3: the published version's Care terms are frozen — said by its code, in the reader's language.
        setMessage(apiRefusal(e, refusalLang(lang), e.message));
      } else {
        setMessage(e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : String(e));
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
  const save = () => act(() => api.put('/api/admin/printer-services/draft', { draft, base_revision: state!.draft.revision }), loc('حُفظت. الخطوة التالية: النشر للزبائن.', 'Saved. Next: publish to customers.', 'پاشەکەوت کرا. هەنگاوی داهاتوو: بڵاوکردنەوە بۆ کڕیاران.'));
  const publish = () => act(() => api.post('/api/admin/printer-services/publish', { base_revision: state!.draft.revision }), loc('نُشرت: الزبائن يرونها الآن.', 'Published: customers see it now.', 'بڵاوکرایەوە: کڕیاران ئێستا دەیبینن.'));
  const unpublish = () => { setConfirmOff(false); return act(() => api.post('/api/admin/printer-services/unpublish', {}), loc('أُوقفت الخدمات عن كل الطابعات.', 'Services switched off for every printer.', 'خزمەتگوزارییەکان لە هەموو پرینتەرەکان ڕاگیران.')); };

  if (!state || !draft) return <p className="p-4 text-sm text-text-secondary">{message ?? say(loc, S.loading)}</p>;

  const enrolledIds = Object.keys(draft.products);
  const printerIds = [...state.printers.map((p) => p.id), ...enrolledIds];
  // The kit and add-on editors' own checks (U9): a save the server would refuse is not sent; each problem is said on its row.
  const held = kitsBlocked(draft.kits ?? [], new Set(printerIds)) || addonsBlocked(draft.addons ?? []);
  const upd = (fn: (d: PrinterServicesConfig) => void) => {
    const next = JSON.parse(JSON.stringify(draft)) as PrinterServicesConfig;
    fn(next);
    setDraft(next);
  };
  const usable = !!printer && !printer.is_used;
  const upToDate = !!state.published && state.published.revision === state.draft.revision;

  // Why a button is off — one sentence beside it, never a silent grey.
  const whySave: Tri | null = busy ? S.whyBusy : stale ? S.whyStale : held ? S.whyHeld : !dirty ? S.whyClean : null;
  const whyPublish: Tri | null = busy ? S.whyBusy : stale ? S.whyStale : dirty ? S.whyDirty : state.publish_issues.length > 0 ? S.whyIssues : upToDate ? S.whyUpToDate : null;
  // The button the next step asks for is the filled one.
  const publishNext = !whyPublish;

  const here = {
    kits: kitsOf(draft).filter((k) => onThisPrinter(k.printers, productId)).length,
    addons: addonsOf(draft).filter((a) => onThisPrinter(a.printers, productId)).length,
    bundles: (Object.hasOwn(draft.products, productId) ? draft.products[productId].store_bundle_ids ?? [] : []).length,
  };
  const stepTitle = (n: number, title: Tri) => (
    <>
      <span aria-hidden="true" className="shrink-0 w-6 h-6 rounded-full grid place-items-center text-[12px] font-black bg-surface-selected text-text-primary">{n}</span>
      <span className="min-w-0 flex-1 text-[14px] font-bold text-text-primary">{say(loc, title)}</span>
    </>
  );
  /** A folded step: its number and title, a one-line summary of what is inside, then the body. */
  const foldedStep = (key: string, n: number, title: Tri, hint: Tri, summary: string, body: ReactNode) => (
    <Fold
      className="lv-surface p-3"
      attrs={{ 'data-printer-step': key }}
      summaryClassName="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 [&::-webkit-details-marker]:hidden"
      summary={stepTitle(n, title)}
      tail={summary ? <span className="w-full text-[12px] text-text-muted">{summary}</span> : null}
    >
      <p className="mt-1 text-[12px] text-text-secondary leading-relaxed">{say(loc, hint)}</p>
      <div className="mt-3">{body}</div>
    </Fold>
  );
  // A used printer shows the bar only while it still carries choices to remove and save.
  const showBar = !readOnly && !!printer && (usable || dirty || Object.hasOwn(draft.products, productId));
  // Nothing to save and nothing to publish: one calm line, not two reasons.
  const idle = whySave === S.whyClean && whyPublish === S.whyUpToDate;
  /** Save / publish with the reason beside a switched-off button. `end` = the repeat under the last step. */
  const actions = (end: boolean) => (
    <div className={`space-y-1.5 border-t border-border-subtle ${end ? 'pt-2' : 'border-b py-2'}`} {...(end ? { 'data-printer-services-actions-end': '' } : { 'data-printer-services-actions': '' })}>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={`lv-button ${publishNext ? 'lv-button-secondary' : 'lv-button-primary'}`} disabled={!!whySave} onClick={() => void save()} data-printer-services-save>
          <Save aria-hidden="true" className="w-4 h-4 shrink-0" /> {say(loc, S.saveBtn)}
        </button>
        <button type="button" className={`lv-button ${publishNext ? 'lv-button-primary' : 'lv-button-secondary'}`} disabled={!!whyPublish} onClick={() => void publish()} data-printer-services-publish>
          <Send aria-hidden="true" className="w-4 h-4 shrink-0" /> {say(loc, S.publishBtn)}
        </button>
      </div>
      {busy ? <p className="text-[12px] text-text-secondary" data-printer-services-why="busy">{say(loc, S.whyBusy)}</p>
        : idle ? <p className="text-[12px] text-text-secondary leading-relaxed" data-printer-services-why="idle">{say(loc, S.whyIdle)}</p>
          : (
            <>
              {whySave ? <p className="text-[12px] text-text-secondary leading-relaxed" data-printer-services-why="save"><span className="font-semibold text-text-primary">{say(loc, S.whySave)}</span> {say(loc, whySave)}</p> : null}
              {whyPublish ? <p className="text-[12px] text-text-secondary leading-relaxed" data-printer-services-why="publish"><span className="font-semibold text-text-primary">{say(loc, S.whyPublish)}</span> {say(loc, whyPublish)}</p> : null}
            </>
          )}
      {message ? <p role={end ? undefined : 'status'} className="text-[13px] font-semibold text-text-primary leading-relaxed" data-printer-services-message>{message}</p> : null}
    </div>
  );

  return (
    <div className="space-y-3" dir={dir} data-admin-printer-services>
      <PrinterStatusLine
        loc={loc}
        productId={productId}
        listed={!!printer}
        used={!!printer?.is_used}
        productStatus={printer?.status}
        draft={draft}
        published={state.published}
        publishIssues={usable ? issues : []}
        printerIds={printerIds}
        dirty={dirty}
        held={held}
        readOnly={readOnly}
        issueSay={(i) => issueText(i, loc, draft.kits ?? [], draft.addons ?? [])}
      />

      {!printer ? (
        <button type="button" className="lv-button lv-button-secondary" onClick={recheck} data-printer-services-recheck>{say(loc, S.recheck)}</button>
      ) : null}

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

      {showBar ? actions(false) : null}
      {showBar ? <p className="text-[11px] text-text-muted leading-relaxed" data-printer-services-bar-note>{say(loc, S.barNote)}</p> : null}
      {!showBar && message ? <p role="status" className="text-[12px] text-text-secondary">{message}</p> : null}

      <fieldset disabled={readOnly} className="m-0 min-w-0 border-none p-0 space-y-3">
        <section className="lv-surface p-3 space-y-2" data-printer-step="this">
          <div className="flex min-h-11 items-center gap-2">{stepTitle(1, S.step1)}</div>
          {usable ? <p className="text-[12px] text-text-secondary leading-relaxed">{say(loc, S.step1Hint)}</p> : null}
          <PrinterThisTab draft={draft} upd={upd} loc={loc} printer={printer} />
        </section>

        {usable && printer ? <CustomerPreview draft={draft} loc={loc} lang={lang} printer={printer} /> : null}

        {usable ? foldedStep('offers', 2, S.step2, S.step2Hint,
          countLine(loc, here.kits, here.addons, here.bundles),
          <PrinterOffersTab draft={draft} upd={upd} loc={loc} lang={lang} printers={state.printers} productId={productId} />) : null}

        {usable ? foldedStep('shared', 3, S.step3, S.step3Hint, say(loc, S.step3Tail),
          <>
            <SharedPriceListTab draft={draft} upd={upd} loc={loc} published={state.published} productId={productId} />
            {state.published && !readOnly ? (
              <div className="mt-4 border-t border-border-subtle pt-3 space-y-2" data-printer-services-off>
                {confirmOff ? (
                  <div className="lv-alert lv-alert-warning p-3 text-[12px] space-y-2" role="alert">
                    <p className="leading-relaxed">{say(loc, S.switchOffAsk)}</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="lv-button lv-button-primary" disabled={busy} onClick={() => void unpublish()}>{say(loc, S.switchOffYes)}</button>
                      <button type="button" className="lv-button lv-button-ghost" onClick={() => setConfirmOff(false)}>{say(loc, S.cancel)}</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="lv-button lv-button-ghost" disabled={busy} onClick={() => setConfirmOff(true)}>
                    <Power aria-hidden="true" className="w-4 h-4" /> {say(loc, S.switchOff)}
                  </button>
                )}
              </div>
            ) : null}
          </>) : null}
      </fieldset>

      {/* The same two buttons again where the editing ends, only while one of them can be pressed. */}
      {showBar && usable && (!whySave || !whyPublish) ? actions(true) : null}
    </div>
  );
}
