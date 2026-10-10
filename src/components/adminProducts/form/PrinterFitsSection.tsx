/**
 * «يناسب الطابعات» — WHICH OF THE STORE'S PRINTERS THIS PART FITS (0148).
 *
 * The owner (2026-09-27): «في مواد الصيانة عند إضافة المنتج في الحقول يكون هذه
 * القطعة مخصصة لأي طابعه … مثلا الفوهة تكون مخصصة لطابعات متعددة مثل A1, A1
 * mini و A2L». One tap per printer, the way the owner said it — no ids, no
 * typing. What is chosen is a LINK (worker/lib/printerFits.ts), and it is what
 * the listing's printer filter, the printer page's shelf and the suggestions
 * for a customer who bought the printer all read.
 *
 * THE LIST IS THE CATALOGUE'S PRINTERS, EVERY STATUS: a part can be linked to a
 * printer before that printer is published (a hidden one is marked so). Used
 * units are one listing each, not a model, so they sit behind a disclosure.
 *
 * NOTHING STORED IS DROPPED FROM VIEW. A linked id that is no longer a printer
 * (its section changed) stays on screen, marked, with a remove button — the
 * server refuses to save it, and the owner must be able to see why.
 */
import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import * as T from '../theme';
import { api, failureText } from '../../../lib/api';

export interface PrinterOption {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  status: string;
  used: boolean;
}

/** One read per page load: the printer list changes when a printer is added, not per product. */
let cached: Promise<PrinterOption[]> | null = null;
function loadPrinters(force = false): Promise<PrinterOption[]> {
  if (!cached || force) {
    cached = api
      .get<{ printers: PrinterOption[] }>('/api/admin/products-v2/printer-options')
      .then((r) => r.printers ?? [])
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
}

const nameOf = (p: PrinterOption) => p.name_en || p.name_ar || p.slug;
const STATUS: Record<string, string> = { hidden: 'مخفية', draft: 'مسودة' };
const SEARCH_FROM = 10;

export default function PrinterFitsSection({
  value,
  onChange,
  productId,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** This product itself is never offered — a part cannot fit itself. */
  productId: string;
}) {
  const [printers, setPrinters] = useState<PrinterOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [showUsed, setShowUsed] = useState(false);

  const load = (force = false) => {
    setError(null);
    loadPrinters(force)
      .then(setPrinters)
      .catch((e) => setError(failureText(e, 'تعذّر تحميل الطابعات')));
  };
  useEffect(() => load(), []);

  const offered = useMemo(() => (printers ?? []).filter((p) => p.id !== productId), [printers, productId]);
  const byId = useMemo(() => new Map(offered.map((p) => [p.id, p])), [offered]);
  const q = term.trim().toLowerCase();
  const matches = (p: PrinterOption) =>
    !q || `${p.name_en} ${p.name_ar} ${p.name_ckb} ${p.slug}`.toLowerCase().includes(q);
  const models = offered.filter((p) => !p.used && matches(p));
  const used = offered.filter((p) => p.used && matches(p));
  // A used unit already linked is shown without opening the disclosure.
  const usedShown = showUsed || !!q ? used : used.filter((p) => value.includes(p.id));
  const unknown = printers ? value.filter((id) => !byId.has(id)) : [];

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  const chip = (p: PrinterOption) => {
    const on = value.includes(p.id);
    return (
      <button key={p.id} type="button" className={T.chip} aria-pressed={on} dir="ltr" onClick={() => toggle(p.id)} data-fit-printer={p.slug}>
        {nameOf(p)}
        {STATUS[p.status] ? <span className="text-[11px] text-text-muted" dir="rtl">· {STATUS[p.status]}</span> : null}
      </button>
    );
  };

  // Drawn as the first group of «المواصفات والمحتوى الإضافي», in that
  // section's own heading style, so it reads as one of its fields. `ap`
  // brings the editor's tokens with it: the form is rendered outside the
  // products list's `.ap` scope, and `T.chip` draws its pressed state from
  // `--ap-accent-*` — without them a chosen printer looks unchosen.
  return (
    <div className="ap min-w-0 mb-4" data-form="printer-fits">
      <h4 className="text-[13px] font-bold text-text-secondary mb-2 truncate">
        يناسب الطابعات <span className="text-[11px] font-medium text-text-muted">Compatible printers</span>
      </h4>
      <p className="text-[12px] text-text-muted mb-3">
        اختر كل طابعة تُركَّب عليها هذه القطعة. تظهر القطعة في صفحة كل طابعة مختارة، وفي فلتر «مواد الصيانة» حسب الطابعة،
        وتُقترح لمن اشترى الطابعة.
      </p>
      {error ? (
        <p className="text-[12px] text-red-300" role="alert">
          {error}{' '}
          <button type="button" className={T.btnGhostSm} onClick={() => load(true)}>
            إعادة المحاولة
          </button>
        </p>
      ) : printers === null ? (
        <p className="text-[12px] text-text-muted">جارٍ تحميل الطابعات…</p>
      ) : offered.length === 0 ? (
        <p className="text-[12px] text-text-muted">لا توجد طابعات في المتجر بعد — أضف الطابعة في قسم الطابعات أولًا، ثم اربط القطعة بها.</p>
      ) : (
        <div className="space-y-2 min-w-0">
          {value.length > 0 ? (
            <p className="text-[12px] text-text-muted" data-fit-summary>
              {value.length === 1 ? 'مختارة طابعة واحدة' : value.length === 2 ? 'مختارة طابعتان' : `مختارة ${value.length} طابعات`}:{' '}
              <span className="text-text-secondary" dir="ltr">
                {value.map((id) => (byId.get(id) ? nameOf(byId.get(id)!) : id)).join(' · ')}
              </span>
            </p>
          ) : null}
          {offered.length >= SEARCH_FROM ? (
            <label className="relative block">
              <span className="sr-only">ابحث عن طابعة</span>
              <Search aria-hidden="true" className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
              <input
                type="search"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="ابحث عن طابعة — A1، X1…"
                className={`${T.input} w-full ps-8`}
              />
            </label>
          ) : null}
          <div role="group" aria-label="يناسب الطابعات" className="flex flex-wrap gap-1.5">
            {models.map(chip)}
            {usedShown.map(chip)}
          </div>
          {used.length > 0 && !showUsed && !q ? (
            <button type="button" className={T.btnGhostSm} onClick={() => setShowUsed(true)}>
              طابعات مستعملة ({used.length})
            </button>
          ) : null}
          {q && models.length === 0 && used.length === 0 ? (
            <p className="text-[12px] text-text-muted">لا طابعة بهذا الاسم.</p>
          ) : null}
          {unknown.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-fit-unknown>
              {unknown.map((id) => (
                <button key={id} type="button" className={T.btnDanger} onClick={() => toggle(id)} title="لم تعد في قسم طابعات — أزلها ليُحفظ المنتج">
                  <span dir="ltr">{id}</span> · لم تعد طابعة
                  <X aria-hidden="true" className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
