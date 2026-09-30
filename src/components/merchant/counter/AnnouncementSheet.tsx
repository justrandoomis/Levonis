/**
 * «📣 إعلان» — THE ANNOUNCEMENT SHEET (merchant platform v2 §3.2 dock, §4.6;
 * storefront L6; P5).
 *
 * One line at the top of the store page — «توصيل مجاني هذا الأسبوع» — is the
 * layout's own `header.notice` (+ `notice_link`, `notice_from`,
 * `notice_until`), not a column beside it: it is written into the store's
 * DRAFT through `PUT /api/merchant/store/layout/draft` and made live through
 * `POST /publish` — the very two doors the builder uses, so the server
 * normalises it, checks its link, and keeps it in the page's history like any
 * other publish. Nothing else in the layout is touched.
 *
 * ONE SHEET, CONFIRM BEFORE PUBLISH. «انشر الشريط» turns the footer into the
 * question — «سيُنشر فورًا» — and only «نعم، انشر الآن» writes. When the
 * draft already holds other unpublished edits the question says so (they
 * would go live with it) and offers «احفظ في المسودة فقط» instead.
 *
 * A second tab or device saving the draft in between (DRAFT_CHANGED) is met
 * by reading the draft again and laying the notice over it ONCE: the notice is
 * all this writes, so nobody's other work is lost. The server's refusals are
 * sentences from src/lib/refusalStrings.ts (loaded on the first refusal),
 * never its English.
 *
 * Its own lazy chunk (QuickDock.tsx): Today never downloads it until the door
 * is pressed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Field, Input, Select } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { useToast } from '../../ui/Toast';
import Spinner from '../../ui/Spinner';
import { NOTICE_MAX } from '../../../../packages/storeLayout/src/blocks';
import { LINK_ROUTES, NO_LINK, safeExternalUrl, type LinkRoute, type LinkTarget } from '../../../../packages/storeLayout/src/refs';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { storeLayoutApi, type LayoutState } from '../storeDesign/storeLayoutApi';
import { fill } from './strings';
import { useAnnounceStrings, type AnnounceStrings } from './announceStrings';

// ------------------------------------------------------------------ model

export type NoticeLang = 'ar' | 'en' | 'ckb';

export interface NoticeForm {
  text: Record<NoticeLang, string>;
  /** Kept as it is when it names a product or a collection (the builder's pickers choose those). */
  link: LinkTarget;
  /** ISO instants, '' = no bound. */
  from: string;
  until: string;
}

/** The form a layout's header holds today. */
export function noticeFormOf(layout: Pick<StoreLayout, 'header'>): NoticeForm {
  const h = layout.header;
  const n = h.notice ?? { ar: '', en: '', ckb: '' };
  return {
    text: { ar: n.ar ?? '', en: n.en ?? '', ckb: n.ckb ?? '' },
    link: h.notice_link ?? { ...NO_LINK },
    from: h.notice_from ?? '',
    until: h.notice_until ?? '',
  };
}

/** The layout with THIS notice — and nothing else changed. A bound left '' is taken away, as the normaliser writes it. */
export function applyNotice(layout: StoreLayout, form: NoticeForm): StoreLayout {
  const header: StoreLayout['header'] = {
    ...layout.header,
    notice: { ar: form.text.ar.trim(), en: form.text.en.trim(), ckb: form.text.ckb.trim() },
    notice_link: form.link,
  };
  if (form.from) header.notice_from = form.from;
  else delete header.notice_from;
  if (form.until) header.notice_until = form.until;
  else delete header.notice_until;
  return { ...layout, header };
}

/** No words in any language, no link, no window: the bar is gone. */
export function clearedNotice(): NoticeForm {
  return { text: { ar: '', en: '', ckb: '' }, link: { ...NO_LINK }, from: '', until: '' };
}

export function hasNoticeText(form: Pick<NoticeForm, 'text'>): boolean {
  return !!(form.text.ar.trim() || form.text.en.trim() || form.text.ckb.trim());
}

const MIN_DATE = Date.parse('2020-01-01T00:00:00.000Z');
const MAX_DATE = Date.parse('2100-01-01T00:00:00.000Z');

/**
 * THE WINDOW'S RULES, the schema's `date` rules plus its order rule: each
 * bound is an instant between 2020 and 2100 (`range`), and an end that is not
 * after its start is refused here (`order`) — the normaliser would silently
 * drop it and the bar would never stop showing.
 */
export function windowProblem(from: string, until: string): 'range' | 'order' | null {
  for (const v of [from, until]) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t) || t < MIN_DATE || t >= MAX_DATE) return 'range';
  }
  if (from && until && Date.parse(until) <= Date.parse(from)) return 'order';
  return null;
}

