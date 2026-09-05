/**
 * The serialized devices inside an order line: masked serial, coverage, and
 * whether the device is linked to the customer's account.
 *
 * "Register warranty" links the unit to the account without a serial being
 * typed (POST /api/devices/units/:unitId/register). It never touches the
 * coverage dates — the clock started at delivery — so the button promises
 * only the link, and the row shows the link only after the server confirms.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, ShieldOff, Clock, Link2, FileText, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import type { OrderUnitPublic } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import Spinner from '../ui/Spinner';
import { asLang, daysLeftLabel, formatDate } from './format';

const STRINGS = {
  ar: {
    unit: (i: number, n: number) => (n > 1 ? `الجهاز ${i} من ${n}` : 'الجهاز'),
    serial: 'الرقم التسلسلي',
    noSerial: 'لم يُسجَّل رقم تسلسلي بعد',
    coveredUntil: (d: string) => `مشمول بالضمان حتى ${d}`,
    expired: (d: string) => `انتهى الضمان في ${d}`,
    needsConfig: 'مدة الضمان غير مُعدّة — تواصل مع الدعم',
    notDelivered: 'يبدأ الضمان عند التسليم',
    register: 'تسجيل الضمان',
    registering: 'جارٍ التسجيل…',
    linkedMine: 'مرتبط بحسابك',
    linkedOther: 'مرتبط بحساب آخر',
    replaced: 'استُبدل هذا الجهاز',
    receipt: 'شهادة الضمان',
    failed: 'تعذر تسجيل الجهاز.',
  },
  en: {
    unit: (i: number, n: number) => (n > 1 ? `Device ${i} of ${n}` : 'Device'),
    serial: 'Serial number',
    noSerial: 'No serial assigned yet',
    coveredUntil: (d: string) => `Covered until ${d}`,
    expired: (d: string) => `Warranty expired ${d}`,
    needsConfig: 'Coverage duration not configured — contact support',
    notDelivered: 'Coverage starts at delivery',
    register: 'Register warranty',
    registering: 'Registering…',
    linkedMine: 'Linked to your account',
    linkedOther: 'Linked to another account',
    replaced: 'This device was replaced',
    receipt: 'Warranty receipt',
    failed: 'The device could not be registered.',
  },
  ckb: {
    unit: (i: number, n: number) => (n > 1 ? `ئامێر ${i} لە ${n}` : 'ئامێر'),
    serial: 'ژمارەی زنجیرەیی',
    noSerial: 'هێشتا ژمارەی زنجیرەیی دیاری نەکراوە',
    coveredUntil: (d: string) => `گەرەنتی هەتا ${d}`,
    expired: (d: string) => `گەرەنتی لە ${d} تەواو بووە`,
    needsConfig: 'ماوەی گەرەنتی ڕێکنەخراوە — پەیوەندی بە پشتگیری بکە',
    notDelivered: 'گەرەنتی لە کاتی گەیاندن دەست پێدەکات',
    register: 'تۆمارکردنی گەرەنتی',
    registering: 'تۆمارکردن…',
    linkedMine: 'بەستراوە بە هەژمارەکەت',
    linkedOther: 'بەستراوە بە هەژمارێکی دیکە',
    replaced: 'ئەم ئامێرە گۆڕدراوە',
    receipt: 'وەسڵی گەرەنتی',
    failed: 'ئامێرەکە تۆمار نەکرا.',
  },
} as const;

export default function OrderUnits({ units, onLinked }: { units: OrderUnitPublic[]; onLinked: (unitId: string) => void }) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const register = async (u: OrderUnitPublic) => {
    if (busyId) return;
    setBusyId(u.unit_id);
    setErrors((e) => ({ ...e, [u.unit_id]: '' }));
    try {
      await api.post(`/api/devices/units/${encodeURIComponent(u.unit_id)}/register`, {});
      onLinked(u.unit_id);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [u.unit_id]: e instanceof Error && e.message ? e.message : s.failed }));
    } finally {
      setBusyId(null);
    }
  };

  if (units.length === 0) return null;
  const total = units.length;

  return (
    <ul className="mt-3 flex flex-col gap-2" data-order-units>
      {units.map((u) => {
        const w = u.warranty;
        const coverage =
          w.state === 'active'
            ? { icon: <ShieldCheck className="w-3.5 h-3.5" aria-hidden />, cls: 'text-emerald-300', text: `${s.coveredUntil(formatDate(w.end_at, lang))}${w.remaining_days !== null ? ` · ${daysLeftLabel(w.remaining_days, lang)}` : ''}` }
            : w.state === 'expired'
              ? { icon: <ShieldOff className="w-3.5 h-3.5" aria-hidden />, cls: 'text-red-300', text: s.expired(formatDate(w.end_at, lang)) }
              : w.state === 'needs_config'
                ? { icon: <ShieldAlert className="w-3.5 h-3.5" aria-hidden />, cls: 'text-amber-300', text: s.needsConfig }
                : { icon: <Clock className="w-3.5 h-3.5" aria-hidden />, cls: 'text-zinc-400', text: s.notDelivered };
        const canRegister = u.linked === 'none' && !u.replaced && !!u.delivered_at;
        const err = errors[u.unit_id];
        return (
          <li key={u.unit_id} data-unit-id={u.unit_id} data-unit-linked={u.linked} className="rounded-xl border border-zinc-800 bg-black/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12.5px] text-zinc-200 font-bold">
                  {s.unit(u.unit_index, total)}
                  {u.serial ? (
                    <>
                      {' · '}
                      <span className="sr-only">{s.serial}: </span>
                      <span dir="ltr" className="font-mono font-normal text-zinc-400">{u.serial}</span>
                    </>
                  ) : (
                    <span className="font-normal text-zinc-500"> · {s.noSerial}</span>
                  )}
                </p>
                <p className={`mt-0.5 text-[11.5px] inline-flex items-center gap-1.5 ${coverage.cls}`} data-warranty-state={w.state}>
                  {coverage.icon}
                  {coverage.text}
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {canRegister && (
                <button
                  type="button"
                  onClick={() => register(u)}
                  disabled={busyId !== null}
                  data-register-unit={u.unit_id}
                  className="inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-[#BAA369]/40 text-[#BAA369] text-[12px] font-bold hover:bg-[#BAA369]/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50"
                >
                  {busyId === u.unit_id ? <Spinner size="xs" delayMs={0} decorative /> : <Link2 className="w-3.5 h-3.5" aria-hidden />}
                  {busyId === u.unit_id ? s.registering : s.register}
                </button>
              )}
              {u.linked === 'mine' && (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-300">
                  <ShieldCheck className="w-3.5 h-3.5" aria-hidden />
                  {s.linkedMine}
                </span>
              )}
              {u.linked === 'other' && (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-zinc-400">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                  {s.linkedOther}
                </span>
              )}
              {u.replaced && <span className="text-[12px] text-zinc-500">{s.replaced}</span>}
              {u.receipt_no && (
                <Link
                  to={`/warranty/${encodeURIComponent(u.receipt_no)}`}
                  className="inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-zinc-800 text-zinc-300 text-[12px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                >
                  <FileText className="w-3.5 h-3.5" aria-hidden />
                  {s.receipt} <span dir="ltr" className="font-mono font-normal text-zinc-500">{u.receipt_no}</span>
                </Link>
              )}
            </div>
            <p role="alert" aria-live="assertive" className={`text-red-400 text-[12px] ${err ? 'mt-2' : 'sr-only'}`}>
              {err}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
