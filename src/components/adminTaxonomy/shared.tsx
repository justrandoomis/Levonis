/**
 * Shared pieces of the taxonomy admin (sections, brands, filters, hashtags):
 * the wire types of /api/admin/taxonomy, the loader, and the small UI
 * primitives every tab uses — built on the .ap tokens and recipes of the
 * admin products design system so the page reads as one panel with it.
 */
import React, { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, RefreshCw, X } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { Modal } from '../adminProducts/ui';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

// ------------------------------------------------------------------- types

export type TemplateFamily = 'devices' | 'materials';

export interface CatalogNode {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sort: number;
  is_printer_catalog: boolean;
  active: boolean;
  template_family: TemplateFamily | null;
  effective_template_family: TemplateFamily | null;
  product_count: number;
  /**
   * The `/files/...` path of the picture this section shows on the home page,
   * or '' when none has been uploaded (migration 0100). A URL and never the
   * stored key — the worker resolves it so this panel and the storefront
   * cannot disagree about what `UiUx/MainPage/` means.
   */
  image_url: string;
}

export interface BrandRow {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  active: boolean;
  product_count: number;
}

export interface FacetRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  kind: string;
  sort: number;
  active: boolean;
  product_count: number;
}

export interface HashtagRow {
  id: string;
  tag: string;
  name_ar: string;
  sort: number;
  active: boolean;
  managed: boolean;
  product_count: number;
}

export interface TaxonomyData {
  catalogs: CatalogNode[];
  brands: BrandRow[];
  facets: FacetRow[];
  hashtags: HashtagRow[];
}

export async function loadTaxonomy(): Promise<TaxonomyData> {
  const [c, b, f, h] = await Promise.all([
    api.get<{ catalogs: CatalogNode[] }>('/api/admin/taxonomy/catalogs'),
    api.get<{ brands: BrandRow[] }>('/api/admin/taxonomy/brands'),
    api.get<{ facets: FacetRow[] }>('/api/admin/taxonomy/facets'),
    api.get<{ hashtags: HashtagRow[] }>('/api/admin/taxonomy/hashtags'),
  ]);
  return {
    catalogs: c.catalogs ?? [],
    brands: b.brands ?? [],
    facets: f.facets ?? [],
    hashtags: h.hashtags ?? [],
  };
}

export const errMsg = (e: unknown): string => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

export type Tone = 'ok' | 'warn' | 'bad' | 'info';
export interface NoticeState {
  tone: Tone;
  text: string;
}

export const FAMILY_LABEL: Record<TemplateFamily, { ar: string; en: string }> = {
  devices: { ar: 'الأجهزة', en: 'Devices' },
  materials: { ar: 'المواد', en: 'Materials' },
};

/**
 * The page's language. `loc` takes the Kurdish string too — the panel is
 * offered in three languages and silently serving Arabic to a Kurdish admin
 * is the bug the rest of the admin already avoids.
 */
export function useLoc() {
  const { lang, dir } = useLanguage();
  const loc = (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar);
  return { lang, dir, loc, isEn: lang === 'en' };
}

/**
 * The display name of a row in the current language, never empty: the
 * language's own name first, then the other two, then the slug. The Kurdish
 * name is collected by every dialog, so it has to be READ somewhere.
 */
export function nameOf(
  row: { name_ar?: string; name_en?: string; name_ckb?: string; slug?: string; tag?: string },
  lang: 'ar' | 'en' | 'ckb' | string
): string {
  const order =
    lang === 'en'
      ? [row.name_en, row.name_ar, row.name_ckb]
      : lang === 'ckb'
        ? [row.name_ckb, row.name_ar, row.name_en]
        : [row.name_ar, row.name_en, row.name_ckb];
  return order.find((x) => x && x.trim()) || row.slug || row.tag || '—';
}

/** The secondary line under a name: the other languages, without repeating it. */
export function altNames(
  row: { name_ar?: string; name_en?: string; name_ckb?: string },
  lang: 'ar' | 'en' | 'ckb' | string
): string {
  const primary = nameOf(row, lang);
  return [row.name_en, row.name_ar, row.name_ckb]
    .filter((x): x is string => !!x && x.trim() !== '' && x !== primary)
    .filter((x, i, all) => all.indexOf(x) === i)
    .join(' · ');
}

