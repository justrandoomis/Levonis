/**
 * استخراج من رابط — URL extraction (v2). Deterministic server-side extraction
 * (json-ld / og / meta / title). NOTHING is auto-applied: every field has its
 * own checkbox, conflicting candidates are picked by radio, and price fields
 * are NEVER touched (the server never extracts them; this panel never writes
 * any *_iqd field). Unsupported pages get an honest note pointing to the
 * TXT template workflow.
 */

import React, { useState } from 'react';
import { Link2, AlertTriangle, CheckSquare } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { MediaV2, SpecRowV2 } from '../../lib/productTypes';
import { uid, type EditorDoc } from './types';
import type { ExtractResponse, ExtractField, ExtractSpecEntry } from './types';
import { L, Section, inputCls, btnPrimary } from './ui';

type SetDoc = React.Dispatch<React.SetStateAction<EditorDoc>>;
type Lang = 'ar' | 'en' | 'ckb';

const SOURCE_STYLE: Record<string, string> = {
  'json-ld': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  og: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  meta: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
  title: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40',
};

const FIELD_AR: Record<string, string> = {
  name: 'الاسم', description: 'الوصف', brand: 'العلامة (نص)', sku: 'SKU', gtin: 'GTIN',
  model: 'الموديل', material: 'الخامة', colors: 'ألوان مذكورة', images: 'صور الصفحة', specs: 'مواصفات',
};

/** Fields applied as text into a language column (admin picks the language). */
const LANG_FIELDS = new Set(['name', 'description']);
/** Fields applied as rows of an "extracted data" spec group. */
const SPECLIKE_FIELDS = new Set(['brand', 'sku', 'gtin', 'model', 'material']);

