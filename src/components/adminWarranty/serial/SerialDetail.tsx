/**
 * THE SERIAL / WARRANTY PAGE (brief §15, §16; spec §5.6) — one device, from
 * the day it entered the system to today.
 *
 * Opened as a sheet from three places, so the person who has a serial in
 * front of them never navigates away from what they were doing: a row of the
 * serial inventory, a unit in «أجهزة الطلبات», and a linked slot on the order
 * screen. It reads the EXISTING serial door (GET
 * /api/devices/admin/serial-inventory/:serial, extended with `story` by
 * migration 0178 — critique-1 #24: no second page), so a device known only to
 * the warranty records answers too.
 *
 * Grouped lists in the settings style: what the device is, where it stands,
 * its one warranty, its batch, then the whole history — newest first, who and
 * when. PRIVACY: the server already decided what this viewer may see (the
 * whole serial and the order numbers for the owner and full-scope admins; the
 * masked serial and no order numbers for an assistant), and no cost ever
 * travels here. The one control is the owner's: how a returned device's
 * warranty runs when it is sold again (§14).
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import { Check, Copy, History as HistoryIcon, Lock, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api, ApiError } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { useAuth } from '../../../AuthContext';
import { Sheet } from '../../ui/Sheet';
import { Segmented } from '../../ui/Segmented';
import Spinner from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { serialStrings, type SerialStrings } from '../../adminOrders/serials/strings';
import { dateTime, serialRefusal, shortDate } from '../../adminOrders/serials/serialsApi';
import type { SerialStatus, SerialStory, StoryEvent, WarrantyState } from '../../adminOrders/serials/types';

interface DetailResponse {
  row: null | {
    serial: string;
    serial_norm: string;
    product: { id: string; name: string; name_ar: string } | null;
    variant_id: string | null;
    status: SerialStatus;
    unit: { id: string; order_id: string | null; delivered_at: string | null } | null;
  };
  history: StoryEvent[];
  story?: SerialStory;
}

const STATUS_TONE: Record<string, string> = {
  in_stock: 'bg-info/10 text-info',
  reserved: 'bg-warning/10 text-warning',
  sold: 'bg-success/10 text-success',
  registered: 'bg-success/10 text-success',
  returned: 'bg-warning/10 text-warning',
  unavailable: 'bg-danger/10 text-danger',
  void: 'bg-surface-selected text-text-secondary',
};

const WARRANTY_TONE: Record<string, string> = {
  ACTIVE: 'text-success',
  PENDING_DELIVERY: 'text-warning',
  EXPIRED: 'text-text-secondary',
  RETURNED: 'text-warning',
  CLOSED: 'text-text-secondary',
  NEEDS_CONFIG: 'text-warning',
  NOT_ACTIVATED: 'text-text-secondary',
};

/** What one history row says, in the reader's language. */
export function eventLabel(e: StoryEvent, s: SerialStrings): string {
  const d = e.detail ?? {};
  const orderId = typeof d.order_id === 'string' && d.order_id ? d.order_id : null;
  const reason = typeof d.reason === 'string' ? d.reason : '';
  switch (e.action) {
    case 'serial_inventory.add':
      return d.source === 'prep_scan' ? s.action.firstScan : s.action.added;
    case 'serial_inventory.update':
      return s.action.updated;
    case 'serial_inventory.void':
      return s.action.voided;
    case 'serial_inventory.restore':
      return s.action.restored;
    case 'serial.linked':
      return s.action.linked(orderId);
    case 'serial.unlinked':
      return s.action.removed;
    case 'serial.released':
      if (reason === 'order_cancelled') return `${s.action.cancelled(orderId)} · ${s.action.releasedToStock}`;
      if (reason === 'unlinked') return s.action.removed;
      return s.action.released(s.releaseReasons[reason] ?? reason);
    case 'serial.override':
      return s.action.override(reason);
    case 'serial.warranty_activated':
      return `${s.action.delivered} · ${s.action.activated}`;
    case 'serial.returned':
      return s.action.returned;
    case 'serial.warranty_mode':
      return s.action.warrantyMode(typeof d.to === 'string' ? s.modes[d.to] ?? d.to : '');
    case 'serial.prep_gate_override':
      return s.action.gateOverride(reason);
    case 'serial.prep_gate_breach':
      return s.action.gateBreach;
    case 'serial.warranty_reopened':
      return s.action.reopened;
    case 'serial.detached':
      return s.action.detached;
    default:
      if (e.action.startsWith('device.unit_warranty') || e.action.startsWith('device.unit_delivery')) return s.action.warrantyChanged;
      if (e.action.startsWith('device.')) return s.action.deviceEvent;
      if (e.action.startsWith('warranty.')) return s.action.receiptEvent;
      return e.action;
  }
}

