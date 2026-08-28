/**
 * Shared UI primitives for the v2 admin product editor.
 * Arabic-first labels with a small English secondary line, dark admin theme,
 * iPad-friendly touch targets. Money inputs keep the null-vs-zero contract:
 * an EMPTY input is null (inherit), an explicit 0 stays 0.
 */

import React, { useState, ReactNode } from 'react';
import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { ApiError, uploadFile } from '../../lib/api';
import type { TransStatus } from './types';

export const ACCENT = '#6B46FF';

export const inputCls =
  'w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all';

export const btnPrimary =
  'inline-flex items-center justify-center gap-2 bg-[#6B46FF] hover:bg-[#5a3ae0] text-white px-5 py-2.5 rounded-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const btnSecondary =
  'inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-4 py-2.5 rounded-xl font-bold transition-colors border border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed';
export const btnGhostDanger =
  'p-2 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors';

/** Arabic-first field label with a small English secondary. */
export function L({ ar, en, hint }: { ar: string; en: string; hint?: string }) {
  return (
    <div className="mb-2">
      <span className="block text-sm font-bold text-zinc-300">
        {ar} <span className="text-[11px] font-medium text-zinc-500 mx-1">{en}</span>
      </span>
      {hint && <span className="block text-[11px] text-zinc-500 mt-0.5">{hint}</span>}
    </div>
  );
}

/** Collapsible editor section card (grouped sections, mobile-friendly). */
export function Section({
  ar,
  en,
  badge,
  defaultOpen = false,
  children,
}: {
  ar: string;
  en: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl overflow-hidden mb-4 shadow-lg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full p-4 bg-zinc-800/20 border-b border-zinc-800/50 flex items-center justify-between gap-3 text-start min-h-[56px]"
      >
        <span className="font-bold text-white">
          {ar} <span className="text-xs font-medium text-zinc-500 mx-1">{en}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {badge}
          {open ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
        </span>
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

/**
 * Nullable IQD integer input. EMPTY = null (placeholder shows the inherit
 * hint), explicit 0 allowed and preserved. Never uses truthiness on value.
 */
export function NullableIqd({
  value,
  onChange,
  placeholder = 'موروث / inherit',
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      disabled={disabled}
      value={value === null || value === undefined ? '' : value}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') { onChange(null); return; }
        const n = Math.floor(Number(raw));
        if (Number.isFinite(n) && n >= 0) onChange(n);
      }}
      className={inputCls + ' disabled:opacity-50'}
      dir="ltr"
    />
  );
}

/** Required IQD integer input (base price): empty is treated as 0 explicitly shown. */
export function RequiredIqd({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const n = Math.floor(Number(e.target.value));
        onChange(Number.isFinite(n) && n >= 0 ? n : 0);
      }}
      className={inputCls}
      dir="ltr"
    />
  );
}

/** ar / en / ckb text inputs for one logical field. */
export function TriText({
  ar, en, ckb,
  onAr, onEn, onCkb,
  textarea = false,
  labelAr, labelEn,
  chips,
}: {
  ar: string; en: string; ckb: string;
  onAr: (v: string) => void; onEn: (v: string) => void; onCkb: (v: string) => void;
  textarea?: boolean;
  labelAr: string; labelEn: string;
  chips?: { en?: ReactNode; ckb?: ReactNode };
}) {
  const C = textarea ? 'textarea' : 'input';
  const cls = inputCls + (textarea ? ' h-28' : '');
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div>
        <L ar={`${labelAr} (عربي — المصدر)`} en={`${labelEn} (Arabic source)`} />
        <C value={ar} dir="rtl" onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onAr(e.target.value)} className={cls} />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <L ar={`${labelAr} (إنجليزي)`} en={`${labelEn} (English)`} />
          {chips?.en}
        </div>
        <C value={en} dir="ltr" onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onEn(e.target.value)} className={cls} />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <L ar={`${labelAr} (کوردی سۆرانی)`} en={`${labelEn} (Kurdish ckb)`} />
          {chips?.ckb}
        </div>
        <C value={ckb} dir="rtl" onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onCkb(e.target.value)} className={cls} />
      </div>
    </div>
  );
}