/** An https address the storefront would open, or a problem. */
export function linkProblem(link: LinkTarget): 'url' | null {
  return link.kind === 'external' && !safeExternalUrl(link.url) ? 'url' : null;
}

/** What visitors see of a header's notice at `nowIso`. */
export function noticeState(header: Pick<StoreLayout['header'], 'notice' | 'notice_from' | 'notice_until'> | null | undefined, nowIso: string): 'none' | 'live' | 'waiting' | 'ended' {
  if (!header || !hasNoticeText({ text: { ar: header.notice?.ar ?? '', en: header.notice?.en ?? '', ckb: header.notice?.ckb ?? '' } })) return 'none';
  const now = Date.parse(nowIso);
  if (header.notice_from && Date.parse(header.notice_from) > now) return 'waiting';
  if (header.notice_until && Date.parse(header.notice_until) <= now) return 'ended';
  return 'live';
}

export interface AnnouncementApi {
  get: () => Promise<LayoutState>;
  saveDraft: (layout: StoreLayout, version: number) => Promise<{ draft: { version: number } }>;
  publish: (version: number, note?: string) => Promise<{ published: { revision: number } }>;
}

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : '';
}

/**
 * Write the notice to the draft and, unless asked not to, publish it. On
 * DRAFT_CHANGED — at the save or at the publish — the draft is read again and
 * the notice laid over the newer one, once.
 */
export async function writeAnnouncement(
  api: AnnouncementApi,
  form: NoticeForm,
  opts: { publish: boolean; note?: string; state?: Pick<LayoutState, 'draft'> | null }
): Promise<{ revision: number | null }> {
  let st = opts.state ?? (await api.get());
  for (let attempt = 0; ; attempt++) {
    try {
      const saved = await api.saveDraft(applyNotice(st.draft.layout, form), st.draft.version);
      if (!opts.publish) return { revision: null };
      const pub = await api.publish(saved.draft.version, opts.note);
      return { revision: pub.published.revision };
    } catch (e) {
      if (codeOf(e) !== 'DRAFT_CHANGED' || attempt > 0) throw e;
      st = await api.get();
    }
  }
}

const liveApi: AnnouncementApi = {
  get: () => storeLayoutApi.get(),
  saveDraft: (layout, version) => storeLayoutApi.saveDraft(layout, version),
  publish: (version, note) => storeLayoutApi.publish(version, note),
};

// ------------------------------------------------------------------ dates

