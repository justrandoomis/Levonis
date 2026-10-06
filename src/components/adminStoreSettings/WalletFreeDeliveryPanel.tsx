import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Check, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';

/**
 * «توصيل عادي مجاني — للدفع الكامل من محفظة Levo» (owner brief 2026-10-06 §2).
 *
 * The editor for the stored `walletFreeDelivery` setting. The rule itself runs
 * on the server only (worker/lib/walletFreeDelivery.ts); this screen never
 * decides who qualifies, it only writes the switches and the minimums, and the
 * server refuses anything malformed — a section that does not exist, a
 * section listed twice, a minimum that is not a whole number of dinars.
 *
 * A WAIVER, NOT A DISCOUNT. The checkout still prices the delivery, records
 * the original fee and the rule that waived it, and charges 0 — so the books
 * never see a fee computed and then subtracted.
 */
export interface WalletFreeDeliveryRule {
  catalog_id: string;
  min_products_iqd: number;
  enabled: boolean;
}
export interface WalletFreeDeliveryConfig {
  enabled: boolean;
  require_full_wallet: boolean;
  methods: string[];
  rules: WalletFreeDeliveryRule[];
}

/** The server's shipped defaults, restated because an admin bundle must not
 *  import the Worker: printers from 500,000 IQD, FDM filament from 0. */
export const WALLET_FREE_DEFAULTS: WalletFreeDeliveryConfig = {
  enabled: true,
  require_full_wallet: true,
  methods: ['standard'],
  rules: [
    { catalog_id: 'cat_printers', min_products_iqd: 500_000, enabled: true },
    { catalog_id: 'cat_materials_fdm', min_products_iqd: 0, enabled: true },
  ],
};

/** The GET already returns the server-normalised value; this only guards the
 *  shape so a missing row renders the defaults instead of nothing. */
export function walletFreeFrom(raw: unknown): WalletFreeDeliveryConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WalletFreeDeliveryConfig>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : WALLET_FREE_DEFAULTS.enabled,
    require_full_wallet:
      typeof r.require_full_wallet === 'boolean' ? r.require_full_wallet : WALLET_FREE_DEFAULTS.require_full_wallet,
    methods: Array.isArray(r.methods) ? r.methods.filter((m) => m === 'standard' || m === 'personal') : [...WALLET_FREE_DEFAULTS.methods],
    rules: Array.isArray(r.rules)
      ? r.rules.map((x) => ({
          catalog_id: String(x?.catalog_id ?? ''),
          min_products_iqd: Math.max(0, Math.round(Number(x?.min_products_iqd) || 0)),
          enabled: x?.enabled !== false,
        }))
      : WALLET_FREE_DEFAULTS.rules.map((x) => ({ ...x })),
  };
}

/** What the server would refuse, said before the request. */
export function walletFreeProblems(v: WalletFreeDeliveryConfig): string[] {
  const out: string[] = [];
  if (v.methods.length === 0) out.push('اختر طريقة توصيل واحدة على الأقل');
  const seen = new Set<string>();
  v.rules.forEach((r, i) => {
    if (!r.catalog_id) out.push(`القاعدة ${i + 1}: اختر القسم`);
    else if (seen.has(r.catalog_id)) out.push(`القسم مكرر في القاعدة ${i + 1}`);
    seen.add(r.catalog_id);
    if (!Number.isSafeInteger(r.min_products_iqd) || r.min_products_iqd < 0) out.push(`القاعدة ${i + 1}: الحد الأدنى غير صالح`);
  });
  return out;
}

