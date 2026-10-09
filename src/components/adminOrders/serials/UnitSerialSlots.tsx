/**
 * «Scan Serial» — ONE SLOT PER PHYSICAL UNIT (brief §1, §18, §20, §21).
 *
 * An order with «A1 Combo ×2» shows «الوحدة 1» and «الوحدة 2», each with its
 * own control: the serial is bound to the unit inside the order line, never
 * to the product as a whole. Bundle components carry their own slots; a
 * bundle parent never does (the server's slot list decides — this screen
 * draws exactly what `serials.slots` says).
 *
 * ONE CONTROL FOR EVERY INPUT (critique-1 #14). The empty slot is a capsule:
 * a real `<form>` whose field takes a USB / Bluetooth / keyboard-style reader
 * (it types and presses Enter) or a person typing, and whose «امسح الرقم
 * التسلسلي» opens the camera sheet. An iPad with a Bluetooth reader reports a
 * coarse pointer, so the field is there on touch screens too. After a link
 * typed into a field, focus moves to the next empty unit — never after a
 * value that is a BOX SN (critique-2 H1): the next read is that box's own
 * device serial and belongs to the SAME unit.
 *
 * LINKED: a check, «تم ربط الرقم التسلسلي», the serial (whole for every
 * admin since owner decision 1, 2026-10-09 — the server decides what it
 * sends, and a masked form still renders), «تغيير» and «إزالة». Removing releases only the link; the device
 * keeps its record, warranty identity and history (§20).
 *
 * Nothing is decided here: every value goes to the server, which validates,
 * links atomically and answers with a code this screen puts into words.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Camera, Check, CheckCircle2, CircleAlert, History, Link2, RotateCcw, ScanLine, ShieldAlert } from 'lucide-react';
import { ApiError } from '../../../lib/api';
import { refusalText } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import { useToast } from '../../ui/Toast';
import { useConfirm } from '../../ui/ConfirmDialog';
import { usePrompt } from '../../ui/PromptDialog';
import Spinner from '../../ui/Spinner';
import { primeScannerAudio, scanFeedback } from '../../scanner/feedback';
import { serialStrings, type SerialStrings } from './strings';
import { looksLikeBoxSn, newOpId, overrideFor, serialRefusal, serialsApi, shortDate, type ReadPayload } from './serialsApi';
import { WedgeTracker, isTerminator } from './wedge';
import SerialScanSheet from './SerialScanSheet';
import type { LinkResult, OrderSerials, ScanTarget, SerialSlotView, SlotAssignment } from './types';

export const slotKey = (s: { order_item_id: string; unit_index: number; part?: string }) => `${s.order_item_id}:${s.unit_index}`;

/** The serials view with one slot's link replaced, and the counts kept honest. */
export function withSlot(serials: OrderSerials, at: { order_item_id: string; unit_index: number }, assignment: SlotAssignment | null): OrderSerials {
  const slots = (serials.slots ?? []).map((s) =>
    s.order_item_id === at.order_item_id && s.unit_index === at.unit_index ? { ...s, assignment, previous: assignment ? null : s.previous } : s
  );
  const linked = slots.filter((s) => s.assignment).length;
  const missing = slots
    .filter((s) => !s.assignment)
    .map((s) => ({ order_item_id: s.order_item_id, unit_index: s.unit_index, part: s.part, product_name: s.product_name }));
  return { ...serials, slots, linked, missing };
}

interface SlotError {
  error: unknown;
  read: ReadPayload;
}

export interface SerialSlotsPanelProps {
  orderId: string;
  serials: OrderSerials;
  viewerOwner: boolean;
  onChanged: (next: OrderSerials) => void;
  /** Opens the §16 serial page; only offered where the whole serial is known. */
  onOpenSerial?: (serial: string) => void;
  /** «اذهب إلى الوحدة» from the blocker: the slot to bring into view (`n` re-triggers). */
  focusRequest?: { key: string; n: number } | null;
  /**
   * Called once the request above was carried out, so the holder can clear it:
   * a request that outlives its moment would scroll and steal the focus again
   * on every remount of this tab (UX review #4).
   */
  onFocusHandled?: () => void;
  /** The order's legacy status: outside the window the owner may still link — as an exception. */
  orderStatus?: string;
}