function toLocalInput(iso: string): string {
  const t = Date.parse(iso);
  if (!iso || !Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalInput(v: string): string {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

// ------------------------------------------------------------------ sheet

type Step = 'edit' | 'confirm' | 'confirmRemove';
type LinkChoice = 'none' | 'route' | 'external' | 'kept';

export default function AnnouncementSheet({ open, onClose, api = liveApi }: { open: boolean; onClose: () => void; api?: AnnouncementApi }) {
  const { lang } = useLanguage();
  const a = useAnnounceStrings();
  const toast = useToast();
  const [state, setState] = useState<Pick<LayoutState, 'draft' | 'dirty' | 'published'> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<NoticeForm>(clearedNotice);
  const [initial, setInitial] = useState<string>('');
  const [textLang, setTextLang] = useState<NoticeLang>(lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar');
  const [step, setStep] = useState<Step>('edit');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [triedUrl, setTriedUrl] = useState(false);
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  /**
   * FOCUS FOLLOWS THE FOOTER'S SWAP (review 2026-09-30). «انشر الشريط» and
   * «أزل الشريط» unmount themselves when the footer turns into the question,
   * and focus fell to the page's <body>, outside the sheet, with the question
   * never read. The question takes focus (it is read on arrival); «رجوع»
   * gives it back to the button that asked.
   */
  const opener = useRef<'publish' | 'remove'>('publish');
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    const target = step === 'edit' ? (opener.current === 'remove' ? '[data-announce-remove]' : '[data-announce-publish]') : '[data-announce-question]';
    const id = requestAnimationFrame(() => document.querySelector<HTMLElement>(target)?.focus());
    return () => cancelAnimationFrame(id);
  }, [step]);

  const load = async () => {
    setLoadError(false);
    setState(null);
    try {
      const st = await api.get();
      const f = noticeFormOf(st.draft.layout);
      setState(st);
      setForm(f);
      setInitial(JSON.stringify(f));
      setNowIso(new Date().toISOString());
      setStep('edit');
      setProblem(null);
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => {
    if (open) void load();
    // Read again on every opening: another device may have changed the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shown = noticeState(state?.published?.layout?.header ?? null, nowIso);
  const win = windowProblem(form.from, form.until);
  const urlBad = linkProblem(form.link) === 'url';
  const changed = !!state && JSON.stringify(form) !== initial;
  // Something to make live: this sheet's edit, or a notice the draft holds that visitors do not see yet.
  const pending = useMemo(() => {
    if (!state) return false;
    const live = state.published?.layout ? noticeFormOf(state.published.layout) : clearedNotice();
    return JSON.stringify(noticeFormOf(state.draft.layout)) !== JSON.stringify(live);
  }, [state]);
  const canPublish = !!state && !busy && !win && !urlBad && hasNoticeText(form) && (changed || pending);
  const hadNotice = !!state && (hasNoticeText(noticeFormOf(state.draft.layout)) || shown !== 'none');
  const left = NOTICE_MAX - form.text[textLang].length;

  const choice: LinkChoice = form.link.kind === 'none' ? 'none' : form.link.kind === 'route' ? 'route' : form.link.kind === 'external' ? 'external' : 'kept';
  const setChoice = (c: LinkChoice) => {
    if (c === 'none') setForm((f) => ({ ...f, link: { ...NO_LINK } }));
    else if (c === 'route') setForm((f) => ({ ...f, link: { kind: 'route', route: 'products' } }));
    else if (c === 'external') setForm((f) => ({ ...f, link: { kind: 'external', url: '' } }));
  };

  const refusal = async (e: unknown): Promise<string> => {
    const code = codeOf(e);
    if (code === 'DRAFT_CHANGED') return a.changed;
    // The sentences are loaded on the first refusal, not with the sheet.
    const { refusalText } = await import('../../../lib/refusalStrings');
    const d = ((e as { details?: unknown } | null)?.details ?? {}) as Record<string, unknown>;
    const mb = (n: unknown) => (typeof n === 'number' && n > 0 ? `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB` : '');
    return refusalText(code, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar', a.failed).replace('{size}', mb(d.size)).replace('{max}', mb(d.max)).replace('{where}', '');
  };

  const write = async (target: NoticeForm, publish: boolean, done: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await writeAnnouncement(api, target, { publish, note: a.historyNote, state });
      toast.success(done);
      onClose();
    } catch (e) {
      setProblem(await refusal(e));
      setStep('edit');
      if (codeOf(e) === 'DRAFT_CHANGED') void load();
    } finally {
      setBusy(false);
    }
  };

  const langs: NoticeLang[] = ['ar', 'en', 'ckb'];
  const previewText = form.text[textLang].trim() || form.text.ar.trim() || form.text.en.trim() || form.text.ckb.trim();

  const footer =
    step === 'edit' ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hadNotice && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              opener.current = 'remove';
              setStep('confirmRemove');
            }}
            disabled={busy || !state}
            data-announce-remove
          >
            {a.remove}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          icon={<Megaphone className="h-4 w-4" aria-hidden="true" />}
          disabled={!canPublish}
          onClick={() => {
            setTriedUrl(true);
            opener.current = 'publish';
            if (!win && !urlBad) setStep('confirm');
          }}
          data-announce-publish
        >
          {a.publish}
        </Button>
      </div>
    ) : (
      <div className="space-y-2" data-announce-confirm={step === 'confirm' ? 'publish' : 'remove'}>
        <p role="status" tabIndex={-1} className="rounded text-[13px] font-semibold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-announce-question>
          {a.publishNow}
        </p>
        {state?.dirty && <p className="text-[12.5px] text-warning">{a.draftToo}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setStep('edit')} disabled={busy}>
            {a.back}
          </Button>
          {state?.dirty && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void write(step === 'confirm' ? form : clearedNotice(), false, a.savedDraft)} data-announce-draft>
              {a.saveDraft}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={() => void (step === 'confirm' ? write(form, true, a.published) : write(clearedNotice(), true, a.removed))}
            data-announce-confirm-publish
          >
            {a.confirm}
          </Button>
        </div>
      </div>
    );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={a.title}
      detents={['medium', 'large']}
      dirty={changed && !busy}
      testId="announce-sheet"
      panelClassName="sm:max-w-lg"
      header={
        <div className="px-4 pb-2 pt-1 sm:pt-5">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-bold text-text-primary">{a.title}</h2>
            {state && <StateChip state={shown} a={a} />}
          </div>
          <p className="text-[12.5px] text-text-muted">{a.lead}</p>
        </div>
      }
      footer={state ? footer : undefined}
    >
      <div className="space-y-4 px-4 py-3" data-announce-sheet>
        {loadError ? (
          <div className="space-y-3 py-6 text-center">
            <p className="text-[13px] text-text-secondary">{a.loadFailed}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {a.retry}
            </Button>
          </div>
        ) : !state ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-text-muted" aria-busy="true">
            <Spinner size="sm" />
            {a.loading}
          </div>
        ) : (
          <>
            {problem && (
              <p role="alert" className="lv-field-error" data-announce-problem>
                {problem}
              </p>
            )}
            <Field label={a.textLabel} hint={<span className="flex flex-wrap gap-x-3"><span>{a.textHint}</span><span className="ms-auto tabular-nums">{fill(a.left, { n: Math.max(0, left) })}</span></span>}>
              <Input
                value={form.text[textLang]}
                maxLength={NOTICE_MAX}
                dir={textLang === 'en' ? 'ltr' : 'rtl'}
                lang={textLang}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, text: { ...f.text, [textLang]: v } }));
                }}
                data-announce-text={textLang}
              />
            </Field>
            <Segmented
              size="sm"
              group="announce-lang"
              label={a.langLabel}
              value={textLang}
              onChange={(v) => setTextLang(v as NoticeLang)}
              items={langs.map((l) => ({
                id: l,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    {a.lang[l]}
                    {form.text[l].trim() && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />}
                  </span>
                ),
              }))}
            />
            <Field label={a.linkLabel}>
              <Select value={choice} onChange={(e) => setChoice(e.target.value as LinkChoice)} data-announce-link>
                <option value="none">{a.link.none}</option>
                <option value="route">{a.link.route}</option>
                <option value="external">{a.link.external}</option>
                {choice === 'kept' && <option value="kept">{a.linkKept}</option>}
              </Select>
            </Field>
            {form.link.kind === 'route' && (
              <Field label={a.pageLabel}>
                <Select value={form.link.route} onChange={(e) => setForm((f) => ({ ...f, link: { kind: 'route', route: e.target.value as LinkRoute } }))} data-announce-route>
                  {LINK_ROUTES.map((r) => (
                    <option key={r} value={r}>
                      {a.routes[r] ?? r}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {form.link.kind === 'external' && (
              <Field label={a.urlLabel} error={(triedUrl || form.link.url.length > 8) && urlBad ? a.urlBad : undefined}>
                <Input
                  ltr
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://"
                  maxLength={500}
                  value={form.link.url}
                  onChange={(e) => {
                    const url = e.target.value;
                    setForm((f) => ({ ...f, link: { kind: 'external', url } }));
                  }}
                  data-announce-url
                />
              </Field>
            )}
            {/* One under the other: a date-and-time field needs its whole line in a sheet this narrow. */}
            <div className="grid gap-3">
              <Field label={a.fromLabel} error={win === 'range' && form.from && windowProblem(form.from, '') ? a.windowRange : undefined}>
                <Input type="datetime-local" ltr value={toLocalInput(form.from)} min="2020-01-01T00:00" max="2099-12-31T23:59" onChange={(e) => setForm((f) => ({ ...f, from: fromLocalInput(e.target.value) }))} data-announce-from />
              </Field>
              <Field label={a.untilLabel} error={win === 'order' ? a.windowOrder : win === 'range' && form.until && windowProblem('', form.until) ? a.windowRange : undefined}>
                <Input type="datetime-local" ltr value={toLocalInput(form.until)} min="2020-01-01T00:00" max="2099-12-31T23:59" onChange={(e) => setForm((f) => ({ ...f, until: fromLocalInput(e.target.value) }))} data-announce-until />
              </Field>
            </div>
            {!win && <p className="text-[12px] text-text-muted">{a.windowHint}</p>}
            {previewText && (
              <div className="space-y-1.5" data-announce-preview>
                <p className="text-[12px] font-medium text-text-secondary">{a.preview}</p>
                {/* At a PHONE's width, wrapped as the store page wraps it (up to three lines):
                    the merchant sees what a customer on a phone will read. */}
                <div className="flex min-h-11 max-w-xs items-center gap-2 rounded-xl border border-border-subtle bg-surface-raised px-3 text-[12.5px] text-text-primary" data-announce-preview-line>
                  <Megaphone className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
                  <span dir="auto" className="min-w-0 flex-1 line-clamp-3 py-1.5">
                    {previewText}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

function StateChip({ state, a }: { state: 'none' | 'live' | 'waiting' | 'ended'; a: AnnounceStrings }) {
  const tone = state === 'live' ? 'bg-success' : state === 'waiting' ? 'bg-warning' : 'bg-text-muted';
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted" data-announce-state={state}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {a.state[state]}
    </span>
  );
}
