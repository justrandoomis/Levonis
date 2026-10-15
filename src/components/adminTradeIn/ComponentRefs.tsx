/**
 * «أسعار مرجعية للأجزاء» — THE OWNER'S COMPONENT REFERENCES (spec §4.3 rules 2–4, §6.13): for a
 * model whose printer-only or AMS-only part has no price of its own today, a LISTED product that
 * stands for it (its V2 price is read) or a dollar figure (converted at the approved rate). Private:
 * read with the costs (GET /component-refs, cost_read), written by the owner.
 */
import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { useA } from './useA';

interface Ref {
  product_id: string;
  option_value_id: string;
  role: 'device' | 'ams';
  ref_product_id: string | null;
  ref_price_usd: string | null;
  product_name: string | null;
  ref_product_name: string | null;
  updated_at: string;
}

export default function ComponentRefs() {
  const { a, lang } = useA();
  const [refs, setRefs] = useState<Ref[] | null>(null);
  const [form, setForm] = useState({ product_id: '', option_value_id: '', role: 'ams' as 'device' | 'ams', ref_product_id: '', ref_price_usd: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ refs: Ref[] }>('/api/admin/trade-in/component-refs')
      .then((d) => setRefs(d.refs))
      .catch((e) => setError(apiRefusal(e, refusalLang(lang), a('loadError'))));
  }, [lang, a]);

  const send = async (method: 'PUT' | 'DELETE', body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/trade-in/component-refs', {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = (await res.json().catch(() => ({}))) as { refs?: Ref[]; code?: string; error?: string };
      if (!res.ok) throw Object.assign(new Error(d.error || a('failed')), { code: d.code });
      setRefs(d.refs ?? []);
      if (method === 'PUT') setForm((f) => ({ ...f, ref_product_id: '', ref_price_usd: '' }));
    } catch (e) {
      setError(apiRefusal(e, refusalLang(lang), a('failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${T.surface} space-y-3 p-4`} data-component-refs>
      <div>
        <h3 className="text-[15px] font-bold">{a('refs')}</h3>
        <p className={`text-[12.5px] ${T.text3}`}>{a('refs.hint')}</p>
      </div>
      {refs === null && !error ? <p className={`text-[12.5px] ${T.text3}`}>{a('loading')}</p> : null}
      {refs && refs.length === 0 ? <p className={`text-[12.5px] ${T.text3}`}>{a('refs.empty')}</p> : null}
      {refs && refs.length ? (
        <ul className="divide-y divide-[var(--ap-hairline)] text-[12.5px]">
          {refs.map((r) => (
            <li key={`${r.product_id}|${r.option_value_id}|${r.role}`} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{r.product_name ?? r.product_id}</span>
                <span className={`block truncate ${T.text3}`} dir="ltr">
                  {r.role} {r.option_value_id ? `· ${r.option_value_id}` : ''} → {r.ref_product_name ?? r.ref_product_id ?? ''} {r.ref_price_usd ? `$${r.ref_price_usd}` : ''}
                </span>
              </span>
              <button
                type="button"
                className={T.btnIconDanger}
                disabled={busy}
                onClick={() => send('DELETE', { product_id: r.product_id, option_value_id: r.option_value_id, role: r.role })}
                aria-label={a('remove')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block min-w-0">
          <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('refs.product')}</span>
          <input className={`${T.input} w-full`} dir="ltr" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value.trim() })} />
        </label>
        <label className="block min-w-0">
          <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('refs.option')}</span>
          <input className={`${T.input} w-full`} dir="ltr" value={form.option_value_id} onChange={(e) => setForm({ ...form, option_value_id: e.target.value.trim() })} />
        </label>
        <label className="block min-w-0">
          <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('refs.role')}</span>
          <select className={`${T.select} w-full`} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'device' | 'ams' })}>
            <option value="ams">{a('refs.role.ams')}</option>
            <option value="device">{a('refs.role.device')}</option>
          </select>
        </label>
        <label className="block min-w-0">
          <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('refs.refProduct')}</span>
          <input className={`${T.input} w-full`} dir="ltr" value={form.ref_product_id} onChange={(e) => setForm({ ...form, ref_product_id: e.target.value.trim() })} />
        </label>
        <label className="block min-w-0">
          <span className={`mb-1 block text-[11.5px] ${T.text3}`}>{a('refs.usd')}</span>
          <input
            className={`${T.input} w-full tabular-nums`}
            dir="ltr"
            inputMode="decimal"
            value={form.ref_price_usd}
            onChange={(e) => setForm({ ...form, ref_price_usd: e.target.value.replace(/[^0-9.]/g, '') })}
          />
        </label>
      </div>
      {error ? (
        <p className="text-[12.5px] text-[var(--ap-danger)]" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className={T.btnPrimary}
        disabled={busy || !form.product_id || (!form.ref_product_id && !form.ref_price_usd)}
        onClick={() =>
          send('PUT', {
            product_id: form.product_id,
            option_value_id: form.option_value_id,
            role: form.role,
            ref_product_id: form.ref_product_id || null,
            ref_price_usd: form.ref_price_usd || null,
          })
        }
        data-refs-save
      >
        {a('refs.add')}
      </button>
    </section>
  );
}
