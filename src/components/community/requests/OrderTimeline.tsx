/**
 * THE ORDER'S TIMELINE, ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.5,
 * Client 5d) — the merged record GET /api/marketplace/orders/:id/timeline
 * tells each party (worker/routes/communityOrderTimeline.ts), drawn as one
 * vertical spine: a dot per event, the actor AS A ROLE («أنت», «الورشة»,
 * «الزبون», «إدارة Levonis»), the relative time, the words, a photo as a
 * thumbnail through the authorised file route (a URL on this Worker — the
 * timeline never carries a key, and this component never asks for one),
 * and the «جاهز» mark on the moment the work was ready.
 *
 * Under the spine, what THIS side may do next — decided by the server:
 *   the workshop (`can.update`) writes progress / a note / a photo (purpose
 *   `order_update` through the shared UploadTile, the key handed straight
 *   back to POST /updates and nowhere else) and «جاهز» (`can.ready`, asked
 *   first: it moves neither money nor state);
 *   the customer (`can.modification_request`) asks for a change — before
 *   delivery only; after «سُلِّم» their row offers confirm or dispute;
 *   both sides cancel or dispute exactly when GET /orders/:id says they may
 *   (`cancellationPolicy`, `orderIsActive`) — asked first, never a native dialog.
 *
 * While the order is still moving the timeline re-reads itself on return and
 * every 30 s in view (useFreshOnReturn); a finished order reads once.
 *
 * Mounted lazily: by the merchant's CustomOrderScreen (which already holds the
 * order's policy and passes it down) and by the customer's MyCommunityOrders
 * sheet (src/pages/Requests.tsx), whose row keeps its own confirm / cancel /
 * dispute buttons.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import * as Motion from 'motion/react-m';
import { Camera, Check } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { communityOrdersApi } from '../../../lib/merchant';
import { Money } from '../../ui/Money';
import { useMotion } from '../../../lib/motion';
import { MotionFeatures } from '../../../lib/motionFeatures';
import { useFreshOnReturn } from '../../../lib/useFreshOnReturn';
import { refusalText } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { Segmented } from '../../ui/Segmented';
import { Textarea } from '../../ui/Field';
import { ErrorState } from '../../ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { UploadTile } from '../../upload/UploadTile';
import { formatDateTime } from '../../orders/format';
import { timeAgo } from '../hub/copy';
import { discussionApi, type OrderTimeline as OrderTimelineData, type OrderTimelineEvent, type PostOrderUpdateBody, type TimelineActor } from './api';
import { timelineLang, useTimelineStrings, type TimelineLang, type TimelineStrings } from './timelineStrings';

type Role = 'customer' | 'merchant';

/** What GET /orders/:id says THIS side may do to the order — the policy is the server's. */
export interface OrderPolicy {
  cancel: boolean;
  dispute: boolean;
}

/** The most an update's text carries (worker/routes/communityOrderTimeline.ts ORDER_UPDATE_MAX). */
export const ORDER_UPDATE_MAX = 1000;
/** A dispute's description, as POST /orders/:id/dispute wants it. */
export const DISPUTE_MIN = 10;
/** Nothing more will happen: read once, never poll. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'refunded']);
/** The states a change may still be asked in — the server's BEFORE_DELIVERY, mirrored so a stale hint never draws the form. */
export const BEFORE_DELIVERY: ReadonlySet<string> = new Set(['funded', 'in_progress']);

/** The kinds the spine knows a sentence for — anything else reads «حدث على الطلب». */
export const TIMELINE_KINDS = [
  'created', 'funded', 'started', 'progress', 'photo', 'ready', 'note', 'modification_request',
  'delivered', 'confirmed', 'released', 'refunded', 'dispute', 'dispute_resolved', 'cancelled', 'completed',
] as const;

export function eventSentence(kind: string, s: TimelineStrings): string {
  const words = s.event as Record<string, string>;
  return words[kind] ?? s.event.other;
}