function relative(iso: string, lang: string): string {
  // No browser carries Sorani relative-time words (Intl falls back to
  // English), so a Sorani reader gets the absolute date and time instead.
  if (lang === 'ckb') return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const [n, unit] =
    abs < 60 ? [diff, 'second'] : abs < 3600 ? [diff / 60, 'minute'] : abs < 86400 ? [diff / 3600, 'hour'] : abs < 2592000 ? [diff / 86400, 'day'] : abs < 31536000 ? [diff / 2592000, 'month'] : [diff / 31536000, 'year'];
  try {
    return new Intl.RelativeTimeFormat(lang === 'en' ? 'en' : 'ar-IQ-u-nu-latn', { numeric: 'auto' }).format(Math.round(n), unit as Intl.RelativeTimeFormatUnit);
  } catch {
    return '';
  }
}

export default function SerialDetail({ serial, onClose }: { serial: string | null; onClose: () => void }) {
  const { lang, dir } = useLanguage();
  const s = serialStrings(lang);
  const toast = useToast();
  const { user } = useAuth();
  const owner = !!user?.is_owner;
  const titleId = useId();
  const reasonId = useId();

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'carry' | 'restart'>('carry');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (sn: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<DetailResponse>(`/api/devices/admin/serial-inventory/${encodeURIComponent(sn)}`);
      setData(res);
      const wm = res.story?.warranty.mode;
      setMode(wm === 'restart' ? 'restart' : 'carry');
    } catch (e) {
      setData(null);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!serial) return;
    setReason('');
    void load(serial);
  }, [serial, load]);

  const story = data?.story ?? null;
  const shown = story?.serial ?? story?.serial_display ?? data?.row?.serial ?? serial ?? '';
  const status: SerialStatus | null = story?.status ?? data?.row?.status ?? null;
  const history = story?.history ?? data?.history ?? [];
  const productName = (p: { name: string; name_ar: string } | null | undefined) => (p ? (lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name) : null);
  const product = productName(story?.product ?? data?.row?.product);
  const resaleOpen =
    owner && !!story?.current_order && !story.current_order.activated && (story.warranty.mode === 'carry' || story.warranty.mode === 'restart');

  // What may be copied is what this viewer may see whole: with a story, only
  // its `serial` (absent for an assistant — UX review #1); without one (the
  // database before 0178), the inventory row as it always was.
  const copyable = story ? story.serial ?? null : data?.row?.serial ?? null;
  const copy = () => {
    if (!copyable) return;
    void navigator.clipboard?.writeText(copyable);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1200);
  };

  const saveMode = async () => {
    if (!serial || reason.trim().length < 5 || saving) return;
    setSaving(true);
    try {
      await api.post(`/api/devices/admin/serial-inventory/${encodeURIComponent(serial)}/warranty-mode`, { mode, reason: reason.trim() });
      toast.success(s.saved);
      setReason('');
      await load(serial);
    } catch (e) {
      const r = serialRefusal(e, lang);
      toast.error(r.text);
    } finally {
      setSaving(false);
    }
  };

  const warrantyState: WarrantyState | null = story?.warranty.state ?? null;
  const pending = warrantyState === 'PENDING_DELIVERY';

  // The header is the sheet's drag handle (v2 Sheet); the page below scrolls.
  const header = (
    <div className="border-b border-border-subtle" dir={dir}>
      <div className="flex items-center justify-between gap-3 ps-4 pe-2 py-2">
        <h2 id={titleId} className="text-[16px] font-bold text-text-primary truncate">
          {s.pageTitle}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-selected hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </div>
  );

  return (
    <Sheet
      open={!!serial}
      onClose={onClose}
      detents={['large']}
      header={header}
      labelledBy={titleId}
      z={230}
      testId="serial-detail"
      panelClassName="sm:max-w-xl sm:h-[min(85dvh,44rem)]"
    >
      <div className="min-h-full bg-canvas px-4 py-4 space-y-5" dir={dir} data-serial-detail>
        {loading && !data ? (
          <div className="flex justify-center py-16" role="status" aria-label={s.loading}>
            <Spinner size="md" />
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-border-subtle bg-surface p-4 text-center" role="alert">
            <p className="text-[14px] text-text-primary">
              {error instanceof ApiError && error.status === 404 ? s.notFound : serialRefusal(error, lang).text}
            </p>
            {serial && !(error instanceof ApiError && error.status === 404) && (
              <button
                type="button"
                onClick={() => void load(serial)}
                className="mt-3 inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-full border border-border-subtle text-[13px] font-semibold text-text-primary hover:bg-surface-selected"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                {s.retry}
              </button>
            )}
          </div>
        ) : data ? (
          <>
            {/* ---------------------------------------------------- header */}
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono tabular-nums text-[19px] font-semibold text-text-primary break-all" data-serial-detail-value>
                  <span dir="ltr">{shown}</span>
                </p>
                {status && (
                  <span className={`mt-1.5 inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${STATUS_TONE[status] ?? STATUS_TONE.void}`} data-serial-detail-status={status}>
                    {s.status[status] ?? status}
                  </span>
                )}
              </div>
              {copyable && (
                <button
                  type="button"
                  onClick={copy}
                  aria-label={s.copy}
                  title={s.copy}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-surface-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                >
                  {copied ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  <span className="sr-only" aria-live="polite">
                    {copied ? s.copied : ''}
                  </span>
                </button>
              )}
            </header>
            {story?.legacy && <p className="text-[12px] text-text-secondary">{s.legacy}</p>}

            {/* ------------------------------------------------ identity */}
            <Group>
              <Row label={s.serial} value={<span className="font-mono" dir="ltr">{shown}</span>} />
              <Row label={s.product} value={product ?? s.none} />
              <Row label={s.variant} value={story?.variant?.label ? <bdi>{story.variant.label}</bdi> : s.none} />
              <Row label={s.sku} value={story?.sku ? <span className="font-mono" dir="ltr">{story.sku}</span> : s.none} />
            </Group>

            {/* ------------------------------------------------ whereabouts */}
            <Group>
              <Row label={s.currentStatus} value={status ? s.status[status] ?? status : s.none} />
              <Row
                label={s.currentOrder}
                value={
                  story?.current_order ? (
                    <span className="inline-flex flex-col items-end">
                      <OrderId id={story.current_order.order_id} s={s} />
                      <span className="text-[11.5px] text-text-secondary">{s.unitOf(story.current_order.unit_index)}</span>
                    </span>
                  ) : data.row?.unit?.order_id ? (
                    <OrderId id={data.row.unit.order_id} s={s} />
                  ) : (
                    s.none
                  )
                }
              />
              <div className="px-4 py-3">
                <p className="text-[13px] text-text-secondary">{s.previousOrders}</p>
                {story && story.previous_orders.length > 0 ? (
                  <ul className="mt-1.5 space-y-1.5" data-serial-previous-orders>
                    {story.previous_orders.map((o, i) => (
                      <li key={`${o.linked_at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]">
                        <OrderId id={o.order_id} s={s} />
                        <span className="text-[12px] text-text-secondary">
                          {o.reason ? s.releaseReasons[o.reason] ?? o.reason : ''}
                          {o.released_at ? ` · ${shortDate(o.released_at, lang)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-[13px] text-text-primary">{s.none}</p>
                )}
              </div>
            </Group>

            {/* ---------------------------------------------------- warranty */}
            {story && (
              <section aria-labelledby={`${titleId}-warranty`}>
                <h3 id={`${titleId}-warranty`} className="px-1 pb-1.5 text-[12.5px] font-semibold text-text-secondary flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  {s.warrantyCard}
                </h3>
                <Group>
                  <Row
                    label={s.warrantyStatus}
                    value={
                      <span className={`font-semibold ${WARRANTY_TONE[warrantyState ?? ''] ?? 'text-text-primary'}`} data-serial-warranty-state={warrantyState ?? ''}>
                        {warrantyState ? s.warranty[warrantyState] ?? warrantyState : s.none}
                      </span>
                    }
                  />
                  {/* Before delivery the clock has not started (§7, §8): the start is
                      the delivery, and so is the end — unless a resold returned
                      device carries its original end (§14). */}
                  <Row label={s.warrantyStart} value={pending ? s.atDelivery : story.warranty.start_at ? shortDate(story.warranty.start_at, lang) : s.none} />
                  <Row
                    label={s.warrantyEnd}
                    value={
                      pending && !(story.warranty.mode === 'carry' && story.warranty.end_at) ? (
                        s.atDelivery
                      ) : story.warranty.end_at ? (
                        <span className="inline-flex flex-col items-end">
                          <span>{shortDate(story.warranty.end_at, lang)}</span>
                          {typeof story.warranty.remaining_days === 'number' && story.warranty.remaining_days > 0 && (
                            <span className="text-[11.5px] text-text-secondary tabular-nums">{s.remaining(story.warranty.remaining_days)}</span>
                          )}
                        </span>
                      ) : (
                        s.none
                      )
                    }
                  />
                  {story.warranty.mode && <Row label={s.mode} value={s.modes[story.warranty.mode] ?? story.warranty.mode} />}
                </Group>
              </section>
            )}

            {/* -------------------------------------- owner: resale warranty */}
            {story?.current_order && !story.current_order.activated && (story.warranty.mode === 'carry' || story.warranty.mode === 'restart') && (
              <section className="rounded-2xl border border-border-subtle bg-surface p-4 space-y-2.5" data-serial-resale>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[14px] font-semibold text-text-primary">{s.resaleTitle}</p>
                  {!owner && (
                    <span className="inline-flex items-center gap-1 text-[11.5px] text-text-secondary">
                      <Lock className="h-3.5 w-3.5" aria-hidden />
                      {s.policyOwnerOnly}
                    </span>
                  )}
                </div>
                <p className="text-[12px] leading-relaxed text-text-secondary">{s.resaleHint}</p>
                {resaleOpen ? (
                  <form
                    className="space-y-2.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveMode();
                    }}
                  >
                    <Segmented
                      group={`serial-resale-${titleId}`}
                      label={s.resaleTitle}
                      value={mode}
                      onChange={(id) => setMode(id as 'carry' | 'restart')}
                      size="sm"
                      items={[
                        { id: 'carry', label: s.modeCarry },
                        { id: 'restart', label: s.modeRestart },
                      ]}
                    />
                    <div>
                      <label htmlFor={reasonId} className="block text-[12px] font-semibold text-text-secondary mb-1">
                        {s.reasonLabel}
                      </label>
                      <textarea
                        id={reasonId}
                        rows={2}
                        minLength={5}
                        maxLength={500}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        aria-describedby={`${reasonId}-hint`}
                        className="w-full rounded-xl border border-border-subtle bg-surface-raised px-3 py-2 text-[14px] text-text-primary outline-none focus:border-gold resize-none"
                      />
                      {/* Why «حفظ» waits, said next to the field (UX review #17). */}
                      <p id={`${reasonId}-hint`} className="mt-0.5 text-[11.5px] text-text-secondary">
                        {s.reasonHint}
                      </p>
                    </div>
                    <button
                      type="submit"
                      disabled={reason.trim().length < 5 || saving || mode === story.warranty.mode}
                      className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-gold text-accent-contrast text-[13.5px] font-bold disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                    >
                      {saving && <Spinner size="sm" delayMs={0} decorative />}
                      {s.save}
                    </button>
                  </form>
                ) : (
                  <p className="text-[13px] text-text-primary">{s.modes[story.warranty.mode] ?? story.warranty.mode}</p>
                )}
              </section>
            )}

            {/* ------------------------------------------------------- batch */}
            {story?.lot && (
              <Group>
                <Row
                  label={s.batch}
                  value={
                    <span className="inline-flex flex-col items-end">
                      <span className="font-mono text-[12.5px]" dir="ltr">
                        {story.lot.id}
                      </span>
                      {story.lot.source && <span className="text-[11.5px] text-text-secondary">{s.lotSources[story.lot.source] ?? story.lot.source}</span>}
                    </span>
                  }
                />
              </Group>
            )}

            {/* ----------------------------------------------------- history */}
            <section aria-labelledby={`${titleId}-history`}>
              <h3 id={`${titleId}-history`} className="px-1 pb-2 text-[12.5px] font-semibold text-text-secondary flex items-center gap-1.5">
                <HistoryIcon className="h-3.5 w-3.5" aria-hidden />
                {s.history}
              </h3>
              {history.length === 0 ? (
                <p className="px-1 text-[13px] text-text-secondary">{s.historyEmpty}</p>
              ) : (
                <ol className="relative ms-2 border-s border-border-subtle" data-serial-timeline>
                  {history.map((e, i) => {
                    const who = e.actor ? e.actor.email || e.actor.username || e.actor.id : s.system;
                    const label = eventLabel(e, s);
                    const rel = relative(e.created_at, lang);
                    return (
                      <li key={`${e.id}-${i}`} className="relative ps-5 pb-4 last:pb-0" data-serial-event={e.action}>
                        <span
                          aria-hidden
                          className={`absolute -start-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-canvas ${i === 0 ? 'bg-gold' : 'bg-text-secondary/60'}`}
                        />
                        <p className="text-[13.5px] font-semibold text-text-primary leading-snug break-words">{label}</p>
                        <p className="mt-0.5 text-[12px] text-text-secondary">
                          <time dateTime={e.created_at} title={dateTime(e.created_at, lang)}>
                            {rel || dateTime(e.created_at, lang)}
                          </time>
                          {' · '}
                          <span className="break-all" dir="auto">
                            {who}
                          </span>
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border-subtle bg-surface divide-y divide-border-subtle overflow-hidden">{children}</div>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 min-h-[44px]">
      <span className="text-[13px] text-text-secondary shrink-0">{label}</span>
      <span className="min-w-0 text-[13.5px] text-text-primary text-end break-words">{value}</span>
    </div>
  );
}

function OrderId({ id, s }: { id: string | null; s: SerialStrings }) {
  if (!id) return <span className="text-text-secondary">{s.hiddenOrder}</span>;
  return (
    <span className="font-mono text-[13px]" dir="ltr">
      {id}
    </span>
  );
}