export const fmtN = (n: number) => new Intl.NumberFormat('en').format(n);

// ---------------------------------------------------------------- primitives

export const cell = 'px-3 py-2.5 text-[13px] align-middle';
export const cellHead = `${cell} text-start font-semibold text-[11.5px] whitespace-nowrap`;
export const mono = 'font-mono text-[12px] text-[var(--ap-text-3)]';

/**
 * THE ACTIONS COLUMN IS PINNED, BECAUSE OFF-SCREEN IS UNCLICKABLE.
 *
 * Every one of these tables puts edit / activate / delete in its LAST column
 * and sets a `minWidth` wider than a tablet held upright. The wrapper then
 * scrolls horizontally — and because the admin is RTL, the last column is on
 * the LEFT, so it is the actions that get pushed out of the viewport rather
 * than the slug.
 *
 * Measured on the built app at 1024x1366 with the taxonomy tab open: the
 * scroller is 766px wide over 869px of table, the edit button lands at x=2
 * and the DELETE BUTTON AT x=-70 — entirely outside the screen. That is
 * exactly the owner's report that they could not edit or delete a section, a
 * sub-section or a brand: the API accepts all three (verified end to end), the
 * buttons exist, and on an iPad in portrait they were unreachable.
 *
 * `position: sticky` on the last cell of every row keeps them against the
 * inline-end edge whatever the scroll offset, in both writing directions, and
 * costs no information — nothing is hidden, the other columns simply scroll
 * underneath. The opaque background is what makes "underneath" true; without
 * it the scrolled text shows through the buttons.
 */
const STICKY_ACTIONS = [
  '[&_tr>*:last-child]:sticky',
  '[&_tr>*:last-child]:end-0',
  '[&_tr>*:last-child]:z-[1]',
  '[&_tbody_tr>*:last-child]:bg-[var(--ap-surface-1)]',
  '[&_thead_tr>*:last-child]:bg-[var(--ap-surface-2)]',
].join(' ');

export function Table({ head, children, minWidth = 640 }: { head: ReactNode[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className={`${T.surface} overflow-x-auto`}>
      <table className={`w-full border-collapse ${STICKY_ACTIONS}`} style={{ minWidth }}>
        <thead className={T.tableHead}>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={cellHead} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ap-hairline)]">{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>{text}</div>;
}

const TONE_BADGE: Record<Tone | 'neutral' | 'accent', string> = {
  ok: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]',
  warn: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  bad: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  info: 'text-[var(--ap-info)] bg-[var(--ap-info-bg)] border-[var(--ap-info-border)]',
  accent: 'text-[var(--ap-accent-text)] bg-[var(--ap-accent-soft)] border-[var(--ap-accent-border)]',
  neutral: 'text-[var(--ap-text-2)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone | 'neutral' | 'accent'; children: ReactNode; title?: string }) {
  return (
    <span className={`${T.badgeBase} ${TONE_BADGE[tone]}`} title={title}>
      {children}
    </span>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { loc } = useLoc();
  return <Badge tone={active ? 'ok' : 'neutral'}>{active ? loc('مفعّل', 'Active', 'چالاک') : loc('معطّل', 'Inactive', 'ناچالاک')}</Badge>;
}

const TONE_NOTICE: Record<Tone, { box: string; Icon: typeof Info }> = {
  ok: { box: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]', Icon: CheckCircle2 },
  warn: { box: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]', Icon: AlertTriangle },
  bad: { box: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]', Icon: AlertTriangle },
  info: { box: 'text-[var(--ap-info)] bg-[var(--ap-info-bg)] border-[var(--ap-info-border)]', Icon: Info },
};

/**
 * The page's result line. The live region is MOUNTED ALWAYS and only its text
 * changes: a `role="status"` element that appears together with its message
 * is, in most screen readers, not announced at all — the region has to exist
 * before the text lands in it. The visual box is a separate, aria-hidden
 * element so the message is not read twice.
 */
