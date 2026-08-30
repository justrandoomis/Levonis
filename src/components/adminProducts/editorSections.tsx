/**
 * Repeatable-group sections of the v2 product editor:
 * الخيارات، الألوان، الصور، المواصفات، الملصقات، خطط الضمان، محتوى أسفل الصفحة.
 *
 * Option/color prices REPLACE the applicable base price; null = inherit down
 * the chain color → option → base per field (empty input = null, 0 explicit).
 */

import React, { useState } from 'react';
import { Plus, Star, Image as ImageIcon, Play } from 'lucide-react';
import type {
  OptionV2, ColorV2, MediaV2, SpecGroupV2, SpecRowV2, LabelV2, WarrantyPlanV2, ContentBlockV2, PriceFieldsV2,
} from '../../lib/productTypes';
import { uid, type EditorDoc } from './types';
import {
  L, Section, NullableIqd, TriText, RowControls, ActiveToggle, inputCls, btnSecondary, uploadProductImage,
} from './ui';

type SetDoc = React.Dispatch<React.SetStateAction<EditorDoc>>;

// ---------------------------------------------------------------- list helpers

function moved<T extends { order: number }>(arr: T[], idx: number, delta: number): T[] {
  const j = idx + delta;
  if (j < 0 || j >= arr.length) return arr;
  const next = [...arr];
  const tmp = next[idx];
  next[idx] = next[j];
  next[j] = tmp;
  return next.map((x, i) => ({ ...x, order: i }));
}

function removedAt<T extends { order: number }>(arr: T[], idx: number): T[] {
  return arr.filter((_, i) => i !== idx).map((x, i) => ({ ...x, order: i }));
}

// ---------------------------------------------------------------- price quad

const PRICE_LABELS: Array<{ key: keyof PriceFieldsV2; ar: string; en: string }> = [
  { key: 'regular_price_iqd', ar: 'السعر العادي', en: 'Regular (IQD)' },
  { key: 'prime_price_iqd', ar: 'سعر PRIME', en: 'PRIME (IQD)' },
  { key: 'pro_price_iqd', ar: 'سعر PRO', en: 'PRO (IQD)' },
  { key: 'cost_iqd', ar: 'الكلفة (إداري)', en: 'Cost (admin)' },
];

function PriceQuad({ item, onField }: {
  item: PriceFieldsV2;
  onField: (key: keyof PriceFieldsV2, v: number | null) => void;
}) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {PRICE_LABELS.map((p) => (
        <div key={p.key}>
          <L ar={p.ar} en={p.en} />
          <NullableIqd value={item[p.key]} onChange={(v) => onField(p.key, v)} />
        </div>
      ))}
    </div>
  );
}