const TRANS_STATUS_STYLE: Record<TransStatus, string> = {
  approved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  imported: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  stale: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  missing: 'bg-zinc-700/30 text-zinc-500 border-zinc-600/40',
};
const TRANS_STATUS_AR: Record<TransStatus, string> = {
  approved: 'معتمدة',
  imported: 'مستوردة',
  stale: 'قديمة',
  missing: 'مفقودة',
};

/** Translation status chip (from translation_meta). */
export function TransChip({ status }: { status: TransStatus }) {
  return (
    <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded border ${TRANS_STATUS_STYLE[status]}`}>
      {TRANS_STATUS_AR[status]} · {status}
    </span>
  );
}

/** Product status chip (list + editor). */
export function StatusChip({ status }: { status: string }) {
  const map: Record<string, { ar: string; cls: string }> = {
    active: { ar: 'نشط', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    hidden: { ar: 'مخفي', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    draft: { ar: 'مسودة', cls: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40' },
  };
  const m = map[status] ?? map.draft;
  return (
    <span className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${m.cls}`}>
      {m.ar} · {status}
    </span>
  );
}

/** Up / down / delete controls for repeatable rows (44px touch targets). */
export function RowControls({
  onUp, onDown, onRemove, upDisabled, downDisabled,
}: {
  onUp: () => void; onDown: () => void; onRemove: () => void;
  upDisabled: boolean; downDisabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button type="button" disabled={upDisabled} onClick={onUp}
        className="p-2.5 text-zinc-400 hover:text-white disabled:opacity-30 hover:bg-zinc-800 rounded-lg transition-colors" title="Move up / تحريك لأعلى">
        <ChevronUp className="w-5 h-5" />
      </button>
      <button type="button" disabled={downDisabled} onClick={onDown}
        className="p-2.5 text-zinc-400 hover:text-white disabled:opacity-30 hover:bg-zinc-800 rounded-lg transition-colors" title="Move down / تحريك لأسفل">
        <ChevronDown className="w-5 h-5" />
      </button>
      <button type="button" onClick={onRemove} className={btnGhostDanger} title="Remove / حذف">
        <Trash2 className="w-5 h-5" />
      </button>
    </div>
  );
}

/** Active/inactive toggle pill. */
export function ActiveToggle({ value, onChange, arOn = 'مفعّل', arOff = 'معطّل' }: {
  value: boolean; onChange: (v: boolean) => void; arOn?: string; arOff?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
        value
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
          : 'bg-zinc-800 text-zinc-500 border-zinc-700'
      }`}
    >
      {value ? `${arOn} · on` : `${arOff} · off`}
    </button>
  );
}

/** Simple modal shell. */
export function Modal({
  titleAr, titleEn, onClose, children, wide,
}: {
  titleAr: string; titleEn: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className={`bg-zinc-900 border border-zinc-800 rounded-2xl w-full ${wide ? 'max-w-5xl' : 'max-w-2xl'} max-h-[90vh] overflow-hidden flex flex-col shadow-2xl`}>
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <h3 className="text-white font-bold">
            {titleAr} <span className="text-xs font-medium text-zinc-500 mx-1">{titleEn}</span>
          </h3>
          <button onClick={onClose} className="p-2 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/** Inline error banner. */
export function ErrorBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 mb-4 text-sm font-medium">
      {text}
    </div>
  );
}

/** Upload one product image; resolves to its delivery URL + key. */
export async function uploadProductImage(file: File): Promise<{ key: string; url: string }> {
  try {
    return await uploadFile(file, 'product');
  } catch (err) {
    throw new Error(err instanceof ApiError ? err.message : 'فشل الرفع / upload failed');
  }
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}
