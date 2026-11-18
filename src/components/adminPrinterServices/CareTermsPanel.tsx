/**
 * «شروط ليفو كير» and the inspection's labour cost (printer phase 3, DECISIONS
 * row 347) — two more panels of the shared price list, editing the same draft
 * (`upd`); the parent's fieldset disables them for a non-owner.
 *
 * The terms are what a Care claim gives: the parts the discount covers (each
 * named in Arabic, English and Kurdish), the discount, how many claims and how
 * many dinars of discount a device gets over its Care year (empty = no money
 * cap), whether labour and shipping are discounted, and what Care excludes.
 * Publishing FREEZES them under `care.policy_version`: the first terms ever
 * published are v1 for everyone already holding Care (owner ruling D1); terms
 * changed after that need a new version, which only new buyers get.
 *
 * The inspection labour is a report figure only (owner ruling D4): what one
 * completed inspection costs the shop; empty = «not configured».
 */
import {
  CARE_COVER_MODES,
  DEFAULT_CARE_TERMS,
  MAX_CARE_EXCLUSIONS,
  MAX_CARE_PARTS,
  type CareCoverMode,
  type CareTerms,
  type PrinterServicesConfig,
  type Text3,
} from '../../../packages/pricing/src/printerServices';

type Loc = (ar: string, en: string, ckb: string) => string;
type Upd = (fn: (d: PrinterServicesConfig) => void) => void;

const LANGS = ['ar', 'en', 'ckb'] as const;
const PART_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const emptyText = (): Text3 => ({ ar: '', en: '', ckb: '' });
const wholeOrNull = (v: string): number | null => { const t = v.replace(/[^\d]/g, ''); return t === '' ? null : Number(t); };

/** The three-language text inputs of one label or exclusion. */
function Text3Inputs({ value, onChange, max, loc, label }: { value: Text3; onChange: (t: Text3) => void; max: number; loc: Loc; label: string }) {
  const name: Record<(typeof LANGS)[number], string> = { ar: loc('عربي', 'Arabic', 'عەرەبی'), en: loc('إنجليزي', 'English', 'ئینگلیزی'), ckb: loc('كردي', 'Kurdish', 'کوردی') };
  return (
    <div className="grid gap-1 sm:grid-cols-3">
      {LANGS.map((l) => (
        <input
          key={l}
          className="lv-input h-9 px-2 text-[12px]"
          dir={l === 'en' ? 'ltr' : 'rtl'}
          lang={l}
          maxLength={max}
          value={value[l]}
          placeholder={name[l]}
          aria-label={`${label} · ${name[l]}`}
          onChange={(e) => onChange({ ...value, [l]: e.target.value })}
        />
      ))}
    </div>
  );
}