function ImagePicker({ url, onUrl }: { url: string; onUrl: (u: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <div className="flex gap-2 items-center">
        {url ? (
          <img referrerPolicy="no-referrer" src={url} className="w-12 h-12 rounded-lg object-cover border border-zinc-700 bg-zinc-900" alt="" />
        ) : (
          <div className="w-12 h-12 rounded-lg border border-dashed border-zinc-700 flex items-center justify-center text-zinc-600">
            <ImageIcon className="w-5 h-5" />
          </div>
        )}
        <label className={btnSecondary + ' cursor-pointer text-sm'}>
          {busy ? 'جارٍ الرفع…' : 'صورة / image'}
          <input type="file" className="hidden" accept="image/*" disabled={busy} onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setBusy(true); setErr(null);
            try { onUrl((await uploadProductImage(f)).url); }
            catch (ex) { setErr(ex instanceof Error ? ex.message : 'upload failed'); }
            finally { setBusy(false); }
          }} />
        </label>
        {url && (
          <button type="button" className="text-xs text-zinc-500 hover:text-red-400" onClick={() => onUrl('')}>
            إزالة / clear
          </button>
        )}
      </div>
      {err && <div className="text-red-400 text-xs mt-1">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- الخيارات

export function OptionsSection({ doc, setDoc }: { doc: EditorDoc; setDoc: SetDoc }) {
  const upd = (idx: number, patch: Partial<OptionV2>) =>
    setDoc((d) => ({ ...d, options: d.options.map((o, i) => (i === idx ? { ...o, ...patch } : o)) }));

  return (
    <Section ar="الخيارات" en="Options" badge={<CountBadge n={doc.options.length} />}>
      <p className="text-xs text-zinc-500 mb-4">
        أسعار الخيار تستبدل السعر الأساسي (وليست إضافة). الحقل الفارغ = موروث من المنتج.
        <span className="mx-1">Option prices REPLACE the base price; empty = inherit.</span>
      </p>
      {doc.options.map((opt, idx) => (
        <div key={opt.id} className="bg-zinc-900 border border-zinc-700 p-4 rounded-xl mb-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <ActiveToggle value={opt.active} onChange={(v) => upd(idx, { active: v })} />
            <RowControls
              upDisabled={idx === 0}
              downDisabled={idx === doc.options.length - 1}
              onUp={() => setDoc((d) => ({ ...d, options: moved(d.options, idx, -1) }))}
              onDown={() => setDoc((d) => ({ ...d, options: moved(d.options, idx, +1) }))}
              onRemove={() => setDoc((d) => ({
                ...d,
                options: removedAt(d.options, idx),
                colors: d.colors.map((c) => (c.option_id === opt.id ? { ...c, option_id: null } : c)),
              }))}
            />
          </div>
          <div className="mb-3">
            <TriText
              labelAr="اسم الخيار" labelEn="Option name"
              ar={opt.name_ar} en={opt.name_en} ckb={opt.name_ckb}
              onAr={(v) => upd(idx, { name_ar: v })}
              onEn={(v) => upd(idx, { name_en: v })}
              onCkb={(v) => upd(idx, { name_ckb: v })}
            />
          </div>
          <div className="mb-3">
            <ImagePicker url={opt.image} onUrl={(u) => upd(idx, { image: u })} />
          </div>
          <PriceQuad item={opt} onField={(k, v) => upd(idx, { [k]: v } as Partial<OptionV2>)} />
        </div>
      ))}
      <AddButton ar="إضافة خيار" en="Add option" onClick={() => setDoc((d) => ({
        ...d,
        options: [...d.options, {
          id: uid('opt'), name_ar: '', name_en: '', name_ckb: '', image: '',
          order: d.options.length, active: true,
          regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        }],
      }))} />
    </Section>
  );
}

// ---------------------------------------------------------------- الألوان

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ColorsSection({ doc, setDoc }: { doc: EditorDoc; setDoc: SetDoc }) {
  const upd = (idx: number, patch: Partial<ColorV2>) =>
    setDoc((d) => ({ ...d, colors: d.colors.map((c, i) => (i === idx ? { ...c, ...patch } : c)) }));

  return (
    <Section ar="الألوان" en="Colors" badge={<CountBadge n={doc.colors.length} />}>
      <p className="text-xs text-zinc-500 mb-4">
        اللون قد يرتبط بخيار واحد أو يتاح للجميع. أسعاره تستبدل سعر الخيار/الأساسي؛ الفارغ = موروث.
        <span className="mx-1">Color prices replace option/base; empty = inherit.</span>
      </p>
      {doc.colors.map((col, idx) => (
        <div key={col.id} className="bg-zinc-900 border border-zinc-700 p-4 rounded-xl mb-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <ActiveToggle value={col.active} onChange={(v) => upd(idx, { active: v })} />
            <RowControls
              upDisabled={idx === 0}
              downDisabled={idx === doc.colors.length - 1}
              onUp={() => setDoc((d) => ({ ...d, colors: moved(d.colors, idx, -1) }))}
              onDown={() => setDoc((d) => ({ ...d, colors: moved(d.colors, idx, +1) }))}
              onRemove={() => setDoc((d) => ({ ...d, colors: removedAt(d.colors, idx) }))}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <div>
              <L ar="اللون HEX" en="#RRGGBB" />
              <div className="flex gap-2 items-center">
                <span
                  className="w-11 h-11 rounded-lg border border-zinc-700 shrink-0"
                  style={{ background: HEX_RE.test(col.hex) ? col.hex : '#27272a' }}
                  title={col.hex || 'no hex'}
                />
                <input
                  type="color"
                  value={HEX_RE.test(col.hex) ? col.hex : '#888888'}
                  onChange={(e) => upd(idx, { hex: e.target.value })}
                  className="w-11 h-11 rounded-lg cursor-pointer bg-zinc-900 border border-zinc-700 p-1 shrink-0"
                />
                <input
                  type="text" dir="ltr" placeholder="#000000"
                  value={col.hex}
                  onChange={(e) => upd(idx, { hex: e.target.value })}
                  className={inputCls + (col.hex && !HEX_RE.test(col.hex) ? ' border-amber-500/60' : '')}
                />
              </div>
              {col.hex && !HEX_RE.test(col.hex) && (
                <div className="text-amber-400 text-[11px] mt-1">يجب أن يكون بصيغة ‎#RRGGBB — must be #RRGGBB</div>
              )}
            </div>
            <div className="md:col-span-2">
              <L ar="ربط بخيار واحد" en="Linked option (single)" hint="فارغ = متاح لكل الخيارات / empty = all options" />
              <select
                value={col.option_id ?? ''}
                onChange={(e) => upd(idx, { option_id: e.target.value || null })}
                className={inputCls}
              >
                <option value="">كل الخيارات / all options</option>
                {doc.options.map((o) => (
                  <option key={o.id} value={o.id}>{o.name_ar || o.name_en || o.id}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="mb-3">
            <TriText
              labelAr="اسم اللون" labelEn="Color name"
              ar={col.name_ar} en={col.name_en} ckb={col.name_ckb}
              onAr={(v) => upd(idx, { name_ar: v })}
              onEn={(v) => upd(idx, { name_en: v })}
              onCkb={(v) => upd(idx, { name_ckb: v })}
            />
          </div>
          <div className="mb-3">
            <ImagePicker url={col.image} onUrl={(u) => upd(idx, { image: u })} />
          </div>
          <PriceQuad item={col} onField={(k, v) => upd(idx, { [k]: v } as Partial<ColorV2>)} />
        </div>
      ))}
      <AddButton ar="إضافة لون" en="Add color" onClick={() => setDoc((d) => ({
        ...d,
        colors: [...d.colors, {
          id: uid('col'), name_ar: '', name_en: '', name_ckb: '', hex: '', image: '', option_id: null,
          order: d.colors.length, active: true,
          regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        }],
      }))} />
    </Section>
  );
}

// ---------------------------------------------------------------- الصور

export function MediaSection({ doc, setDoc }: { doc: EditorDoc; setDoc: SetDoc }) {
  const [urlDraft, setUrlDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upd = (idx: number, patch: Partial<MediaV2>) =>
    setDoc((d) => ({ ...d, media: d.media.map((m, i) => (i === idx ? { ...m, ...patch } : m)) }));

  const addMedia = (m: Partial<MediaV2>) =>
    setDoc((d) => ({
      ...d,
      media: [...d.media, {
        id: uid('img'), url: '', key: '', role: 'gallery', alt_ar: '', alt_en: '', alt_ckb: '',
        order: d.media.length, primary: d.media.length === 0, width: null, height: null, source_url: '',
        ...m,
      }],
    }));

  return (
    <Section ar="الصور" en="Gallery" badge={<CountBadge n={doc.media.length} />}>
      {doc.media.map((m, idx) => (
        <div key={m.id} className="bg-zinc-900 border border-zinc-700 p-3 rounded-xl mb-3">
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <img referrerPolicy="no-referrer" src={m.url || undefined} className="w-20 h-20 rounded-lg object-cover border border-zinc-700 bg-zinc-800" alt={m.alt_ar || ''} />
              {m.primary && (
                <span className="absolute -top-2 -start-2 bg-[#6B46FF] text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow">
                  رئيسية
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-zinc-500 text-xs truncate mb-2" dir="ltr">{m.url}</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <input value={m.alt_ar} dir="rtl" placeholder="نص بديل (عربي)" onChange={(e) => upd(idx, { alt_ar: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={m.alt_en} dir="ltr" placeholder="Alt (English)" onChange={(e) => upd(idx, { alt_en: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={m.alt_ckb} dir="rtl" placeholder="Alt (کوردی)" onChange={(e) => upd(idx, { alt_ckb: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setDoc((d) => ({ ...d, media: d.media.map((x, i) => ({ ...x, primary: i === idx })) }))}
                className={`p-2.5 rounded-lg transition-colors ${m.primary ? 'text-[#6B46FF]' : 'text-zinc-500 hover:text-[#6B46FF] hover:bg-zinc-800'}`}
                title="الصورة الرئيسية / primary"
              >
                <Star className="w-5 h-5" fill={m.primary ? ACCENT_FILL : 'none'} />
              </button>
              <RowControls
                upDisabled={idx === 0}
                downDisabled={idx === doc.media.length - 1}
                onUp={() => setDoc((d) => ({ ...d, media: ensureOnePrimary(moved(d.media, idx, -1)) }))}
                onDown={() => setDoc((d) => ({ ...d, media: ensureOnePrimary(moved(d.media, idx, +1)) }))}
                onRemove={() => setDoc((d) => ({ ...d, media: ensureOnePrimary(removedAt(d.media, idx)) }))}
              />
            </div>
          </div>
        </div>
      ))}

      <div className="flex flex-col sm:flex-row gap-2 mt-3">
        <label className={btnSecondary + ' cursor-pointer flex-1 border-dashed'}>
          <Plus className="w-4 h-4" /> {busy ? 'جارٍ الرفع…' : 'رفع صورة / upload'}
          <input type="file" className="hidden" accept="image/*" multiple disabled={busy} onChange={async (e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            if (!files.length) return;
            setBusy(true); setErr(null);
            try {
              for (const f of files) {
                const r = await uploadProductImage(f);
                addMedia({ url: r.url, key: r.key });
              }
            } catch (ex) {
              setErr(ex instanceof Error ? ex.message : 'upload failed');
            } finally { setBusy(false); }
          }} />
        </label>
        <div className="flex flex-1 gap-2">
          <input
            value={urlDraft} dir="ltr" placeholder="https://… رابط صورة / image URL"
            onChange={(e) => setUrlDraft(e.target.value)}
            className={inputCls}
          />
          <button
            type="button"
            className={btnSecondary}
            disabled={!/^https?:\/\//.test(urlDraft.trim())}
            onClick={() => {
              const u = urlDraft.trim();
              addMedia({ url: u, source_url: u });
              setUrlDraft('');
            }}
          >
            إضافة / add
          </button>
        </div>
      </div>
      {err && <div className="text-red-400 text-sm mt-2">{err}</div>}
    </Section>
  );
}

const ACCENT_FILL = '#6B46FF';

function ensureOnePrimary(media: MediaV2[]): MediaV2[] {
  if (!media.length) return media;
  if (media.some((m) => m.primary)) {
    let seen = false;
    return media.map((m) => {
      if (m.primary && !seen) { seen = true; return m; }
      return m.primary ? { ...m, primary: false } : m;
    });
  }
  return media.map((m, i) => (i === 0 ? { ...m, primary: true } : m));
}

// ---------------------------------------------------------------- المواصفات

export function SpecsSection({ doc, setDoc }: { doc: EditorDoc; setDoc: SetDoc }) {
  const updGroup = (gi: number, patch: Partial<SpecGroupV2>) =>
    setDoc((d) => ({ ...d, spec_groups: d.spec_groups.map((g, i) => (i === gi ? { ...g, ...patch } : g)) }));

  const updRow = (gi: number, ri: number, patch: Partial<SpecRowV2>) =>
    setDoc((d) => ({
      ...d,
      spec_groups: d.spec_groups.map((g, i) =>
        i === gi ? { ...g, rows: g.rows.map((r, j) => (j === ri ? { ...r, ...patch } : r)) } : g
      ),
    }));

  return (
    <Section ar="المواصفات" en="Specifications" badge={<CountBadge n={doc.spec_groups.reduce((n, g) => n + g.rows.length, 0)} />}>
      {doc.spec_groups.map((g, gi) => (
        <div key={g.id} className="bg-zinc-900 border border-zinc-700 p-4 rounded-xl mb-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <span className="text-xs font-bold text-zinc-500 uppercase">مجموعة / group</span>
            <RowControls
              upDisabled={gi === 0}
              downDisabled={gi === doc.spec_groups.length - 1}
              onUp={() => setDoc((d) => ({ ...d, spec_groups: moved(d.spec_groups, gi, -1) }))}
              onDown={() => setDoc((d) => ({ ...d, spec_groups: moved(d.spec_groups, gi, +1) }))}
              onRemove={() => setDoc((d) => ({ ...d, spec_groups: removedAt(d.spec_groups, gi) }))}
            />
          </div>
          <div className="mb-4">
            <TriText
              labelAr="عنوان المجموعة" labelEn="Group title"
              ar={g.title_ar} en={g.title_en} ckb={g.title_ckb}
              onAr={(v) => updGroup(gi, { title_ar: v })}
              onEn={(v) => updGroup(gi, { title_en: v })}
              onCkb={(v) => updGroup(gi, { title_ckb: v })}
            />
          </div>

          {g.rows.map((r, ri) => (
            <div key={r.id} className="border border-zinc-800 rounded-xl p-3 mb-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] text-zinc-600 font-bold">صف {ri + 1} / row</span>
                <RowControls
                  upDisabled={ri === 0}
                  downDisabled={ri === g.rows.length - 1}
                  onUp={() => updGroup(gi, { rows: moved(g.rows, ri, -1) })}
                  onDown={() => updGroup(gi, { rows: moved(g.rows, ri, +1) })}
                  onRemove={() => updGroup(gi, { rows: removedAt(g.rows, ri) })}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
                <input value={r.label_ar} dir="rtl" placeholder="التسمية عربي" onChange={(e) => updRow(gi, ri, { label_ar: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={r.label_en} dir="ltr" placeholder="Label EN" onChange={(e) => updRow(gi, ri, { label_en: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={r.label_ckb} dir="rtl" placeholder="ناونیشان کوردی" onChange={(e) => updRow(gi, ri, { label_ckb: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={r.value_ar} dir="rtl" placeholder="القيمة عربي" onChange={(e) => updRow(gi, ri, { value_ar: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={r.value_en} dir="ltr" placeholder="Value EN" onChange={(e) => updRow(gi, ri, { value_en: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={r.value_ckb} dir="rtl" placeholder="نرخ کوردی" onChange={(e) => updRow(gi, ri, { value_ckb: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
                <input value={r.unit} dir="ltr" placeholder="الوحدة / unit" onChange={(e) => updRow(gi, ri, { unit: e.target.value })} className={inputCls + ' !p-2 text-sm'} />
              </div>
            </div>
          ))}
          <AddButton small ar="إضافة صف" en="Add row" onClick={() => updGroup(gi, {
            rows: [...g.rows, {
              id: uid('sr'), label_ar: '', label_en: '', label_ckb: '',
              value_ar: '', value_en: '', value_ckb: '', unit: '', order: g.rows.length,
            }],
          })} />
        </div>
      ))}
      <AddButton ar="إضافة مجموعة مواصفات" en="Add spec group" onClick={() => setDoc((d) => ({
        ...d,
        spec_groups: [...d.spec_groups, {
          id: uid('sg'), title_ar: '', title_en: '', title_ckb: '', order: d.spec_groups.length, rows: [],
        }],
      }))} />
    </Section>
  );
}

// ---------------------------------------------------------------- الملصقات

export function LabelsSection({ doc, setDoc }: { doc: EditorDoc; setDoc: SetDoc }) {
  const upd = (idx: number, patch: Partial<LabelV2>) =>
    setDoc((d) => ({ ...d, labels: d.labels.map((l, i) => (i === idx ? { ...l, ...patch } : l)) }));

  return (
    <Section ar="الملصقات" en="Labels" badge={<CountBadge n={doc.labels.length} />}>
      {doc.labels.map((l, idx) => (
        <div key={l.id} className="bg-zinc-900 border border-zinc-700 p-3 rounded-xl mb-3">
          <div className="flex items-center justify-between gap-3 mb-3">
            <ActiveToggle value={l.visible} onChange={(v) => upd(idx, { visible: v })} arOn="ظاهر" arOff="مخفي" />
            <RowControls
              upDisabled={idx === 0}
              downDisabled={idx === doc.labels.length - 1}
              onUp={() => setDoc((d) => ({ ...d, labels: moved(d.labels, idx, -1) }))}
              onDown={() => setDoc((d) => ({ ...d, labels: moved(d.labels, idx, +1) }))}
              onRemove={() => setDoc((d) => ({ ...d, labels: removedAt(d.labels, idx) }))}
            />
          </div>
          <TriText
            labelAr="نص الملصق" labelEn="Label text"
            ar={l.text_ar} en={l.text_en} ckb={l.text_ckb}
            onAr={(v) => upd(idx, { text_ar: v })}
            onEn={(v) => upd(idx, { text_en: v })}
            onCkb={(v) => upd(idx, { text_ckb: v })}
          />
        </div>
      ))}
      <AddButton ar="إضافة ملصق" en="Add label" onClick={() => setDoc((d) => ({
        ...d,
        labels: [...d.labels, {
          id: uid('lbl'), key: '', text_ar: '', text_en: '', text_ckb: '', icon: '',
          order: d.labels.length, visible: true,
        }],
      }))} />
    </Section>
  );
}

// ---------------------------------------------------------------- خطط الضمان

export function WarrantySection({ doc, setDoc }: { doc: EditorDoc; setDoc: SetDoc }) {
  const upd = (idx: number, patch: Partial<WarrantyPlanV2>) =>
    setDoc((d) => ({ ...d, warranty_plans: d.warranty_plans.map((w, i) => (i === idx ? { ...w, ...patch } : w)) }));

  return (
    <Section ar="خطط الضمان" en="Warranty plans" badge={<CountBadge n={doc.warranty_plans.length} />}>
      <p className="text-xs text-zinc-500 mb-4">
        رسم الضمان يُضاف إلى السعر ولا يُعفى أبداً بالعضوية.
        <span className="mx-1">Warranty fee is ADDED and never waived by membership.</span>
      </p>
      {doc.warranty_plans.map((w, idx) => (
        <div key={w.id} className="bg-zinc-900 border border-zinc-700 p-4 rounded-xl mb-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <ActiveToggle value={w.active} onChange={(v) => upd(idx, { active: v })} />
            <RowControls
              upDisabled={idx === 0}
              downDisabled={idx === doc.warranty_plans.length - 1}
              onUp={() => setDoc((d) => ({ ...d, warranty_plans: moved(d.warranty_plans, idx, -1) }))}
              onDown={() => setDoc((d) => ({ ...d, warranty_plans: moved(d.warranty_plans, idx, +1) }))}
              onRemove={() => setDoc((d) => ({ ...d, warranty_plans: removedAt(d.warranty_plans, idx) }))}
            />
          </div>
          <div className="mb-3">
            <TriText
              labelAr="عنوان الخطة" labelEn="Plan title"
              ar={w.title_ar} en={w.title_en} ckb={w.title_ckb}
              onAr={(v) => upd(idx, { title_ar: v })}
              onEn={(v) => upd(idx, { title_en: v })}
              onCkb={(v) => upd(idx, { title_ckb: v })}
            />
          </div>
          <div className="mb-3">
            <TriText
              textarea
              labelAr="الشروط" labelEn="Terms"
              ar={w.terms_ar} en={w.terms_en} ckb={w.terms_ckb}
              onAr={(v) => upd(idx, { terms_ar: v })}
              onEn={(v) => upd(idx, { terms_en: v })}
              onCkb={(v) => upd(idx, { terms_ckb: v })}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <L ar="المدة (أشهر)" en="Duration (months)" />
              <input
                type="number" min={1} max={240} dir="ltr"
                value={w.duration_months}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  upd(idx, { duration_months: Number.isFinite(n) && n >= 1 ? Math.min(n, 240) : 1 });
                }}
                className={inputCls}
              />
            </div>
            <div>
              <L ar="نوع المدة" en="Duration kind" />
              <select
                value={w.duration_kind}
                onChange={(e) => upd(idx, { duration_kind: e.target.value === 'extension' ? 'extension' : 'total' })}
                className={inputCls}
              >
                <option value="total">إجمالية / total</option>
                <option value="extension">تمديد / extension</option>
              </select>
            </div>
            <div>
              <L ar="الرسم (د.ع)" en="Fee (IQD)" hint="يُضاف دائماً — added, never waived" />
              <input
                type="number" min={0} dir="ltr"
                value={w.fee_iqd}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  upd(idx, { fee_iqd: Number.isFinite(n) && n >= 0 ? n : 0 });
                }}
                className={inputCls}
              />
            </div>
          </div>
        </div>
      ))}
      <AddButton ar="إضافة خطة ضمان" en="Add warranty plan" onClick={() => setDoc((d) => ({
        ...d,
        warranty_plans: [...d.warranty_plans, {
          id: uid('wp'), title_ar: '', title_en: '', title_ckb: '',
          terms_ar: '', terms_en: '', terms_ckb: '',
          duration_months: 12, duration_kind: 'total', fee_iqd: 0,
          order: d.warranty_plans.length, active: true,
        }],
      }))} />
    </Section>
  );
}

// ---------------------------------------------------------------- محتوى أسفل الصفحة

export function ContentBlocksSection({ doc, setDoc }: { doc: EditorDoc; setDoc: SetDoc }) {
  const upd = (idx: number, patch: Partial<ContentBlockV2>) =>
    setDoc((d) => ({ ...d, content_blocks: d.content_blocks.map((b, i) => (i === idx ? { ...b, ...patch } : b)) }));

  return (
    <Section ar="محتوى أسفل الصفحة" en="Bottom-page content" badge={<CountBadge n={doc.content_blocks.length} />}>
      {doc.content_blocks.map((b, idx) => (
        <div key={b.id} className="bg-zinc-900 border border-zinc-700 p-4 rounded-xl mb-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <select
              value={b.kind}
              onChange={(e) => upd(idx, { kind: e.target.value as ContentBlockV2['kind'] })}
              className={inputCls + ' !w-auto !p-2 text-sm'}
            >
              <option value="text">نص / text</option>
              <option value="image">صورة / image</option>
              <option value="video_embed">فيديو مضمّن / video embed</option>
            </select>
            <RowControls
              upDisabled={idx === 0}
              downDisabled={idx === doc.content_blocks.length - 1}
              onUp={() => setDoc((d) => ({ ...d, content_blocks: moved(d.content_blocks, idx, -1) }))}
              onDown={() => setDoc((d) => ({ ...d, content_blocks: moved(d.content_blocks, idx, +1) }))}
              onRemove={() => setDoc((d) => ({ ...d, content_blocks: removedAt(d.content_blocks, idx) }))}
            />
          </div>

          {b.kind === 'text' && (
            <TriText
              textarea
              labelAr="النص" labelEn="Body"
              ar={b.body_ar} en={b.body_en} ckb={b.body_ckb}
              onAr={(v) => upd(idx, { body_ar: v })}
              onEn={(v) => upd(idx, { body_en: v })}
              onCkb={(v) => upd(idx, { body_ckb: v })}
            />
          )}

          {b.kind === 'image' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row gap-2 items-start">
                <ImagePicker url={b.url} onUrl={(u) => upd(idx, { url: u, media_key: '' })} />
                <input
                  value={b.url} dir="ltr" placeholder="أو رابط صورة / or image URL"
                  onChange={(e) => upd(idx, { url: e.target.value })}
                  className={inputCls + ' flex-1'}
                />
              </div>
              <TriText
                labelAr="النص البديل" labelEn="Alt text"
                ar={b.alt_ar} en={b.alt_en} ckb={b.alt_ckb}
                onAr={(v) => upd(idx, { alt_ar: v })}
                onEn={(v) => upd(idx, { alt_en: v })}
                onCkb={(v) => upd(idx, { alt_ckb: v })}
              />
              <TriText
                labelAr="التسمية التوضيحية" labelEn="Caption"
                ar={b.caption_ar} en={b.caption_en} ckb={b.caption_ckb}
                onAr={(v) => upd(idx, { caption_ar: v })}
                onEn={(v) => upd(idx, { caption_en: v })}
                onCkb={(v) => upd(idx, { caption_ckb: v })}
              />
            </div>
          )}

          {b.kind === 'video_embed' && (
            <div className="flex flex-col gap-3">
              <div>
                <L ar="رابط التضمين" en="Embed URL" hint="يُحمَّل عند الطلب فقط — لا تشغيل تلقائي أبداً / loads on demand, never autoplays" />
                <input
                  value={b.url} dir="ltr" placeholder="https://www.youtube.com/embed/…"
                  onChange={(e) => upd(idx, { url: e.target.value })}
                  className={inputCls}
                />
              </div>
              <LazyVideoPreview url={b.url} />
              <TriText
                labelAr="التسمية التوضيحية" labelEn="Caption"
                ar={b.caption_ar} en={b.caption_en} ckb={b.caption_ckb}
                onAr={(v) => upd(idx, { caption_ar: v })}
                onEn={(v) => upd(idx, { caption_en: v })}
                onCkb={(v) => upd(idx, { caption_ckb: v })}
              />
            </div>
          )}
        </div>
      ))}
      <AddButton ar="إضافة كتلة محتوى" en="Add content block" onClick={() => setDoc((d) => ({
        ...d,
        content_blocks: [...d.content_blocks, {
          id: uid('cb'), kind: 'text', order: d.content_blocks.length,
          body_ar: '', body_en: '', body_ckb: '',
          caption_ar: '', caption_en: '', caption_ckb: '',
          alt_ar: '', alt_en: '', alt_ckb: '',
          url: '', media_key: '',
        }],
      }))} />
    </Section>
  );
}

/** Video preview loads its iframe ONLY after an explicit click — never autoplay. */
function LazyVideoPreview({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);
  if (!url) return null;
  if (!loaded) {
    return (
      <button
        type="button"
        onClick={() => setLoaded(true)}
        className="w-full max-w-md aspect-video bg-zinc-800 border border-zinc-700 rounded-xl flex flex-col items-center justify-center gap-2 text-zinc-400 hover:text-white transition-colors"
      >
        <Play className="w-8 h-8" />
        <span className="text-xs font-bold">معاينة الفيديو (بنقرة) / click to preview — no autoplay</span>
      </button>
    );
  }
  return (
    <div className="w-full max-w-md aspect-video rounded-xl overflow-hidden border border-zinc-700 bg-black">
      <iframe src={url} className="w-full h-full" allowFullScreen title="video preview" />
    </div>
  );
}

// ---------------------------------------------------------------- small bits

function CountBadge({ n }: { n: number }) {
  return (
    <span className="text-[10px] font-bold bg-zinc-800 text-zinc-400 border border-zinc-700 rounded-full px-2 py-0.5">
      {n}
    </span>
  );
}

function AddButton({ ar, en, onClick, small }: { ar: string; en: string; onClick: () => void; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        small
          ? 'text-[#6B46FF] text-sm font-bold flex items-center gap-1 mt-1'
          : 'flex items-center justify-center gap-2 p-3 w-full bg-zinc-800/60 hover:bg-zinc-800 text-zinc-200 rounded-xl border border-dashed border-zinc-600 transition-colors font-bold'
      }
    >
      <Plus className="w-4 h-4" /> {ar} <span className="text-xs text-zinc-500 font-medium">{en}</span>
    </button>
  );
}