export default function UnitSerialSlots({ orderId, serials, viewerOwner, onChanged, onOpenSerial, focusRequest, onFocusHandled, orderStatus }: SerialSlotsPanelProps) {
  const { lang, dir } = useLanguage();
  const s = serialStrings(lang);
  const motionPrefs = useMotion();
  const l3 = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [prompt, promptDialog] = usePrompt();

  const slots = useMemo(() => serials.slots ?? [], [serials.slots]);
  const inWindow = !!serials.window;
  const locked = !!serials.shipment_locked;
  // Staff link while the order is on the shelf and before a courier shipment.
  // The owner may also try outside the window (a shipped order missing a
  // serial): the server refuses ORDER_NOT_PREPARABLE and the refusal offers
  // the owner's «outside_window» exception with its mandatory reason — the
  // exception stays a deliberate second step, never a quiet link.
  const ownerOutside = viewerOwner && !inWindow && !!orderStatus && orderStatus !== 'cancelled' && orderStatus !== 'delivered';
  const canCapture = (inWindow && (!locked || viewerOwner)) || ownerOutside;
  // A removal outside the window, or once a courier holds the parcel, is the
  // owner's exception and carries a reason (server: unlink, owner + 5–500).
  const removalNeedsReason = !inWindow || locked;

  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, SlotError>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sheet, setSheet] = useState<{ target: ScanTarget; initialRefusal: SlotError | null } | null>(null);
  const [justLinked, setJustLinked] = useState<string | null>(null);
  const trackers = useRef(new Map<string, WedgeTracker>());
  /**
   * A reader's burst that arrives while its unit is still being checked (the
   * operator already moved to the next box): kept, and linked to the next
   * empty unit once the first link lands — never silently dropped (UX #5).
   */
  const queueTrackers = useRef(new Map<string, WedgeTracker>());
  const queuedRead = useRef<{ from: string; text: string; source: ReadPayload['source'] } | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const rows = useRef(new Map<string, HTMLElement>());
  const afterSheet = useRef<string | null>(null);
  const serialsRef = useRef(serials);
  serialsRef.current = serials;

  const trackerFor = (key: string, map = trackers.current) => {
    let t = map.get(key);
    if (!t) {
      t = new WedgeTracker();
      map.set(key, t);
    }
    return t;
  };
  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  /**
   * Re-read the whole view (counts, gate, flags) after the slot was patched in
   * place. Only the LATEST re-read lands: two quick links start two reads, and
   * the first answer — which predates the second link — must not paint over it.
   */
  const refreshSeq = useRef(0);
  const refresh = useCallback(() => {
    const n = ++refreshSeq.current;
    serialsApi
      .view(orderId)
      .then((v) => {
        if (n === refreshSeq.current && v && v.installed) onChanged(v);
      })
      .catch(() => undefined);
  }, [orderId, onChanged]);

  const applyLink = useCallback(
    (res: LinkResult, read: ReadPayload, fromSheet = false) => {
      const key = slotKey(res.slot);
      onChanged(withSlot(serialsRef.current, res.slot, res.slot.assignment));
      setErrors((e) => {
        const { [key]: _gone, ...rest } = e;
        void _gone;
        return rest;
      });
      setJustLinked(key);
      // The camera sheet showed its own verdict (and keeps a warning on screen
      // until «تم»): a toast on top would say it twice (UX review #7).
      if (!fromSheet) {
        // §31's one sentence for a device already on record (critique-1 #32).
        toast.success(res.outcome === 'existing' ? refusalText('SERIAL_EXISTING_LINKED', l3, s.existingLine1) : s.linkedLine, {
          id: `serial-${key}`,
          description: res.slot.assignment?.serial_display,
        });
        for (const w of res.warnings) toast.info(s.warnings[w] ?? w, { id: `serial-${key}-${w}` });
      }
      refresh();
      return read;
    },
    [onChanged, refresh, s, toast, l3]
  );

  /** The next empty unit after `key`, in screen order. */
  const nextEmpty = (key: string): string | null => {
    const list = serialsRef.current.slots ?? [];
    const at = list.findIndex((x) => slotKey(x) === key);
    for (let i = 1; i <= list.length; i++) {
      const cand = list[(at + i) % list.length];
      if (cand && !cand.assignment && slotKey(cand) !== key) return slotKey(cand);
    }
    return null;
  };

  const submitField = async (slot: SerialSlotView, override?: { text: string; source: ReadPayload['source'] }) => {
    const key = slotKey(slot);
    if (busy.has(key)) return;
    const { text, source } = override ?? trackerFor(key).finish(drafts[key] ?? '');
    if (!text) return;
    const read: ReadPayload = { code: text, source };
    setBusyKey(key, true);
    setErrors((e) => {
      const { [key]: _gone, ...rest } = e;
      void _gone;
      return rest;
    });
    let follow: { slot: SerialSlotView; text: string; source: ReadPayload['source'] } | null = null;
    try {
      const res = await serialsApi.scan(orderId, slot, read, newOpId());
      setDrafts((d) => ({ ...d, [key]: '' }));
      trackerFor(key).reset();
      scanFeedback('added');
      applyLink(res, read);
      // A reader fills Unit 1, Unit 2, Unit 3 without a mouse — but never
      // advances past a box SN (the device serial of that box comes next).
      const next = source !== 'relink' && !looksLikeBoxSn(text) ? nextEmpty(key) : null;
      const queued = queuedRead.current?.from === key ? queuedRead.current : null;
      if (queued) queuedRead.current = null;
      const nextSlot = next ? (serialsRef.current.slots ?? []).find((x) => slotKey(x) === next) ?? null : null;
      if (queued && nextSlot) follow = { slot: nextSlot, text: queued.text, source: queued.source };
      else if (queued && !looksLikeBoxSn(text)) toast.info(s.queuedDropped, { id: `serial-queued-${key}` });
      // Otherwise the cursor stays on this unit (its field is gone now that
      // it is linked), so the keyboard never falls back to the page.
      afterPaint(() => (next ? inputs.current.get(next) : rows.current.get(key))?.focus({ preventScroll: !next }));
    } catch (e) {
      setErrors((prev) => ({ ...prev, [key]: { error: e, read } }));
      scanFeedback(e instanceof ApiError && e.code === 'SERIAL_INVALID' ? 'invalid' : 'exists');
      // The read that came in behind a refused one has no unit to go to: say so.
      if (queuedRead.current?.from === key) {
        queuedRead.current = null;
        toast.info(s.queuedDropped, { id: `serial-queued-${key}` });
      }
      afterPaint(() => inputs.current.get(key)?.select());
    } finally {
      setBusyKey(key, false);
      queueTrackers.current.get(key)?.reset();
    }
    // The burst that waited: into the next empty unit, through the same door.
    if (follow) void submitField(follow.slot, { text: follow.text, source: follow.source });
  };

  const openSheet = (slot: SerialSlotView, replace?: SlotAssignment, initialRefusal: SlotError | null = null) => {
    primeScannerAudio();
    setSheet({
      target: {
        order_item_id: slot.order_item_id,
        unit_index: slot.unit_index,
        part: slot.part,
        product_name: slot.product_name,
        variant_label: slot.variant_label,
        ...(replace ? { replaceAssignmentId: replace.id } : {}),
      },
      initialRefusal,
    });
  };

  const remove = async (slot: SerialSlotView, a: SlotAssignment) => {
    const key = slotKey(slot);
    let reason: string | undefined;
    if (!removalNeedsReason) {
      const ok = await confirm({ title: s.removeTitle, consequence: s.removeBody, confirmLabel: s.removeConfirm, cancelLabel: s.cancel, destructive: true });
      if (!ok) return;
    } else {
      const answer = await prompt({
        title: s.removeTitle,
        description: s.removeOutsideBody,
        label: s.reasonLabel,
        required: true,
        multiline: true,
        maxLength: 500,
        validate: (v) => (v.trim().length < 5 ? s.reasonHint : null),
        confirmLabel: s.removeConfirm,
        cancelLabel: s.cancel,
        destructive: true,
      });
      if (answer === null) return;
      reason = answer.trim();
    }
    setBusyKey(key, true);
    try {
      await serialsApi.unlink(orderId, a.id, reason);
      onChanged(withSlot(serialsRef.current, slot, null));
      toast.success(s.removed, { id: `serial-${key}` });
      refresh();
      // The field when it is there (a reader's next scan goes into it), else the row.
      afterPaint(() => (inputs.current.get(key) ?? rows.current.get(key))?.focus());
    } catch (e) {
      const r = serialRefusal(e, lang);
      toast.error(r.text, { description: r.detail ?? undefined });
    } finally {
      setBusyKey(key, false);
    }
  };

  /** §30 «أعد ربطه»: the slot's previous serial, by its released binding (the client never needs to hold it). */
  const relink = async (slot: SerialSlotView) => {
    const prev = slot.previous;
    if (!prev) return;
    const key = slotKey(slot);
    if (busy.has(key)) return;
    const read: ReadPayload = { code: prev.serial_full ?? prev.serial_display, source: 'relink', ...(prev.assignment_id ? { previous_assignment_id: prev.assignment_id } : {}) };
    setBusyKey(key, true);
    try {
      const res = await serialsApi.scan(orderId, slot, read, newOpId());
      scanFeedback('added');
      applyLink(res, read);
      afterPaint(() => rows.current.get(key)?.focus({ preventScroll: true }));
    } catch (e) {
      setErrors((p) => ({ ...p, [key]: { error: e, read } }));
      scanFeedback('exists');
    } finally {
      setBusyKey(key, false);
    }
  };

  // «اذهب إلى الوحدة»: bring the slot into view and put the cursor in it —
  // once: the holder clears the request, so a remount never replays it.
  const focusHandled = useRef(onFocusHandled);
  focusHandled.current = onFocusHandled;
  useEffect(() => {
    if (!focusRequest) return;
    const el = rows.current.get(focusRequest.key);
    if (!el) return;
    // A JS `behavior` wins over the CSS reduced-motion rule, so it is chosen here.
    el.scrollIntoView({ block: 'center', behavior: motionPrefs.reduced ? 'auto' : 'smooth' });
    afterPaint(() => (inputs.current.get(focusRequest.key) ?? el).focus({ preventScroll: true }));
    focusHandled.current?.();
  }, [focusRequest, motionPrefs.reduced]);

  // The «just linked» glow is a moment, not a state.
  useEffect(() => {
    if (!justLinked) return;
    const t = globalThis.setTimeout(() => setJustLinked(null), 1600);
    return () => globalThis.clearTimeout(t);
  }, [justLinked]);

  const groups = useMemo(() => {
    const out: Array<{ id: string; name: string; variant: string | null; slots: SerialSlotView[] }> = [];
    for (const slot of slots) {
      const g = out.find((x) => x.id === slot.order_item_id);
      if (g) g.slots.push(slot);
      else out.push({ id: slot.order_item_id, name: slot.product_name, variant: slot.variant_label, slots: [slot] });
    }
    return out;
  }, [slots]);

  if (!serials.installed || slots.length === 0) return null;
  const linkedCount = slots.filter((x) => x.assignment).length;

  return (
    <div className="space-y-3" dir={dir} data-serial-slots data-serial-linked={linkedCount} data-serial-required={slots.length}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] leading-relaxed text-text-secondary max-w-[60ch]">{s.sectionHint}</p>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold tabular-nums ${
            linkedCount === slots.length ? 'bg-success/10 text-success' : 'bg-surface-selected text-text-secondary'
          }`}
          data-serial-progress
        >
          {linkedCount === slots.length && <Check className="h-3.5 w-3.5" aria-hidden />}
          {linkedCount === slots.length ? s.allLinked : s.progress(linkedCount, slots.length)}
        </span>
      </div>
      {!inWindow && (
        <p className="text-[12px] text-text-secondary" data-serial-readonly>
          {ownerOutside ? s.ownerOutsideHint : s.readOnly}
        </p>
      )}
      {inWindow && locked && <p className="text-[12px] text-warning" data-serial-locked>{s.shipmentLocked}</p>}

      {groups.map((g) => {
        const done = g.slots.filter((x) => x.assignment).length;
        return (
          <div key={g.id} className="rounded-2xl border border-border-subtle bg-surface overflow-hidden" data-serial-group={g.id}>
            <div className="flex items-start justify-between gap-3 px-3.5 pt-3 pb-2">
              <div className="min-w-0">
                <p className="text-[14px] font-bold text-text-primary leading-snug break-words">{g.name}</p>
                {g.variant && (
                  <p className="text-[12px] text-text-secondary mt-0.5 break-words">
                    <bdi>{g.variant}</bdi>
                  </p>
                )}
              </div>
              <span className={`shrink-0 text-[12px] tabular-nums ${done === g.slots.length ? 'text-success' : 'text-text-secondary'}`}>
                {s.progress(done, g.slots.length)}
              </span>
            </div>
            <ul className="divide-y divide-border-subtle">
              {g.slots.map((slot) => {
                const key = slotKey(slot);
                return (
                  <SlotRow
                    key={key}
                    s={s}
                    lang={lang}
                    slot={slot}
                    busy={busy.has(key)}
                    canCapture={canCapture}
                    canEdit={canCapture || (viewerOwner && !inWindow)}
                    viewerOwner={viewerOwner}
                    glow={justLinked === key}
                    error={errors[key] ?? null}
                    draft={drafts[key] ?? ''}
                    onDraft={(v) => {
                      setDrafts((d) => ({ ...d, [key]: v }));
                      if (!v) trackerFor(key).reset();
                    }}
                    onKey={(e) => {
                      // While this unit is being checked its field is read-only:
                      // keys typed now are not part of the value it will send —
                      // but a READER's burst is the next box: it waits in line.
                      if (busy.has(key)) {
                        const q = trackerFor(key, queueTrackers.current);
                        if (isTerminator(e.key, q.inBurst)) {
                          e.preventDefault();
                          const r = q.finish('');
                          if (r.text && r.source === 'scanner') queuedRead.current = { from: key, text: r.text, source: r.source };
                          return;
                        }
                        q.push(e.nativeEvent);
                        return;
                      }
                      const t = trackerFor(key);
                      if (isTerminator(e.key, t.inBurst)) {
                        if (e.key === 'Tab') {
                          // A reader that ends with Tab: submit, do not wander off.
                          e.preventDefault();
                          void submitField(slot);
                        }
                        return;
                      }
                      t.push(e.nativeEvent);
                    }}
                    onSubmit={() => void submitField(slot)}
                    onCamera={() => openSheet(slot)}
                    onChange={(a) => openSheet(slot, a)}
                    onRemove={(a) => void remove(slot, a)}
                    onRelink={() => void relink(slot)}
                    onOverride={(err) => openSheet(slot, undefined, err)}
                    onOpenSerial={onOpenSerial}
                    inputRef={(el) => {
                      if (el) inputs.current.set(key, el);
                      else inputs.current.delete(key);
                    }}
                    rowRef={(el) => {
                      if (el) rows.current.set(key, el);
                      else rows.current.delete(key);
                    }}
                  />
                );
              })}
            </ul>
          </div>
        );
      })}

      <SerialScanSheet
        orderId={orderId}
        target={sheet?.target ?? null}
        viewerOwner={viewerOwner}
        initialRefusal={sheet?.initialRefusal ?? null}
        onClose={() => {
          if (sheet) afterSheet.current = slotKey(sheet.target);
          setSheet(null);
        }}
        onExited={() => {
          // Focus lands where the work continues: the unit just handled.
          const key = afterSheet.current;
          afterSheet.current = null;
          if (key) (inputs.current.get(key) ?? rows.current.get(key))?.focus({ preventScroll: false });
        }}
        onLinked={(res, read) => applyLink(res, read, true)}
      />
      {confirmDialog}
      {promptDialog}
    </div>
  );
}

/** After React has committed the change that the focus target depends on. */
function afterPaint(fn: () => void) {
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(() => fn());
  else globalThis.setTimeout(fn, 0);
}

function SlotRow({
  s,
  lang,
  slot,
  busy,
  canCapture,
  canEdit,
  viewerOwner,
  glow,
  error,
  draft,
  onDraft,
  onKey,
  onSubmit,
  onCamera,
  onChange,
  onRemove,
  onRelink,
  onOverride,
  onOpenSerial,
  inputRef,
  rowRef,
}: {
  s: SerialStrings;
  lang: string;
  slot: SerialSlotView;
  busy: boolean;
  canCapture: boolean;
  canEdit: boolean;
  viewerOwner: boolean;
  glow: boolean;
  error: SlotError | null;
  draft: string;
  onDraft: (v: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
  onCamera: () => void;
  onChange: (a: SlotAssignment) => void;
  onRemove: (a: SlotAssignment) => void;
  onRelink: () => void;
  onOverride: (err: SlotError) => void;
  onOpenSerial?: (serial: string) => void;
  inputRef: (el: HTMLInputElement | null) => void;
  rowRef: (el: HTMLElement | null) => void;
}) {
  const m = useMotion();
  const a = slot.assignment;
  const key = slotKey(slot);
  const inputId = `serial-input-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const errId = `${inputId}-err`;
  const refusal = error ? serialRefusal(error.error, lang) : null;
  const overrideKind = error && viewerOwner ? overrideFor(error.error) : null;

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      data-serial-slot={key}
      data-serial-state={a ? 'linked' : 'empty'}
      className={`px-3.5 py-3 outline-none transition-colors duration-300 focus-visible:bg-surface-selected ${glow ? 'bg-success/[0.07]' : ''}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 min-h-[44px]">
        <span className="shrink-0 sm:w-20 text-[13px] font-semibold text-text-secondary">{s.unit(slot.unit_index)}</span>

        {a ? (
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2.5">
              <motion.span
                key={a.id}
                initial={{ scale: m.reduced ? 1 : 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={m.spring('quick')}
                className="mt-0.5 shrink-0 text-success"
              >
                <CheckCircle2 className="h-5 w-5" aria-hidden />
              </motion.span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-text-primary">{s.linked}</p>
                {a.serial_full && onOpenSerial ? (
                  <button
                    type="button"
                    onClick={() => onOpenSerial(a.serial_full!)}
                    className="font-mono tabular-nums text-[14px] text-text-primary break-all text-start underline decoration-border-subtle underline-offset-4 hover:decoration-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold rounded"
                    dir="ltr"
                    aria-label={s.openSerialPage(a.serial_display)}
                    data-serial-value
                  >
                    {a.serial_display}
                  </button>
                ) : (
                  <p className="font-mono tabular-nums text-[14px] text-text-primary break-all" data-serial-value>
                    <SerialText value={a.serial_display} s={s} />
                  </p>
                )}
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {canCapture && (
                    <button
                      type="button"
                      onClick={() => onChange(a)}
                      disabled={busy}
                      className="min-h-[44px] px-2.5 rounded-lg text-[13px] font-semibold text-text-primary hover:bg-surface-selected disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                      aria-label={`${s.change} · ${s.unit(slot.unit_index)}`}
                      data-serial-change
                    >
                      {s.change}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(a)}
                    disabled={busy}
                    className="min-h-[44px] px-2.5 rounded-lg text-[13px] font-semibold text-danger hover:bg-danger/10 disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                    aria-label={`${s.remove} · ${s.unit(slot.unit_index)}`}
                    data-serial-remove
                  >
                    {busy ? <Spinner size="sm" delayMs={0} decorative /> : s.remove}
                  </button>
                </div>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 ps-[1.875rem]" data-serial-chips>
              {a.warranty.state === 'PENDING_DELIVERY' &&
                (a.warranty.mode === 'carry' && a.warranty.carries_until ? (
                  <Chip tone="warn">{s.returnedCarry(shortDate(a.warranty.carries_until, lang))}</Chip>
                ) : a.warranty.mode === 'restart' ? (
                  <Chip tone="warn">{s.returnedRestart}</Chip>
                ) : (
                  <Chip>{s.warrantyAtDelivery}</Chip>
                ))}
              {a.warranty.state !== 'PENDING_DELIVERY' && <Chip tone={a.warranty.state === 'ACTIVE' ? 'ok' : 'neutral'}>{s.warranty[a.warranty.state] ?? a.warranty.state}</Chip>}
              {a.override_kind && (
                <Chip tone="warn">
                  <ShieldAlert className="h-3 w-3" aria-hidden />
                  {s.overrideBadge}
                </Chip>
              )}
              {a.lot?.received_at && <Chip>{s.lot(shortDate(a.lot.received_at, lang))}</Chip>}
            </div>
          </div>
        ) : canCapture ? (
          <form
            className="min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
            data-serial-form
          >
            <div
              className={`flex h-11 items-center gap-2 rounded-full border bg-surface-raised ps-3.5 pe-1 transition-colors focus-within:border-gold/60 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-gold)_18%,transparent)] ${
                refusal ? 'border-danger/50' : 'border-border-subtle'
              }`}
            >
              <ScanLine className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
              <label htmlFor={inputId} className="sr-only">
                {s.inputLabel(slot.product_name, slot.unit_index)}
              </label>
              <input
                id={inputId}
                ref={inputRef}
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={onKey}
                onFocus={() => primeScannerAudio()}
                placeholder={s.inputPlaceholder}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                enterKeyHint="done"
                maxLength={120}
                dir={draft ? 'ltr' : undefined}
                aria-invalid={refusal ? true : undefined}
                aria-describedby={refusal ? errId : undefined}
                // READ-ONLY while the server checks, never disabled: a disabled
                // field drops the keyboard focus, and the reader's next unit (or
                // the re-scan after a refusal) would type into the page.
                readOnly={busy}
                aria-busy={busy || undefined}
                className={`min-w-0 flex-1 bg-transparent font-mono text-[14px] text-text-primary placeholder:font-sans placeholder:text-[12.5px] placeholder:text-text-secondary/80 outline-none ${busy ? 'opacity-60' : ''}`}
                data-serial-input
              />
              {busy ? (
                <span className="inline-flex h-9 items-center gap-1.5 px-3 text-[12.5px] font-semibold text-text-secondary" role="status">
                  <Spinner size="sm" delayMs={0} decorative />
                  {/* Narrow phones show the spinner only; a screen reader still hears it (UX #10). */}
                  <span className="sr-only min-[400px]:hidden">{s.linking}</span>
                  <span className="hidden min-[400px]:inline">{s.linking}</span>
                </span>
              ) : draft.trim() ? (
                <button
                  type="submit"
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-gold px-3.5 text-[13px] font-bold text-accent-contrast transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                  data-serial-link
                >
                  <Link2 className="h-4 w-4" aria-hidden />
                  {s.link}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onCamera}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-text-primary px-3.5 text-[13px] font-semibold text-surface transition-[opacity,transform] duration-100 hover:opacity-90 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                  aria-label={s.openCamera(slot.product_name, slot.unit_index)}
                  data-serial-camera
                >
                  <Camera className="h-4 w-4" aria-hidden />
                  {/* A phone keeps room for the reader's field; the full words from 420 px up. */}
                  <span className="min-[420px]:hidden">{s.scanShort}</span>
                  <span className="hidden min-[420px]:inline">{s.scanSerial}</span>
                </button>
              )}
            </div>
          </form>
        ) : (
          <p className="min-w-0 flex-1 text-[13px] text-text-secondary">
            <span aria-hidden>—</span>
            <span className="sr-only">{s.notLinked}</span>
          </p>
        )}
      </div>

      {!a && slot.previous && (
        <div className="mt-2 flex items-start gap-2 sm:ps-[5.75rem] text-[12px] text-text-secondary" data-serial-previous>
          <History className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {/* The icon keeps its line; the sentence and «أعد ربطه» wrap beside it. */}
          <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="min-w-0 break-words">
              {slot.previous.free ? s.previous(slot.previous.serial_display) : s.previousTaken(slot.previous.serial_display)}
            </span>
            {slot.previous.free && (slot.previous.assignment_id || slot.previous.serial_full) && canCapture && (
              <button
                type="button"
                onClick={onRelink}
                disabled={busy}
                className={`inline-flex items-center gap-1 min-h-[36px] px-2.5 rounded-full border border-border-subtle text-[12px] font-semibold text-text-primary hover:bg-surface-selected disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${HIT_44}`}
                data-serial-relink
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {s.relink}
              </button>
            )}
          </div>
        </div>
      )}

      {refusal && error && (
        <div id={errId} role="alert" className="mt-2 sm:ps-[5.75rem] text-[12.5px]" data-serial-error={error.error instanceof ApiError ? error.error.code ?? '' : ''}>
          <p className="flex items-start gap-1.5 font-semibold text-danger">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{refusal.text}</span>
          </p>
          {refusal.detail && <p className="mt-0.5 ps-5 text-text-secondary">{refusal.detail}</p>}
          {overrideKind && (
            <button
              type="button"
              onClick={() => onOverride(error)}
              className={`mt-1.5 ms-5 inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-full border border-border-subtle text-[12px] font-semibold text-text-primary hover:bg-surface-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${HIT_44}`}
              data-serial-owner-override={overrideKind}
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              {s.ownerOverride}
            </button>
          )}
        </div>
      )}

      {slot.flags.length > 0 && (
        <ul className="mt-2 space-y-0.5 sm:ps-[5.75rem]" data-serial-flags>
          {slot.flags.map((f) => (
            <li key={f} className="text-[11.5px] text-warning">
              {s.flags[f] ?? f}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A compact control that still takes a 44 px tap (apple-design §6, UX #17):
 * an invisible band above and below, the pill itself unchanged.
 */
export const HIT_44 = "relative before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

/** A serial as text; a masked one is read as its last digits, not «star star star star». */
function SerialText({ value, s }: { value: string; s: SerialStrings }) {
  const masked = /^\*+(.{1,4})$/.exec(value);
  if (!masked) return <span dir="ltr">{value}</span>;
  return (
    <>
      <span dir="ltr" aria-hidden>
        {value}
      </span>
      <span className="sr-only">{s.endingIn(masked[1])}</span>
    </>
  );
}

function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'ok' | 'warn' }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${
        tone === 'ok' ? 'bg-success/10 text-success' : tone === 'warn' ? 'bg-warning/10 text-warning' : 'bg-surface-selected text-text-secondary'
      }`}
    >
      {children}
    </span>
  );
}