export function Notice({ notice, onClose }: { notice: NoticeState | null; onClose: () => void }) {
  const { loc } = useLoc();
  const { box, Icon } = TONE_NOTICE[notice?.tone ?? 'info'];
  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {notice?.text ?? ''}
      </div>
      {notice && (
        <div
          aria-hidden
          className={`flex items-start gap-2.5 rounded-[var(--ap-radius-md)] border px-3 py-2.5 text-[13px] ${box}`}
          data-tax-notice={notice.tone}
        >
          <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1 min-w-0 break-words">{notice.text}</span>
          <button type="button" onClick={onClose} aria-hidden tabIndex={-1} className={T.btnIconGhost} aria-label={loc('إغلاق', 'Close', 'داخستن')}>
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}

/** Label + control, stacked; the label is a real <label> for the control id. */
export function FieldRow({
  id,
  label,
  hint,
  required,
  children,
  ltr,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  /** The VALUE is Latin (slug, tag): keep the control LTR on an RTL page. */
  ltr?: boolean;
}) {
  // The hint carries real consequences ("renaming rewrites 12 products"), so
  // it is bound to the control rather than left as loose text beside it.
  const hintId = `${id}-hint`;
  const described =
    hint && React.isValidElement(children)
      ? React.cloneElement(children as React.ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': hintId })
      : children;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block mb-1 text-[12px] font-semibold text-[var(--ap-text-2)]">
        {label}
        {required && <span className="text-[var(--ap-danger)] ms-1">*</span>}
      </label>
      <div dir={ltr ? 'ltr' : undefined} className="min-w-0">
        {described}
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-[11px] text-[var(--ap-text-3)]">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Check({ id, label, checked, onChange, hint }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  // The hint sits OUTSIDE the <label>: text inside it joins the checkbox's
  // accessible name, so "مفعّل" would be announced as the whole paragraph.
  const hintId = `${id}-hint`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="flex items-start gap-2.5 cursor-pointer select-none min-w-0">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={hint ? hintId : undefined}
          className="mt-0.5 h-4 w-4 accent-[var(--ap-accent)]"
        />
        <span className="min-w-0 text-[13px] text-[var(--ap-text-1)]">{label}</span>
      </label>
      {hint && (
        <p id={hintId} className="ms-6.5 text-[11px] text-[var(--ap-text-3)]">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * An editing dialog with the standard footer (cancel / save), an inline
 * error line and a busy state. `onSave` throws to show the error in place.
 */
export function Dialog({
  titleAr,
  titleEn,
  onClose,
  onSave,
  saveLabel,
  dirty,
  children,
  wide,
  danger,
  testId,
}: {
  titleAr: string;
  titleEn: string;
  onClose: () => void;
  onSave: () => Promise<void>;
  saveLabel?: string;
  dirty?: boolean;
  children: ReactNode;
  wide?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  const { loc } = useLoc();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      titleAr={titleAr}
      titleEn={titleEn}
      onClose={onClose}
      wide={wide}
      dirty={dirty}
      footer={
        <div className={`${T.AP} flex items-center justify-end gap-2`} data-tax-dialog={testId}>
          {err && (
            <span className="me-auto text-[12px] text-[var(--ap-danger)] break-words min-w-0" role="alert">
              {err}
            </span>
          )}
          <button type="button" className={T.btnSecondary} onClick={onClose} disabled={busy}>
            {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
          </button>
          <button type="button" className={danger ? T.btnDanger : T.btnPrimary} onClick={() => void save()} disabled={busy} data-tax-save>
            {busy && <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />}
            {saveLabel ?? loc('حفظ', 'Save', 'پاشەکەوت')}
          </button>
        </div>
      }
    >
      <div className={`${T.AP} grid gap-3.5`} data-tax-dialog-body={testId}>
        {children}
      </div>
    </Modal>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 mb-3">{children}</div>;
}

export function SearchBox({ value, onChange, placeholder, testId }: { value: string; onChange: (v: string) => void; placeholder: string; testId: string }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      data-tax-search={testId}
      className={`${T.input} w-full sm:w-64`}
    />
  );
}

/** A row's icon actions, right-aligned in LTR and left-aligned in RTL. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}

/** Deactivate/activate through the same POST the editor uses. */
export async function setActive(path: string, id: string, active: boolean): Promise<void> {
  await api.post(path, { id, active });
}