interface CatalogOption {
  id: string;
  parent_id: string | null;
  name_ar: string;
  name_en: string;
  active: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const FIELD = 'w-full bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2';

export default function WalletFreeDeliveryPanel({ initial }: { initial: unknown }) {
  const [value, setValue] = useState<WalletFreeDeliveryConfig>(() => walletFreeFrom(initial));
  const [catalogs, setCatalogs] = useState<CatalogOption[]>([]);
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ catalogs: CatalogOption[] }>('/api/admin/taxonomy/catalogs')
      .then((res) => {
        if (alive) setCatalogs(res.catalogs ?? []);
      })
      .catch(() => {
        /* The select still shows the saved ids; the server checks them. */
      });
    return () => {
      alive = false;
    };
  }, []);

  const edit = (next: (v: WalletFreeDeliveryConfig) => WalletFreeDeliveryConfig) => {
    setValue(next);
    setState('idle');
    setError(null);
  };
  const editRule = (i: number, patch: Partial<WalletFreeDeliveryRule>) =>
    edit((v) => ({ ...v, rules: v.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const save = async () => {
    const problems = walletFreeProblems(value);
    if (problems.length) {
      setState('error');
      setError(problems.join(' — '));
      return;
    }
    setState('saving');
    try {
      await api.put('/api/admin/settings/walletFreeDelivery', { value });
      setState('saved');
    } catch (e) {
      setState('error');
      setError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const nameOf = (id: string) => {
    const c = catalogs.find((x) => x.id === id);
    return c ? `${c.name_ar || c.name_en}${c.active ? '' : ' (غير مفعّل)'}` : id;
  };
  const toggleMethod = (m: 'standard' | 'personal', on: boolean) =>
    edit((v) => ({ ...v, methods: on ? [...new Set([...v.methods, m])] : v.methods.filter((x) => x !== m) }));

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-700 p-6" data-admin="wallet-free-delivery">
      <h2 className="text-xl font-bold mb-1">توصيل عادي مجاني — للدفع الكامل من محفظة Levo</h2>
      <p className="text-sm text-zinc-400 mb-4">
        يُعفى الزبون من رسم التوصيل عندما يدفع الطلب كاملاً من محفظة Levo وتنطبق إحدى القواعد أدناه. يُسجَّل الرسم
        الأصلي على الطلب مع القاعدة التي أعفته ويُحاسَب الزبون بصفر — لا يُحسب الرسم ثم يُخصم. لا يشمل الاستلام من
        المخزن ولا رسوم الحماية الإضافية، وعضوية PRO/PREMIUM تبقى لها الأسبقية.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={value.enabled} onChange={(e) => edit((v) => ({ ...v, enabled: e.target.checked }))} />
          <span className="text-sm">مُفعَّل</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.require_full_wallet}
            onChange={(e) => edit((v) => ({ ...v, require_full_wallet: e.target.checked }))}
          />
          <span className="text-sm">يشترط الدفع الكامل من المحفظة (بدون نقاط ولا دفع مختلط)</span>
        </label>
        <div>
          <span className="block text-sm text-zinc-400 mb-1">طرق التوصيل المشمولة</span>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={value.methods.includes('standard')} onChange={(e) => toggleMethod('standard', e.target.checked)} />
            <span className="text-sm">التوصيل العادي (standard)</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={value.methods.includes('personal')} onChange={(e) => toggleMethod('personal', e.target.checked)} />
            <span className="text-sm">التوصيل الشخصي (personal)</span>
          </label>
        </div>
      </div>

      <div className="flex justify-between items-center mt-5 mb-1">
        <span className="text-sm text-zinc-400">القواعد حسب القسم</span>
        <button
          type="button"
          onClick={() => edit((v) => ({ ...v, rules: [...v.rules, { catalog_id: '', min_products_iqd: 0, enabled: true }] }))}
          className="flex items-center gap-2 bg-[#ef233c] hover:bg-[#d90429] px-4 py-2 rounded-lg font-bold"
        >
          <Plus className="w-4 h-4" /> إضافة قاعدة
        </button>
      </div>
      <p className="text-xs text-zinc-500 mb-4">
        تنطبق القاعدة إذا احتوى الطلب على منتج مدفوع من هذا القسم (أو من أقسامه الفرعية) وكان مجموع المنتجات — بعد
        الخصومات وقبل الكوبون والتوصيل — لا يقل عن الحد الأدنى. الهدايا لا تُحتسب.
      </p>
      <div className="space-y-4">
        {value.rules.map((rule, i) => (
          <div key={i} className="grid grid-cols-1 md:grid-cols-3 gap-4 border border-zinc-700 p-4 rounded-xl" data-wallet-rule={rule.catalog_id}>
            <label className="block">
              <span className="block text-sm text-zinc-400 mb-1">القسم</span>
              <select value={rule.catalog_id} onChange={(e) => editRule(i, { catalog_id: e.target.value })} className={FIELD}>
                <option value="">— اختر القسم —</option>
                {rule.catalog_id && !catalogs.some((c) => c.id === rule.catalog_id) && (
                  <option value={rule.catalog_id}>{rule.catalog_id}</option>
                )}
                {catalogs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {nameOf(c.id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-sm text-zinc-400 mb-1">الحد الأدنى لمجموع المنتجات (د.ع)</span>
              <input
                type="number"
                min={0}
                step={1}
                value={rule.min_products_iqd}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  editRule(i, { min_products_iqd: Number.isFinite(n) && n >= 0 ? n : 0 });
                }}
                className={FIELD}
              />
            </label>
            <div className="flex items-center gap-2 self-end py-2">
              <label className="flex items-center gap-2 flex-1">
                <input type="checkbox" checked={rule.enabled} onChange={(e) => editRule(i, { enabled: e.target.checked })} />
                <span className="text-sm">مُفعَّلة</span>
              </label>
              <button
                type="button"
                aria-label="حذف القاعدة"
                onClick={() => edit((v) => ({ ...v, rules: v.rules.filter((_, j) => j !== i) }))}
                className="bg-red-500/20 text-red-500 p-2 rounded-lg"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5">
        <button
          onClick={() => void save()}
          disabled={state === 'saving'}
          className="w-full bg-green-600 hover:bg-green-700 font-bold py-3 rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {state === 'saving' ? 'جارٍ الحفظ...' : state === 'saved' ? (<><Check className="w-4 h-4" /> تم الحفظ</>) : 'حفظ التغييرات'}
        </button>
        {state === 'error' && (
          <div className="mt-2 text-sm text-red-400 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error || 'Save failed'}
          </div>
        )}
      </div>
    </div>
  );
}