export function CareTermsPanel({ draft, upd, loc, published }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; published: PrinterServicesConfig | null }) {
  const terms = draft.care.terms ?? null;
  const set = (fn: (t: CareTerms) => void) => upd((d) => { if (d.care.terms) fn(d.care.terms); });
  // The published version's terms are frozen: changed terms under the same version number would be refused at publish.
  const publishedTerms = published?.care.terms ?? null;
  const samePolicyVersion = !!publishedTerms && !!terms && published?.care.policy_version === draft.care.policy_version
    && JSON.stringify(publishedTerms) !== JSON.stringify(terms);
  const mode = (v: CareCoverMode) => (v === 'discounted' ? loc('مشمول بالخصم', 'Discounted', 'داشکاندن دەیگرێتەوە') : loc('بالسعر الكامل', 'Full price', 'بە نرخی تەواو'));
  const keyIssues = (terms?.eligible_parts ?? []).map((p, i, all) => (!PART_KEY.test(p.key) ? 'bad' : all.findIndex((q) => q.key === p.key) !== i ? 'dup' : null));

  return (
    <section className="space-y-3" data-care-terms-panel>
      {/* The group that holds this panel already says «شروط ليفو كير»: no second heading here. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          {loc('إصدار الشروط', 'Terms version', 'وەشانی مەرجەکان')}
          <input
            className="lv-input h-9 w-20 px-2 tabular-nums"
            inputMode="numeric"
            dir="ltr"
            value={String(draft.care.policy_version)}
            onChange={(e) => { const n = wholeOrNull(e.target.value); upd((d) => { d.care.policy_version = Math.max(1, n ?? 1); }); }}
            data-care-policy-version
          />
        </label>
      </div>
      <p className="text-[12px] text-text-secondary leading-relaxed" data-care-terms-hint>
        {loc(
          'عند النشر تُجمَّد هذه الشروط على رقم الإصدار: أول شروط تُنشر تصبح الإصدار 1 لكل من اشترى ليفو كير. أي تعديل بعد النشر يحتاج رقم إصدار أعلى، ويسري على المشترين الجدد فقط.',
          'Publishing freezes these terms under the version number: the first terms published become version 1 for everyone who bought Levo Care. Any change after publishing needs a higher version, which applies to new buyers only.',
          'لە کاتی بڵاوکردنەوەدا ئەم مەرجانە لەسەر ژمارەی وەشان دەچەسپێنرێن: یەکەم مەرجی بڵاوکراوە دەبێتە وەشانی 1 بۆ هەموو ئەوانەی لیڤۆ کێریان کڕیوە. هەر گۆڕانکارییەک دوای بڵاوکردنەوە پێویستی بە ژمارەی وەشانی بەرزترە، و تەنها بۆ کڕیارە نوێیەکان دەبێت.'
        )}
      </p>
      {samePolicyVersion && (
        <p className="rounded-md border border-border-subtle p-2 text-[12px] font-semibold text-text-primary" role="note" data-care-terms-changed>
          {loc(
            'غيّرت شروطاً منشورة: ارفع رقم الإصدار قبل النشر، وإلا رُفض النشر.',
            'You changed published terms: raise the version number before publishing, or the publish is refused.',
            'مەرجێکی بڵاوکراوەت گۆڕی: پێش بڵاوکردنەوە ژمارەی وەشان بەرز بکەرەوە، ئەگینا بڵاوکردنەوەکە ڕەت دەکرێتەوە.'
          )}
        </p>
      )}

      {!terms ? (
        <div className="space-y-2">
          <p className="text-[12px] text-text-secondary">
            {loc('لم تُكتب الشروط بعد — لا يُنشر ليفو كير بسعر دونها.', 'No terms written yet — a priced Levo Care cannot be published without them.', 'هێشتا مەرجەکان نەنووسراون — لیڤۆ کێری بە نرخ بەبێ ئەوان بڵاو ناکرێتەوە.')}
          </p>
          <button type="button" className="lv-button lv-button-secondary" onClick={() => upd((d) => { d.care.terms = JSON.parse(JSON.stringify(DEFAULT_CARE_TERMS)) as CareTerms; })} data-care-terms-start>
            {loc('ابدأ من الشروط المقترحة', 'Start from the suggested terms', 'لە مەرجە پێشنیارکراوەکانەوە دەست پێبکە')}
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
              {loc(`نسبة الخصم % (حتى ${draft.care.max_discount_pct})`, `Discount % (up to ${draft.care.max_discount_pct})`, `ڕێژەی داشکاندن % (تا ${draft.care.max_discount_pct})`)}
              <input className="lv-input h-10 px-2 tabular-nums" inputMode="numeric" dir="ltr" value={String(terms.discount_pct)}
                onChange={(e) => set((t) => { t.discount_pct = Math.min(draft.care.max_discount_pct, wholeOrNull(e.target.value) ?? 0); })} data-care-discount />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
              {loc('أقصى عدد مطالبات للجهاز (1–100)', 'Most claims per device (1–100)', 'زۆرترین داواکاری بۆ هەر ئامێرێک (1–100)')}
              <input className="lv-input h-10 px-2 tabular-nums" inputMode="numeric" dir="ltr" value={String(terms.max_claims)}
                onChange={(e) => set((t) => { t.max_claims = Math.max(1, Math.min(100, wholeOrNull(e.target.value) ?? 1)); })} data-care-max-claims />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
              {loc('أقصى خصم للجهاز بالدينار (فارغ = بلا سقف)', 'Most discount per device, IQD (empty = no cap)', 'زۆرترین داشکاندن بۆ هەر ئامێرێک بە دینار (بەتاڵ = بێ سنوور)')}
              <input className="lv-input h-10 px-2 tabular-nums" inputMode="numeric" dir="ltr" value={terms.max_benefit_iqd == null ? '' : String(terms.max_benefit_iqd)}
                onChange={(e) => set((t) => { t.max_benefit_iqd = wholeOrNull(e.target.value); })} data-care-max-benefit />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(['labor', 'shipping'] as const).map((f) => (
                <label key={f} className="flex flex-col gap-1 text-[12px] text-text-secondary">
                  {f === 'labor' ? loc('أجرة العمل', 'Labour', 'کرێی کار') : loc('الشحن', 'Shipping', 'ناردن')}
                  <select className="lv-input h-10 px-2 text-[12px]" value={terms[f]} onChange={(e) => set((t) => { t[f] = e.target.value as CareCoverMode; })} data-care-cover={f}>
                    {CARE_COVER_MODES.map((m) => <option key={m} value={m}>{mode(m)}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2" data-care-parts>
            <h3 className="text-[13px] font-semibold text-text-primary">
              {loc('القطع المشمولة بالخصم', 'Parts the discount covers', 'ئەو پارچانەی داشکاندن دەیانگرێتەوە')}
              <span className="ms-2 text-[11px] font-normal text-text-muted">{loc('ما سواها يُسعَّر كاملاً في «أخرى»', 'anything else is priced in full under «Other»', 'هەر شتێکی تر بە نرخی تەواو لە «هی تر» دەبێت')}</span>
            </h3>
            {terms.eligible_parts.map((p, i) => (
              <div key={i} className="rounded-md border border-border-subtle p-2 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="lv-input h-9 w-40 px-2 text-[12px] font-mono"
                    dir="ltr"
                    maxLength={32}
                    value={p.key}
                    aria-label={loc('المعرّف', 'Key', 'ناسنامە')}
                    placeholder="nozzle"
                    onChange={(e) => set((t) => { t.eligible_parts[i].key = e.target.value.toLowerCase(); })}
                  />
                  {keyIssues[i] && (
                    <span className="text-[11px] text-text-primary" role="note">
                      {keyIssues[i] === 'dup'
                        ? loc('المعرّف مستخدم لقطعة أخرى', 'the key is used by another part', 'ناسنامەکە بۆ پارچەیەکی تر بەکارهاتووە')
                        : loc('حروف إنجليزية صغيرة وأرقام و _ أو -، حتى 32', 'lowercase letters, digits, _ or -, up to 32', 'پیتی بچووکی ئینگلیزی، ژمارە، _ یان -، تا 32')}
                    </span>
                  )}
                  <button type="button" className="ms-auto lv-button lv-button-ghost h-9 px-2 text-[12px]" onClick={() => set((t) => { t.eligible_parts.splice(i, 1); })}>
                    {loc('حذف', 'Remove', 'لابردن')}
                  </button>
                </div>
                <Text3Inputs value={p.label} max={80} loc={loc} label={loc('اسم القطعة', 'Part name', 'ناوی پارچە')} onChange={(label) => set((t) => { t.eligible_parts[i].label = label; })} />
              </div>
            ))}
            {terms.eligible_parts.length < MAX_CARE_PARTS && (
              <button type="button" className="lv-button lv-button-secondary text-[12px]" onClick={() => set((t) => { t.eligible_parts.push({ key: '', label: emptyText() }); })} data-care-add-part>
                {loc('إضافة قطعة', 'Add a part', 'زیادکردنی پارچە')}
              </button>
            )}
          </div>

          <div className="space-y-2" data-care-exclusions>
            <h3 className="text-[13px] font-semibold text-text-primary">{loc('ما لا يشمله ليفو كير', 'What Levo Care does not cover', 'ئەوەی لیڤۆ کێر نایگرێتەوە')}</h3>
            {terms.exclusions.map((x, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Text3Inputs value={x} max={200} loc={loc} label={loc(`استثناء ${i + 1}`, `Exclusion ${i + 1}`, `بەدەرکراوی ${i + 1}`)} onChange={(v) => set((t) => { t.exclusions[i] = v; })} />
                </div>
                <button type="button" className="lv-button lv-button-ghost h-9 px-2 text-[12px]" onClick={() => set((t) => { t.exclusions.splice(i, 1); })}>
                  {loc('حذف', 'Remove', 'لابردن')}
                </button>
              </div>
            ))}
            {terms.exclusions.length < MAX_CARE_EXCLUSIONS && (
              <button type="button" className="lv-button lv-button-secondary text-[12px]" onClick={() => set((t) => { t.exclusions.push(emptyText()); })}>
                {loc('إضافة استثناء', 'Add an exclusion', 'زیادکردنی بەدەرکراو')}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** What one completed pre-dispatch inspection costs the shop — read by the finance report only. */
export function InspectionLaborField({ draft, upd, loc }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc }) {
  const v = draft.inspection.labor_iqd ?? null;
  return (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary" data-inspection-labor>
      {loc('كلفة عمل الفحص الواحد (للتقارير فقط، فارغ = غير محدد)', 'Labour cost of one inspection (reports only, empty = not configured)', 'تێچووی کاری یەک پشکنین (تەنها بۆ ڕاپۆرت، بەتاڵ = دیاری نەکراوە)')}
      <input className="lv-input h-10 px-2 tabular-nums" inputMode="numeric" dir="ltr" value={v === null ? '' : String(v)}
        onChange={(e) => { const n = wholeOrNull(e.target.value); upd((d) => { d.inspection.labor_iqd = n; }); }} />
    </label>
  );
}

/** The Care-terms issues the server sends (`care.terms…`, `inspection.labor_iqd…`), in the reader's language; null when not one of them. */
export function careIssueText(issue: string, loc: Loc): string | null {
  const n1 = (v: string) => Number(v) + 1;
  const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    [/^care\.terms: write the Levo Care terms/, () => loc('اكتب شروط ليفو كير قبل نشره', 'write the Levo Care terms before publishing Care', 'پێش بڵاوکردنەوەی لیڤۆ کێر مەرجەکانی بنووسە')],
    [/^care\.terms\.eligible_parts\[(\d+)\]\.key: used twice/, (m) => loc(`القطعة ${n1(m[1])}: المعرّف مستخدم لقطعة أخرى`, `part ${n1(m[1])}: the key is used by another part`, `پارچەی ${n1(m[1])}: ناسنامەکە بۆ پارچەیەکی تر بەکارهاتووە`)],
    [/^care\.terms\.eligible_parts\[(\d+)\]\.key/, (m) => loc(`القطعة ${n1(m[1])}: المعرّف حروف إنجليزية صغيرة وأرقام و _ أو -، حتى 32`, `part ${n1(m[1])}: key of lowercase letters, digits, _ or -, up to 32`, `پارچەی ${n1(m[1])}: ناسنامە پیتی بچووکی ئینگلیزی، ژمارە، _ یان -، تا 32`)],
    [/^care\.terms\.eligible_parts\[(\d+)\]\.label/, (m) => loc(`القطعة ${n1(m[1])}: الاسم بثلاث لغات، حتى 80 حرفاً لكل منها`, `part ${n1(m[1])}: a name in three languages, up to 80 characters each`, `پارچەی ${n1(m[1])}: ناو بە سێ زمان، هەریەکە تا 80 پیت`)],
    [/^care\.terms\.eligible_parts: at most/, () => loc(`حتى ${MAX_CARE_PARTS} قطعة مشمولة`, `at most ${MAX_CARE_PARTS} covered parts`, `تا ${MAX_CARE_PARTS} پارچەی گیراوە`)],
    [/^care\.terms\.discount_pct/, () => loc('نسبة خصم ليفو كير بين 0 وأقصى خصم Care', 'the Levo Care discount is 0 to the Care maximum', 'داشکاندنی لیڤۆ کێر لە 0 تا زۆرترینی Care')],
    [/^care\.terms\.max_claims/, () => loc('أقصى عدد مطالبات من 1 إلى 100', 'most claims 1 to 100', 'زۆرترین داواکاری لە 1 تا 100')],
    [/^care\.terms\.max_benefit_iqd/, () => loc('أقصى خصم للجهاز: دينار صحيح أو فارغ', 'most discount per device: whole IQD or empty', 'زۆرترین داشکاندن بۆ ئامێر: دیناری تەواو یان بەتاڵ')],
    [/^care\.terms\.(labor|shipping)/, () => loc('أجرة العمل والشحن: مشمول بالخصم أو بالسعر الكامل', 'labour and shipping: discounted or full price', 'کرێی کار و ناردن: داشکاندن دەیگرێتەوە یان بە نرخی تەواو')],
    [/^care\.terms\.exclusions\[(\d+)\]/, (m) => loc(`الاستثناء ${n1(m[1])}: بثلاث لغات، حتى 200 حرف لكل منها`, `exclusion ${n1(m[1])}: three languages, up to 200 characters each`, `بەدەرکراوی ${n1(m[1])}: بە سێ زمان، هەریەکە تا 200 پیت`)],
    [/^care\.terms\.exclusions: at most/, () => loc(`حتى ${MAX_CARE_EXCLUSIONS} استثناءً`, `at most ${MAX_CARE_EXCLUSIONS} exclusions`, `تا ${MAX_CARE_EXCLUSIONS} بەدەرکراو`)],
    [/^inspection\.labor_iqd/, () => loc('كلفة عمل الفحص: دينار صحيح أو فارغ', 'inspection labour cost: whole IQD or empty', 'تێچووی کاری پشکنین: دیناری تەواو یان بەتاڵ')],
  ];
  for (const [re, say] of rules) {
    const m = re.exec(issue);
    if (m) return say(m);
  }
  return null;
}
