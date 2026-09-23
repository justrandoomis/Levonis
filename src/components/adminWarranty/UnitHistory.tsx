/**
 * «سجل التعديلات» — WHO CHANGED THIS DEVICE, WHEN, AND WHY.
 *
 * The owner asked for the warranty duration to be changeable «مع تسجيل مَن
 * غيّر ومتى». The recording half existed from the start: every unit route in
 * worker/routes/devices.ts writes an `audit_log` row with the admin's id, the
 * old and new months, the old and new end date and the reason. The reading
 * half did not — no route ever returned one, so the admin who shortened a
 * warranty could not show it and the next admin could not see it had happened.
 * GET /api/devices/admin/units/:unitId/history is that half, and this is the
 * one place it is drawn, shared by the order screen's warranty section and the
 * serials screen so the two cannot tell the story differently.
 *
 * It reads the server's rows and formats them; nothing here decides what
 * happened.
 */
import React, { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { dateLocale } from '../orders/format';

export interface UnitHistoryEntry {
  id: number | string;
  action: string;
  created_at: string;
  actor: { id: string; email: string | null; username: string | null; name: string | null } | null;
  detail: Record<string, unknown>;
}

const T = {
  ar: {
    title: 'سجل التعديلات',
    empty: 'لا توجد تعديلات مسجّلة على هذا الجهاز.',
    loading: 'جارٍ التحميل…',
    by: 'بواسطة',
    system: 'النظام',
    reason: 'السبب',
    months: 'المدة',
    monthsUnit: 'شهر',
    end: 'النهاية',
    delivered: 'التسليم',
    serial: 'الرقم التسلسلي',
    shortened: 'تقصير مؤكَّد',
    actions: {
      'device.unit_warranty_months': 'تعديل مدة الضمان',
      'device.unit_delivery_correct': 'تصحيح تاريخ التسليم',
      'device.serial_assign': 'تعيين الرقم التسلسلي',
      'device.serial_reassign': 'إعادة تعيين الرقم التسلسلي',
      'device.register': 'رُبط بحساب',
      'device.unregister': 'فُكّ الربط من الحساب',
      'device.unit_replace': 'استبدال الجهاز',
    } as Record<string, string>,
  },
  en: {
    title: 'Change history',
    empty: 'No recorded changes on this device.',
    loading: 'Loading…',
    by: 'by',
    system: 'system',
    reason: 'Reason',
    months: 'Duration',
    monthsUnit: 'mo',
    end: 'End',
    delivered: 'Delivered',
    serial: 'Serial',
    shortened: 'confirmed shortening',
    actions: {
      'device.unit_warranty_months': 'Warranty duration changed',
      'device.unit_delivery_correct': 'Delivery date corrected',
      'device.serial_assign': 'Serial assigned',
      'device.serial_reassign': 'Serial reassigned',
      'device.register': 'Linked to an account',
      'device.unregister': 'Unlinked from its account',
      'device.unit_replace': 'Device replaced',
    } as Record<string, string>,
  },
};

type Strings = (typeof T)['ar'];

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const day = (v: unknown): string => (typeof v === 'string' && v ? v.slice(0, 10) : '—');

function when(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(dateLocale(lang), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function who(entry: UnitHistoryEntry, t: Strings): string {
  const a = entry.actor;
  if (!a) return t.system;
  return a.email || (a.username ? `@${a.username}` : '') || a.name || a.id;
}

/** The old → new facts one row carries, as short «label: old → new» pieces. */
export function historyFacts(entry: UnitHistoryEntry, t: Strings): string[] {
  const d = entry.detail ?? {};
  const out: string[] = [];
  if (d.old_total_months !== undefined || d.new_total_months !== undefined) {
    out.push(`${t.months}: ${str(d.old_total_months) || '—'} → ${str(d.new_total_months) || '—'} ${t.monthsUnit}`);
  }
  if (d.old_delivered_at !== undefined || d.new_delivered_at !== undefined) {
    out.push(`${t.delivered}: ${day(d.old_delivered_at)} → ${day(d.new_delivered_at)}`);
  }
  if (d.old_end_at !== undefined || d.new_end_at !== undefined) {
    out.push(`${t.end}: ${day(d.old_end_at)} → ${day(d.new_end_at)}`);
  }
  if (str(d.serial_norm)) {
    const before = str(d.detached_serial_raw) || str(d.detached_serial);
    out.push(`${t.serial}: ${before ? `${before} → ` : ''}${str(d.serial_norm)}`);
  }
  if (str(d.new_serial)) out.push(`${t.serial}: ${str(d.new_serial)}`);
  if (d.shortened === true) out.push(t.shortened);
  return out;
}

export default function UnitHistory({
  unitId,
  lang,
  refreshKey = 0,
}: {
  unitId: string;
  lang: string;
  /** Bumped by the parent after a change it made, so the new row appears. */
  refreshKey?: number;
}) {
  const t = lang === 'en' ? T.en : T.ar;
  const [rows, setRows] = useState<UnitHistoryEntry[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setErr('');
    api
      .get<{ history: UnitHistoryEntry[] }>(`/api/devices/admin/units/${encodeURIComponent(unitId)}/history`)
      .then((r) => {
        if (alive) setRows(r.history ?? []);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof ApiError ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [unitId, refreshKey]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-2.5" data-unit-history={unitId}>
      <p className="text-[11px] font-bold text-zinc-400 mb-1.5 flex items-center gap-1.5">
        <History className="w-3.5 h-3.5" aria-hidden />
        {t.title}
      </p>
      {err ? (
        <p className="text-[11px] text-red-300" role="alert">
          {err}
        </p>
      ) : rows === null ? (
        <p className="text-[11px] text-zinc-500">{t.loading}</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-zinc-500">{t.empty}</p>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((h) => {
            const facts = historyFacts(h, t);
            const reason = str(h.detail?.reason);
            return (
              <li key={String(h.id)} className="text-[11px] leading-relaxed" data-unit-history-row={h.action}>
                <span className="text-zinc-200 font-bold">{t.actions[h.action] ?? h.action}</span>{' '}
                <span className="text-zinc-500">
                  · <time dateTime={h.created_at}>{when(h.created_at, lang)}</time> · {t.by}{' '}
                  <span className="text-zinc-300 break-all" dir="ltr">
                    {who(h, t)}
                  </span>
                </span>
                {facts.length > 0 && (
                  <span className="block text-zinc-400" dir="auto">
                    {facts.join(' · ')}
                  </span>
                )}
                {reason && (
                  <span className="block text-zinc-500">
                    {t.reason}: <span className="text-zinc-300">{reason}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