export default function ExtractPanel({ setDoc }: { setDoc: SetDoc }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<ExtractResponse | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [langChoice, setLangChoice] = useState<Record<string, Lang>>({});
  const [candChoice, setCandChoice] = useState<Record<string, number>>({});
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  const run = async () => {
    if (!url.trim() || loading) return;
    setLoading(true); setError(null); setRes(null); setChecked({}); setCandChoice({}); setAppliedNote(null);
    try {
      const data = await api.post<ExtractResponse>('/api/admin/extract-v2', { url: url.trim() });
      setRes(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'فشل الاستخراج / extraction failed');
    } finally {
      setLoading(false);
    }
  };

  const fieldValue = (f: ExtractField): ExtractField['value'] => {
    const pick = candChoice[f.field];
    if (pick !== undefined && f.candidates && f.candidates[pick]) return f.candidates[pick].value;
    return f.value;
  };

  const applySelected = () => {
    if (!res) return;
    const applied = Object.values(checked).filter(Boolean).length;
    setDoc((d) => {
      let next: EditorDoc = { ...d };
      const specRows: SpecRowV2[] = [];

      for (const f of res.fields) {
        if (!checked[`field:${f.field}`]) continue;
        const v = fieldValue(f);
        if (v === null || v === undefined) continue;

        if (LANG_FIELDS.has(f.field) && typeof v === 'string') {
          const lang = langChoice[f.field] ?? 'en';
          if (f.field === 'name') next = { ...next, [`name_${lang}`]: v } as EditorDoc;
          else next = { ...next, [`description_${lang}`]: v } as EditorDoc;
        } else if (SPECLIKE_FIELDS.has(f.field) && typeof v === 'string') {
          specRows.push({
            id: uid('sr'), label_ar: '', label_en: f.field, label_ckb: '',
            value_ar: '', value_en: v, value_ckb: '', unit: '', order: 0,
          });
        } else if (f.field === 'specs' && Array.isArray(v)) {
          for (const s of v as ExtractSpecEntry[]) {
            if (!s || typeof s.name !== 'string') continue;
            specRows.push({
              id: uid('sr'), label_ar: '', label_en: s.name, label_ckb: '',
              value_ar: '', value_en: String(s.value ?? ''), value_ckb: '', unit: String(s.unit ?? ''), order: 0,
            });
          }
        } else if (f.field === 'colors' && Array.isArray(v)) {
          next = addColors(next, (v as string[]).filter((x) => typeof x === 'string'));
        }
      }

      for (const [i, p] of res.proposed_colors.entries()) {
        if (checked[`pcolor:${i}`]) next = addColors(next, [p.name]);
      }
      for (const [i, p] of res.proposed_options.entries()) {
        if (checked[`poption:${i}`]) next = addOption(next, p.name);
      }
      for (const m of res.media) {
        if (m.status === 'stored' && m.url && checked[`media:${m.source_url}`]) {
          if (!next.media.some((x) => x.url === m.url)) {
            const item: MediaV2 = {
              id: uid('img'), url: m.url, key: m.key ?? '', role: 'gallery',
              alt_ar: '', alt_en: '', alt_ckb: '', order: next.media.length,
              primary: next.media.length === 0, width: null, height: null,
              source_url: m.source_url,
            };
            next = { ...next, media: [...next.media, item] };
          }
        }
      }

      if (specRows.length) {
        const gi = next.spec_groups.findIndex((g) => g.title_en === 'Extracted data');
        if (gi >= 0) {
          const g = next.spec_groups[gi];
          const rows = [...g.rows, ...specRows].map((r, i) => ({ ...r, order: i }));
          next = { ...next, spec_groups: next.spec_groups.map((x, i) => (i === gi ? { ...x, rows } : x)) };
        } else {
          next = {
            ...next,
            spec_groups: [...next.spec_groups, {
              id: uid('sg'), title_ar: 'بيانات مستخرجة', title_en: 'Extracted data', title_ckb: '',
              order: next.spec_groups.length,
              rows: specRows.map((r, i) => ({ ...r, order: i })),
            }],
          };
        }
      }
      return next;
    });
    setChecked({});
    setAppliedNote(
      applied > 0
        ? 'طُبّقت العناصر المحددة على النموذج — لم يُحفظ شيء بعد، راجِع ثم احفظ. / Applied to the form; nothing saved yet.'
        : 'لم يُحدد أي عنصر. / Nothing was selected.'
    );
  };

  const anyChecked = Object.values(checked).some(Boolean);
  const priceWarnings = (res?.warnings ?? []).filter((w) => w.kind === 'possible_price_text');

  return (
    <Section ar="استخراج من رابط" en="Extract from URL">
      <p className="text-xs text-zinc-500 mb-3">
        الاستخراج لا يُطبّق شيئاً تلقائياً ولا يلمس أي حقل سعر أبداً — أنت تختار كل عنصر بنفسك.
        <span className="mx-1">Nothing auto-applies and price fields are never touched.</span>
      </p>
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <input
          value={url} dir="ltr" placeholder="https://example.com/product/…"
          onChange={(e) => setUrl(e.target.value)}
          className={inputCls + ' flex-1'}
        />
        <button type="button" onClick={run} disabled={loading || !url.trim()} className={btnPrimary}>
          <Link2 className="w-4 h-4" /> {loading ? 'جارٍ الاستخراج…' : 'استخراج / extract'}
        </button>
      </div>
      {error && <div className="text-red-400 text-sm mb-3">{error}</div>}

      {res?.unsupported && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-xl p-4 text-sm">
          <div className="font-bold mb-1 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> تعذّر قراءة هذه الصفحة / page not readable
          </div>
          <p className="text-amber-300/80 text-xs whitespace-pre-wrap">{res.message}</p>
          <p className="text-amber-300/80 text-xs mt-2">
            استخدم سير عمل قالب TXT: نزّل القالب من قسم «استيراد وتصدير»، املأه، ثم ارفعه.
          </p>
        </div>
      )}

      {res && !res.unsupported && (
        <div>
          {priceWarnings.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-xl p-3 mb-4 text-xs">
              <div className="font-bold flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4" />
                النص المستخرج قد يتضمن أسعاراً — راجعه يدوياً، لن يُكتب أي سعر تلقائياً.
                <span className="text-amber-400/70">possible price text</span>
              </div>
              <ul className="list-disc ms-5 text-amber-300/80">
                {priceWarnings.map((w, i) => (
                  <li key={`${w.field}-${i}`} dir="auto">{w.field}: «{w.snippet}»</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
            {res.fields.map((f) => (
              <FieldCard
                key={f.field}
                f={f}
                checked={!!checked[`field:${f.field}`]}
                onCheck={(v) => setChecked((c) => ({ ...c, [`field:${f.field}`]: v }))}
                lang={langChoice[f.field] ?? 'en'}
                onLang={(l) => setLangChoice((c) => ({ ...c, [f.field]: l }))}
                cand={candChoice[f.field]}
                onCand={(i) => setCandChoice((c) => ({ ...c, [f.field]: i }))}
                value={fieldValue(f)}
              />
            ))}
          </div>

          {(res.proposed_options.length > 0 || res.proposed_colors.length > 0) && (
            <div className="mb-4">
              <L ar="مقترحات الخيارات والألوان" en="Proposed options & colors" hint="أسماء فقط — لا أسعار ولا HEX مُخمَّن / names only, no prices, no guessed hex" />
              <div className="flex flex-wrap gap-2">
                {res.proposed_options.map((p, i) => (
                  <label key={`po-${p.name}`} className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-full px-3 py-1.5 cursor-pointer text-sm text-zinc-200">
                    <input type="checkbox" checked={!!checked[`poption:${i}`]} onChange={(e) => setChecked((c) => ({ ...c, [`poption:${i}`]: e.target.checked }))} className="accent-[#6B46FF]" />
                    خيار: {p.name}
                  </label>
                ))}
                {res.proposed_colors.map((p, i) => (
                  <label key={`pc-${p.name}`} className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-full px-3 py-1.5 cursor-pointer text-sm text-zinc-200">
                    <input type="checkbox" checked={!!checked[`pcolor:${i}`]} onChange={(e) => setChecked((c) => ({ ...c, [`pcolor:${i}`]: e.target.checked }))} className="accent-[#6B46FF]" />
                    لون: {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {res.media.length > 0 && (
            <div className="mb-4">
              <L ar="الوسائط المجلوبة" en="Fetched media" hint="حدد ما يُضاف إلى المعرض / select what joins the gallery" />
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {res.media.map((m) => (
                  <div key={m.source_url} className="border border-zinc-700 rounded-xl overflow-hidden bg-zinc-900">
                    {m.status === 'stored' && m.url ? (
                      <label className="block cursor-pointer">
                        <img referrerPolicy="no-referrer" src={m.url} className="w-full aspect-square object-cover" alt="" />
                        <span className="flex items-center gap-2 p-2 text-xs text-zinc-300">
                          <input type="checkbox" checked={!!checked[`media:${m.source_url}`]} onChange={(e) => setChecked((c) => ({ ...c, [`media:${m.source_url}`]: e.target.checked }))} className="accent-[#6B46FF]" />
                          إضافة / add
                        </span>
                      </label>
                    ) : (
                      <div className="p-2 text-[11px] text-red-400">
                        فشل الجلب / failed
                        <div className="text-zinc-500 break-all">{m.reason || m.source_url}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={applySelected} disabled={!anyChecked} className={btnPrimary}>
              <CheckSquare className="w-4 h-4" /> تطبيق المحدد على النموذج / apply selected
            </button>
            <span className="text-[11px] text-zinc-500">
              لا يُحفظ شيء حتى تضغط «حفظ». حقول الأسعار لا تُمسّ أبداً.
            </span>
          </div>
          {appliedNote && <div className="text-emerald-400 text-sm mt-2">{appliedNote}</div>}
        </div>
      )}
    </Section>
  );
}

function FieldCard({
  f, checked, onCheck, lang, onLang, cand, onCand, value,
}: {
  f: ExtractField;
  checked: boolean;
  onCheck: (v: boolean) => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  cand: number | undefined;
  onCand: (i: number) => void;
  value: ExtractField['value'];
}) {
  const applyable = f.status !== 'missing' && f.field !== 'images';
  return (
    <div className={`border rounded-xl p-3 ${f.status === 'missing' ? 'border-zinc-800 opacity-60' : 'border-zinc-700 bg-zinc-900'}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <label className="flex items-center gap-2 cursor-pointer">
          {applyable && (
            <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} className="w-4 h-4 accent-[#6B46FF]" />
          )}
          <span className="text-sm font-bold text-zinc-200">
            {FIELD_AR[f.field] ?? f.field} <span className="text-[10px] text-zinc-500">{f.field}</span>
          </span>
        </label>
        <span className="flex items-center gap-1.5">
          {f.source && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${SOURCE_STYLE[f.source] ?? SOURCE_STYLE.title}`}>
              {f.source}
            </span>
          )}
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
            f.status === 'extracted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
            : f.status === 'conflicting' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
            : 'bg-zinc-800 text-zinc-500 border-zinc-700'
          }`}>
            {f.status === 'extracted' ? 'مستخرج' : f.status === 'conflicting' ? 'متضارب' : 'مفقود'}
          </span>
        </span>
      </div>

      {f.status === 'missing' ? (
        <div className="text-xs text-zinc-600">لا قيمة / no value</div>
      ) : (
        <div>
          {f.candidates && f.candidates.length > 1 ? (
            <div className="flex flex-col gap-1.5 mb-2">
              {f.candidates.map((c, i) => (
                <label key={`${c.source}-${i}`} className="flex items-start gap-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="radio" name={`cand-${f.field}`}
                    checked={(cand ?? 0) === i}
                    onChange={() => onCand(i)}
                    className="mt-0.5 accent-[#6B46FF]"
                  />
                  <span className={`text-[9px] font-bold px-1 py-0.5 rounded border shrink-0 ${SOURCE_STYLE[c.source] ?? SOURCE_STYLE.title}`}>{c.source}</span>
                  <span dir="auto" className="break-words">{renderValue(c.value)}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="text-xs text-zinc-300 break-words max-h-28 overflow-y-auto" dir="auto">{renderValue(value)}</div>
          )}

          {applyable && LANG_FIELDS.has(f.field) && (
            <div className="flex items-center gap-1 mt-2">
              <span className="text-[10px] text-zinc-500">يُكتب إلى / write into:</span>
              {(['ar', 'en', 'ckb'] as const).map((l) => (
                <button
                  key={l} type="button" onClick={() => onLang(l)}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                    lang === l ? 'bg-[#6B46FF] border-[#6B46FF] text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
          {applyable && SPECLIKE_FIELDS.has(f.field) && (
            <div className="text-[10px] text-zinc-500 mt-1">يُضاف كصف في «بيانات مستخرجة» / added as an extracted-data spec row</div>
          )}
          {f.field === 'images' && (
            <div className="text-[10px] text-zinc-500 mt-1">الصور تُدار من قائمة «الوسائط المجلوبة» أدناه / use the fetched-media list below</div>
          )}
        </div>
      )}
    </div>
  );
}

function renderValue(v: ExtractField['value'] | string | string[]): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object') {
      return (v as ExtractSpecEntry[]).map((s) => `${s.name}: ${s.value}${s.unit ? ` ${s.unit}` : ''}`).join(' · ');
    }
    return (v as string[]).join(' · ');
  }
  return String(v);
}

// ---------------------------------------------------------------- doc mutators

function addColors(d: EditorDoc, names: string[]): EditorDoc {
  let colors = d.colors;
  for (const name of names) {
    const n = name.trim();
    if (!n) continue;
    if (colors.some((c) => c.name_en.toLowerCase() === n.toLowerCase())) continue;
    colors = [...colors, {
      id: uid('col'), name_ar: '', name_en: n, name_ckb: '', hex: '', image: '', option_id: null,
      order: colors.length, active: true,
      regular_price_iqd: null, pro_price_iqd: null, compare_at_iqd: null, cost_iqd: null,
    }];
  }
  return colors === d.colors ? d : { ...d, colors };
}

function addOption(d: EditorDoc, name: string): EditorDoc {
  const n = name.trim();
  if (!n || d.options.some((o) => o.name_en.toLowerCase() === n.toLowerCase())) return d;
  return {
    ...d,
    options: [...d.options, {
      id: uid('opt'), name_ar: '', name_en: n, name_ckb: '', image: '',
      order: d.options.length, active: true,
      regular_price_iqd: null, pro_price_iqd: null, compare_at_iqd: null, cost_iqd: null,
    }],
  };
}