/** «أنت» for the reader's own side; the role word for everyone else. */
export function actorWord(actor: TimelineActor, role: Role, s: TimelineStrings): string {
  if (actor === role) return s.you;
  const words = s.actor as Record<string, string>;
  return words[actor] ?? s.actor.system;
}

/** «اطلب تعديلًا» is the customer's, and only while the work is still in the workshop's hands. */
export function canAskChange(t: Pick<OrderTimelineData, 'role' | 'can'> & { order: Pick<OrderTimelineData['order'], 'state'> }): boolean {
  return t.role === 'customer' && !!t.can.modification_request && BEFORE_DELIVERY.has(t.order.state);
}

/** The dot's colour: the outcome first, then who acted. Tokens only. */
export function dotTone(e: Pick<OrderTimelineEvent, 'kind' | 'actor'>): string {
  if (e.kind === 'ready' || e.kind === 'completed' || e.kind === 'confirmed' || e.kind === 'released') return 'bg-success';
  if (e.kind === 'dispute' || e.kind === 'cancelled' || e.kind === 'refunded') return 'bg-danger';
  if (e.kind === 'modification_request') return 'bg-warning';
  if (e.actor === 'merchant') return 'bg-gold';
  if (e.actor === 'customer') return 'bg-text-secondary';
  return 'bg-text-muted';
}

/** A refusal in the reader's words: the code's sentence, else ours — never the server's English prose. */
function refused(e: unknown, lang: TimelineLang, fallback: string): string {
  const code = e && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
  return refusalText(code, lang, fallback);
}

// ------------------------------------------------------------------ spine

export function TimelineSpine({ events, role }: { events: OrderTimelineEvent[]; role: Role }) {
  const { lang } = useLanguage();
  const s = useTimelineStrings();
  const m = useMotion();
  const L = timelineLang(lang);
  if (!events.length) return <p className="text-[12.5px] text-text-muted">{s.empty}</p>;
  return (
    <MotionFeatures>
      <ol className="relative ms-1.5 space-y-4 border-s border-border-subtle" data-order-timeline>
        {events.map((e, i) => (
          <Motion.li
            key={`${e.kind}-${e.at}-${e.id ?? i}`}
            initial={{ opacity: 0, y: m.travel(6) }}
            animate={{ opacity: 1, y: 0 }}
            transition={m.spring('ui')}
            className="relative ps-5"
            data-timeline-kind={e.kind}
            data-timeline-actor={e.actor}
          >
            <span aria-hidden="true" className={`absolute top-1.5 h-2.5 w-2.5 rounded-full ${dotTone(e)}`} style={{ insetInlineStart: '-5.5px' }} />
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
              <p className="text-[13px] font-semibold text-text-primary">
                {eventSentence(e.kind, s)}
                {e.kind === 'ready' && (
                  <span data-timeline-ready className="ms-1.5 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-bold text-success">
                    {s.readyMark}
                  </span>
                )}
              </p>
              <time dateTime={e.at} title={formatDateTime(e.at, lang)} className="text-[11px] tabular-nums text-text-muted">
                {timeAgo(e.at, L)}
              </time>
            </div>
            <p className="text-[11.5px] text-text-muted">
              {actorWord(e.actor, role, s)}
              {e.amount_iqd != null && (
                <>
                  {' · '}
                  {s.amount}: <Money iqd={e.amount_iqd} />
                </>
              )}
            </p>
            {e.body && (
              <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-start text-[13px] leading-relaxed text-text-secondary">
                {e.body}
              </p>
            )}
            {e.file?.url && (
              <a
                href={e.file.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={s.openPhoto}
                data-timeline-photo-link
                className="mt-2 block w-fit overflow-hidden rounded-xl border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <img src={e.file.url} alt={s.photoAlt} loading="lazy" decoding="async" className="h-24 w-24 object-cover" />
              </a>
            )}
          </Motion.li>
        ))}
      </ol>
    </MotionFeatures>
  );
}

function TimelineSkeleton() {
  return (
    <SkeletonGroup className="space-y-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex items-start gap-3">
          <Skeleton className="mt-1.5 h-2.5 w-2.5 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

// --------------------------------------------------------- the workshop writes

export function MerchantComposer({ orderId, canReady, onPosted }: { orderId: string; canReady: boolean; onPosted: () => void }) {
  const { lang } = useLanguage();
  const s = useTimelineStrings();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [kind, setKind] = useState<'progress' | 'note'>('progress');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<File | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const textBox = useRef<HTMLTextAreaElement | null>(null);
  const L = timelineLang(lang);

  const post = async (body: PostOrderUpdateBody) => {
    setBusy(true);
    setError('');
    try {
      await discussionApi.postOrderUpdate(orderId, body);
      setText('');
      toast.success(s.composer.sent);
      onPosted();
      // The send disabled itself and «جاهز» leaves once used: focus returns to the writing, not to <body>.
      requestAnimationFrame(() => textBox.current?.focus());
    } catch (e) {
      setError(refused(e, L, s.composer.failed));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || body.length > ORDER_UPDATE_MAX || busy) return;
    void post({ kind, body });
  };

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) setPending(f);
    if (input.current) input.current.value = '';
  };

  const markReady = async () => {
    // Earlier «sent» toasts would sit on the dialog's buttons: a decision clears them.
    toast.dismiss();
    const ok = await confirm({
      title: s.composer.readyTitle,
      consequence: s.composer.readyConsequence,
      confirmLabel: s.composer.readyConfirm,
      cancelLabel: s.composer.notNow,
    });
    if (!ok) return;
    await post({ kind: 'ready' });
  };

  return (
    <form onSubmit={submit} aria-label={s.composer.title} className="rounded-2xl border border-border-subtle bg-surface p-3" data-timeline-composer>
      <p className="mb-2 text-[12.5px] font-semibold text-text-secondary">{s.composer.title}</p>
      <Segmented
        size="sm"
        group={`order-update-kind-${orderId}`}
        label={s.composer.kindLabel}
        value={kind}
        onChange={(id) => setKind(id === 'note' ? 'note' : 'progress')}
        items={[
          { id: 'progress', label: s.composer.kindProgress },
          { id: 'note', label: s.composer.kindNote },
        ]}
        dataAttr="data-update-kind"
      />
      <Textarea
        ref={textBox}
        className="mt-2"
        rows={3}
        maxLength={ORDER_UPDATE_MAX}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={s.composer.placeholder}
        aria-label={s.composer.placeholder}
        dir="auto"
        data-timeline-text
      />
      {pending && (
        <div className="mt-2">
          <UploadTile
            file={pending}
            purpose="order_update"
            entityId={orderId}
            onDone={(r) => {
              setPending(null);
              // The completed session hands the key back (KEY_PURPOSES); it goes straight to the update and nowhere else.
              if (r.key) void post({ kind: 'photo', file_key: r.key, ...(text.trim() ? { body: text.trim() } : {}) });
            }}
            onCancel={() => setPending(null)}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="lv-field-error mt-2">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!text.trim()} data-timeline-send>
          {s.composer.send}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Camera aria-hidden="true" className="h-4 w-4" />}
          onClick={() => input.current?.click()}
          disabled={busy || !!pending}
          data-timeline-photo
        >
          {s.composer.photo}
        </Button>
        {canReady && (
          <Button
            type="button"
            variant="accent"
            size="sm"
            icon={<Check aria-hidden="true" className="h-4 w-4" />}
            onClick={markReady}
            disabled={busy}
            data-timeline-ready-button
          >
            {s.composer.ready}
          </Button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files)} data-timeline-photo-input />
      {confirmDialog}
    </form>
  );
}

// --------------------------------------------------------- the customer asks

export function ChangeRequest({ orderId, onPosted }: { orderId: string; onPosted: () => void }) {
  const { lang } = useLanguage();
  const s = useTimelineStrings();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const L = timelineLang(lang);
  const box = useRef<HTMLDivElement | null>(null);
  // Closing the form (sent, or «رجوع») hands focus back to «اطلب تعديلًا» — not to <body>.
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[data-timeline-ask-change]')?.focus());
  };

  if (!open) {
    return (
      <div ref={box} className="contents">
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} data-timeline-ask-change>
          {s.change.ask}
        </Button>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || body.length > ORDER_UPDATE_MAX || busy) return;
    setBusy(true);
    setError('');
    try {
      await discussionApi.postOrderUpdate(orderId, { kind: 'modification_request', body });
      setText('');
      close();
      toast.success(s.change.sent);
      onPosted();
    } catch (err) {
      setError(refused(err, L, s.composer.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={box} className="contents">
    <form onSubmit={submit} className="rounded-2xl border border-border-subtle bg-surface p-3" data-timeline-change-form>
      <p className="text-[12px] leading-relaxed text-text-secondary">{s.change.hint}</p>
      <Textarea
        className="mt-2"
        rows={3}
        maxLength={ORDER_UPDATE_MAX}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={s.change.placeholder}
        aria-label={s.change.ask}
        dir="auto"
        autoFocus
      />
      {error && (
        <p role="alert" className="lv-field-error mt-2">
          {error}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!text.trim()} data-timeline-change-send>
          {s.change.send}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          {s.actions.back}
        </Button>
      </div>
    </form>
    </div>
  );
}

// --------------------------------------------------- cancel and dispute, both sides

export function OrderActions({
  orderId,
  role,
  can,
  onDone,
}: {
  orderId: string;
  role: Role;
  /** What GET /orders/:id said THIS side may do — the policy is the server's. */
  can: OrderPolicy;
  onDone: () => void;
}) {
  const { lang } = useLanguage();
  const s = useTimelineStrings();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [disputing, setDisputing] = useState(false);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const L = timelineLang(lang);
  if (!can.cancel && !can.dispute) return null;

  const cancel = async () => {
    const ok = await confirm({
      title: s.actions.cancelTitle,
      consequence: role === 'merchant' ? s.actions.cancelMerchant : s.actions.cancelCustomer,
      confirmLabel: s.actions.cancel,
      cancelLabel: s.actions.keep,
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await communityOrdersApi.cancel(orderId);
      onDone();
    } catch (e) {
      toast.error(refused(e, L, s.actions.failed));
    } finally {
      setBusy(false);
    }
  };

  const dispute = async (e: FormEvent) => {
    e.preventDefault();
    const text = why.trim();
    if (text.length < DISPUTE_MIN || busy) return;
    setBusy(true);
    setError('');
    try {
      await communityOrdersApi.dispute(orderId, text);
      setDisputing(false);
      setWhy('');
      onDone();
    } catch (err) {
      setError(refused(err, L, s.actions.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-timeline-actions>
      {!disputing && (
        <div className="flex flex-wrap gap-2">
          {can.cancel && (
            <Button type="button" variant="danger" size="sm" onClick={cancel} disabled={busy} data-timeline-cancel>
              {s.actions.cancel}
            </Button>
          )}
          {can.dispute && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setDisputing(true)} disabled={busy} data-timeline-dispute>
              {s.actions.dispute}
            </Button>
          )}
        </div>
      )}
      {disputing && (
        <form onSubmit={dispute} className="rounded-2xl border border-border-subtle bg-warning/10 p-3" data-timeline-dispute-form>
          <label htmlFor={`dispute-${orderId}`} className="block text-[12.5px] leading-relaxed text-text-secondary">
            {s.actions.disputeHint}
          </label>
          <Textarea id={`dispute-${orderId}`} className="mt-2" rows={4} maxLength={4000} value={why} onChange={(e) => setWhy(e.target.value)} dir="auto" autoFocus />
          {/* The count is for the eye; a screen reader hears only the moment it is enough
              (review 2026-09-30: a live counter read «3 / 10+» on every keystroke). */}
          <p className="mt-1 text-[11px] tabular-nums text-text-muted" dir="ltr">
            {why.trim().length} / {DISPUTE_MIN}+
          </p>
          <p className="sr-only" aria-live="polite" data-dispute-ready>
            {why.trim().length >= DISPUTE_MIN ? s.actions.disputeReady : ''}
          </p>
          {error && (
            <p role="alert" className="lv-field-error">
              {error}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button type="submit" variant="danger" size="sm" loading={busy} disabled={why.trim().length < DISPUTE_MIN} data-timeline-dispute-send>
              {s.actions.disputeSend}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDisputing(false)}>
              {s.actions.back}
            </Button>
          </div>
        </form>
      )}
      {confirmDialog}
    </div>
  );
}

// ------------------------------------------------------------------ the whole

/** The body, once read: the spine, then this side's next moves. Exported for the render tests. */
export function TimelineBody({
  data,
  policy,
  onChanged,
}: {
  data: OrderTimelineData;
  /** Cancel / dispute per the server's policy; null draws neither. */
  policy: OrderPolicy | null;
  onChanged: () => void;
}) {
  const s = useTimelineStrings();
  const merchant = data.role === 'merchant';
  return (
    <section
      aria-label={s.title}
      className="space-y-3"
      data-order-timeline-root={data.order.id}
      data-order-state={data.order.state}
      data-order-ready={data.order.ready_at ? 'true' : undefined}
    >
      {data.older_updates && (
        <p className="text-[12px] text-text-muted" data-timeline-older>
          {s.older}
        </p>
      )}
      <TimelineSpine events={data.timeline} role={data.role} />
      {merchant && data.can.update && <MerchantComposer orderId={data.order.id} canReady={!!data.can.ready} onPosted={onChanged} />}
      {!merchant && canAskChange(data) && <ChangeRequest orderId={data.order.id} onPosted={onChanged} />}
      {policy && <OrderActions orderId={data.order.id} role={data.role} can={policy} onDone={onChanged} />}
    </section>
  );
}

export default function OrderTimeline({
  orderId,
  actions = true,
  onChanged,
  refreshKey = 0,
}: {
  orderId: string;
  /**
   * Cancel / dispute under the timeline: `true` asks GET /orders/:id for the
   * policy, an object IS the policy the caller already read (the merchant's
   * screen), `false` draws neither (the customer's row keeps its own buttons).
   */
  actions?: boolean | OrderPolicy;
  /** Something moved: the parent re-reads its list. */
  onChanged?: () => void;
  /** Bumped by the parent after a move of its own («ابدأ العمل», «سلّمت العمل»): read the record again. */
  refreshKey?: number;
}) {
  const [data, setData] = useState<OrderTimelineData | null>(null);
  const [fetched, setFetched] = useState<OrderPolicy | null>(null);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const askPolicy = actions === true;
  const load = useCallback(async () => {
    try {
      const [t, o] = await Promise.all([
        discussionApi.orderTimeline(orderId),
        askPolicy ? communityOrdersApi.get(orderId).catch(() => null) : Promise.resolve(null),
      ]);
      if (!alive.current) return;
      setData(t);
      setError(null);
      if (o) setFetched({ cancel: !!o.can.cancel, dispute: !!o.can.dispute });
    } catch (e) {
      if (alive.current) setError(e);
    }
  }, [orderId, askPolicy]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Still moving: fresh on return, and every half minute while in view.
  const settled = !data || TERMINAL_STATES.has(data.order.state);
  useFreshOnReturn(load, { pollWhileVisibleMs: 30_000, enabled: !settled });

  const changed = () => {
    void load();
    onChanged?.();
  };

  if (error && !data) return <ErrorState compact error={error} onRetry={() => void load()} />;
  if (!data) return <TimelineSkeleton />;
  const policy = actions === false ? null : actions === true ? fetched : actions;
  return <TimelineBody data={data} policy={policy} onChanged={changed} />;
}
