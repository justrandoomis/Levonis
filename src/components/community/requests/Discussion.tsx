/**
 * THE DISCUSSION UNDER A REQUEST (docs/COMMUNITY_ECOSYSTEM.md §9.5, Client
 * 5c) — one thread on /requests/:id, read from and written to
 * worker/routes/requestDiscussion.ts.
 *
 * FOUR KINDS, AND THE SERVER DECIDES WHO WRITES WHICH:
 *   «تعليق»        public_comment — anyone signed in while the request is on
 *                  the board; one level of replies;
 *   «سؤال للعميل»  merchant_question — a workshop the live verdict says can
 *                  make the job (the composer offers it when `can.ask`; the
 *                  POST asks the verdict again and answers
 *                  COMMENT_KIND_NOT_ALLOWED with the reason otherwise);
 *   «أجب»          customer_answer — the customer only, naming the question
 *                  (`parent_id`); drawn under it;
 *   system_update  never written here: «عُدّل الطلب — النسخة ٣», «أُغلق الطلب»
 *                  arrive as `{code, meta}` and are worded in the reader's
 *                  language, inline, between the people.
 *
 * THE DECENCY OF THE POST COMMENTS: the same filter on the server
 * (COMMENT_INDECENT), the same 1000-character bound said before the send,
 * blocks answered BLOCKED, and every refusal worded through
 * src/lib/refusalStrings.ts. A pasted link warms its card
 * (`warmLinksOnPaste`) and the first link of a row is drawn as a card
 * (`LinkRow`) — only when the server already holds it.
 *
 * Oldest first, twenty at a time; the list reads one row more than it shows,
 * so «المزيد» exists exactly when more does (D8).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownLeft, Flag, HelpCircle, History, MessageCircle, Send, Trash2, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useAuth } from '../../../AuthContext';
import { ApiError } from '../../../lib/api';
import { useSignInPrompt } from '../../../lib/guest';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Field';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Segmented } from '../../ui/Segmented';
import { Sheet } from '../../ui/Sheet';
import { StatusChip } from '../../ui/Badge';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { LinkRow } from '../links/LinkCard';
import { warmLinksOnPaste } from '../links/useLinkCard';
import { timeAgo } from '../hub/copy';
import { discussionApi, type CommentsPage, type PostCommentBody, type ReportReason, type RequestComment } from './api';
import { fill, requestLang, systemUpdateLabel, useRequestStrings, type RequestStrings } from './strings';

/** The most a comment carries (worker/routes/requestDiscussion.ts COMMENT_MAX). */
export const COMMENT_MAX = 1000;
/** A page of the thread. */
export const COMMENTS_PAGE = 20;
export const REPORT_REASONS: ReportReason[] = ['spam', 'abuse', 'nudity', 'fraud', 'copyright', 'offtopic', 'other'];

/** What the composer is writing: a new row of a kind, a reply under a comment, or an answer under a question. */
export type ComposerTarget =
  | { kind: 'public_comment' | 'merchant_question'; parent: null }
  | { kind: 'public_comment'; parent: RequestComment }
  | { kind: 'customer_answer'; parent: RequestComment };

/**
 * The kinds THIS viewer may start a row with — the server's `can`, read as a
 * hint (the POST decides again). The customer answers from a question's own
 * «أجب», never from the picker.
 */
export function startKinds(can: CommentsPage['can']): Array<'public_comment' | 'merchant_question'> {
  const out: Array<'public_comment' | 'merchant_question'> = [];
  if (can.comment) out.push('public_comment');
  if (can.ask) out.push('merchant_question');
  return out;
}

/** Oldest first, ties by id — the server's order, kept across pages and fresh posts. */
/**
 * Oldest first. Two rows of one instant keep the order they arrived in — the
 * server's, which is the order they were written (rowid), and a new comment
 * after what was already there. The sort is stable, so ties are never
 * re-decided by the rows' random ids (review 2026-09-30: a comment and the
 * system row written beside it swapped places about one read in five).
 */
export function sortThread(rows: RequestComment[]): RequestComment[] {
  return [...rows].sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? -1 : 1));
}

/** One level: a top-level row and what hangs under it (replies, the customer's answers). */
export function threadsOf(rows: RequestComment[]): Array<{ row: RequestComment; replies: RequestComment[] }> {
  const ids = new Set(rows.map((r) => r.id));
  const under = new Map<string, RequestComment[]>();
  const top: RequestComment[] = [];
  for (const r of rows) {
    if (r.parent_id && ids.has(r.parent_id)) under.set(r.parent_id, [...(under.get(r.parent_id) ?? []), r]);
    else top.push(r);
  }
  return top.map((row) => ({ row, replies: under.get(row.id) ?? [] }));
}

/** A question the customer has not answered yet. */
export function awaitsAnswer(q: RequestComment, replies: RequestComment[]): boolean {
  return q.kind === 'merchant_question' && !replies.some((r) => r.kind === 'customer_answer');
}

/** The role word beside a name — the customer of THIS request, or a workshop; a plain member carries none. */
export function roleWord(role: 'customer' | 'merchant' | 'member' | undefined, s: RequestStrings): string {
  return role === 'customer' ? s.roleCustomer : role === 'merchant' ? s.roleMerchant : '';
}

export default function Discussion({
  requestId,
  open,
  onCount,
  onUnavailable,
  initial = null,
}: {
  requestId: string;
  /** A page already in hand — the first paint; the thread still reads itself fresh. */
  initial?: CommentsPage | null;
  /** The request is on the board (takes comments); a closed one reads, and says it closed. */
  open: boolean;
  /** The visible total, for the page's heading. */
  onCount?: (n: number) => void;
  /** The community is shut (COMMUNITY_CLOSED): the page folds the whole section away. */
  onUnavailable?: () => void;
}) {
  const s = useRequestStrings();
  const { lang } = useLanguage();
  const L = requestLang(lang);
  const { isAuthenticated, isLoaded } = useAuth();
  const { to: signInTo } = useSignInPrompt();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const composerId = useId();
  const [rows, setRows] = useState<RequestComment[] | null>(() => (initial ? sortThread(initial.comments ?? []) : null));
  const [can, setCan] = useState<CommentsPage['can']>(() => initial?.can ?? { comment: false, ask: false, answer: false });
  const [next, setNext] = useState<string | null>(() => initial?.next_cursor ?? null);
  const [total, setTotal] = useState(() => Number(initial?.total ?? 0));
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [nonce, setNonce] = useState(0);
  const [target, setTarget] = useState<ComposerTarget>(() => ({ kind: (initial && startKinds(initial.can)[0]) || 'public_comment', parent: null }));
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState('');
  // Said once a message lands (review 2026-09-30: the send left no toast and no live text).
  const [posted, setPosted] = useState('');
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState<RequestComment | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const onCountRef = useRef(onCount);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onCountRef.current = onCount;
    onUnavailableRef.current = onUnavailable;
  });

  const announce = useCallback((n: number) => {
    setTotal(n);
    onCountRef.current?.(n);
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    discussionApi
      .comments(requestId, { limit: COMMENTS_PAGE })
      .then((p) => {
        if (!alive) return;
        setRows(sortThread(p.comments ?? []));
        setNext(p.next_cursor ?? null);
        setCan(p.can ?? { comment: false, ask: false, answer: false });
        announce(Number(p.total ?? 0));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e);
        if (e instanceof ApiError && e.code === 'COMMUNITY_CLOSED') onUnavailableRef.current?.();
      });
    return () => {
      alive = false;
    };
  }, [requestId, nonce, isAuthenticated, announce]);

  const kinds = startKinds(can);
  // The picker's choice follows what the server allows: a merchant who may
  // only comment is never left on «سؤال».
  useEffect(() => {
    if (target.parent) return;
    if (!kinds.includes(target.kind as 'public_comment' | 'merchant_question') && kinds[0]) setTarget({ kind: kinds[0], parent: null });
  }, [kinds, target]);

  const loadMore = () => {
    if (!next || more === 'loading') return;
    setMore('loading');
    discussionApi
      .comments(requestId, { cursor: next, limit: COMMENTS_PAGE })
      .then((p) => {
        setRows((list) => {
          const seen = new Set((list ?? []).map((r) => r.id));
          return sortThread([...(list ?? []), ...(p.comments ?? []).filter((r) => !seen.has(r.id))]);
        });
        setNext(p.next_cursor ?? null);
        // A later page carries no count (the server counts once, on the first).
        if (typeof p.total === 'number') announce(p.total);
        setMore('idle');
      })
      .catch(() => setMore('error'));
  };

  const body = draft.trim();
  const tooLong = body.length > COMMENT_MAX;
  const canSend = body.length > 0 && !tooLong && !busy;

  const send = async () => {
    if (!canSend) return;
    const payload: PostCommentBody = { kind: target.kind, body, ...(target.parent ? { parent_id: target.parent.id } : {}) };
    setBusy(true);
    setSendError('');
    try {
      const r = await discussionApi.postComment(requestId, payload);
      setRows((list) => sortThread([...(list ?? []).filter((x) => x.id !== r.comment.id), r.comment]));
      if (!r.replayed) announce(total + 1);
      setDraft('');
      setTarget({ kind: kinds[0] ?? 'public_comment', parent: null });
      setPosted(s.commentPosted);
      // Focus stays where the writing is — the send button just disabled itself, and focus fell to <body>.
      requestAnimationFrame(() => input.current?.focus());
    } catch (e) {
      setSendError(e instanceof ApiError && e.code === 'COMMENT_TOO_LONG' ? s.tooLong : apiRefusal(e, L, s.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: RequestComment) => {
    if (!(await confirm({ title: s.removeQ, consequence: s.removeBody, confirmLabel: s.remove, destructive: true }))) return;
    try {
      await discussionApi.removeComment(requestId, c.id);
      // The server omits a removed row; its replies keep their place at the top level.
      setRows((list) => (list ?? []).filter((x) => x.id !== c.id));
      announce(Math.max(0, total - 1));
    } catch (e) {
      toast.error(apiRefusal(e, L, s.actionFailed));
    }
  };

  const aim = (t: ComposerTarget) => {
    setTarget(t);
    setSendError('');
    input.current?.focus();
  };

  const threads = useMemo(() => threadsOf(rows ?? []), [rows]);
  // A closed community (COMMUNITY_CLOSED) says so once, on the page above; the
  // thread keeps quiet rather than stacking a second maintenance card here.
  if (error instanceof ApiError && error.code === 'COMMUNITY_CLOSED') return null;

  const writing = isAuthenticated && (kinds.length > 0 || !!target.parent);
  const placeholder =
    target.kind === 'customer_answer' && target.parent
      ? fill(s.answering, { name: target.parent.author?.name ?? '' })
      : target.kind === 'merchant_question'
        ? s.askCustomer
        : target.parent
          ? fill(s.replyingTo, { name: target.parent.author?.name ?? '' })
          : s.writeComment;

  return (
    <div data-discussion={requestId}>
      {error ? (
        <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} compact />
      ) : rows === null ? (
        <DiscussionSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<MessageCircle aria-hidden="true" className="h-6 w-6" />}
          title={s.noComments}
          description={open ? s.noCommentsHint : undefined}
        />
      ) : (
        <ol className="flex flex-col divide-y divide-border-subtle/60" data-discussion-list>
          {threads.map(({ row, replies }) => (
            <li key={row.id} className="py-3">
              {row.kind === 'system_update' ? (
                <SystemRow c={row} s={s} lang={L} />
              ) : (
                <>
                  <Row
                    c={row}
                    s={s}
                    lang={L}
                    signedIn={isAuthenticated}
                    onReply={can.comment && row.kind === 'public_comment' ? () => aim({ kind: 'public_comment', parent: row }) : undefined}
                    onAnswer={can.answer && awaitsAnswer(row, replies) ? () => aim({ kind: 'customer_answer', parent: row }) : undefined}
                    onRemove={() => void remove(row)}
                    onReport={() => setReporting(row)}
                  />
                  {replies.length > 0 && (
                    <ol className="ms-4 mt-2 flex flex-col gap-3 border-s border-border-subtle/60 ps-3">
                      {replies.map((r) => (
                        <li key={r.id}>
                          <Row c={r} s={s} lang={L} signedIn={isAuthenticated} onRemove={() => void remove(r)} onReport={() => setReporting(r)} />
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      {rows && next && (
        <Button variant="ghost" size="sm" block className="mt-1" onClick={loadMore} loading={more === 'loading'} data-discussion-more>
          {more === 'error' ? s.actionFailed : s.moreComments}
        </Button>
      )}

      {/* THE COMPOSER — what this viewer may write, and nothing they may not. */}
      {writing ? (
        <div className="mt-3 flex flex-col gap-2" data-discussion-composer data-discussion-kind={target.kind}>
          {!target.parent && kinds.length > 1 && (
            <Segmented
              group={`discussion-kind-${requestId}`}
              size="sm"
              label={s.commentKindLabel}
              value={target.kind}
              onChange={(id) => setTarget({ kind: id === 'merchant_question' ? 'merchant_question' : 'public_comment', parent: null })}
              dataAttr="data-discussion-pick"
              items={[
                { id: 'public_comment', label: s.kindComment },
                { id: 'merchant_question', label: s.kindQuestion },
              ]}
            />
          )}
          {target.parent && (
            <p className="flex items-center gap-2 text-[12.5px] text-text-muted" data-discussion-target={target.kind}>
              <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100" />
              <span className="min-w-0 flex-1 truncate">{placeholder}</span>
              <button
                type="button"
                onClick={() => setTarget({ kind: kinds[0] ?? 'public_comment', parent: null })}
                aria-label={s.cancel}
                className="flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </p>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              id={composerId}
              ref={input}
              value={draft}
              rows={2}
              maxLength={COMMENT_MAX + 200}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-invalid={sendError || tooLong ? true : undefined}
              onPaste={warmLinksOnPaste}
              onChange={(e) => {
                setDraft(e.target.value);
                if (sendError) setSendError('');
                if (posted) setPosted('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
                  e.preventDefault();
                  void send();
                }
              }}
              dir="auto"
              className="max-h-40 min-h-11 flex-1"
              data-discussion-input
            />
            <Button variant="primary" onClick={send} disabled={!canSend} loading={busy} aria-label={s.send} className="shrink-0" data-discussion-send>
              <Send aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />
            </Button>
          </div>
          <div className="flex items-start justify-between gap-3">
            <p role="alert" className="lv-field-error min-w-0 flex-1 empty:hidden">
              {sendError || (tooLong ? s.tooLong : '')}
            </p>
            <p className="sr-only" aria-live="polite" data-discussion-posted>
              {posted}
            </p>
            {body.length > COMMENT_MAX * 0.8 && (
              <span className={`shrink-0 text-[11px] tabular-nums ${tooLong ? 'text-danger' : 'text-text-muted'}`} dir="ltr">
                {body.length}/{COMMENT_MAX}
              </span>
            )}
          </div>
        </div>
      ) : isLoaded && !isAuthenticated && open ? (
        <p className="lv-alert lv-alert-info mt-3 flex items-center justify-between gap-3 text-[13px]" data-discussion-signin>
          <span>{s.signInToComment}</span>
          <Link to={signInTo.pathname} state={signInTo.state} className="lv-button lv-button-secondary lv-button-sm shrink-0">
            {s.signIn}
          </Link>
        </p>
      ) : !open && rows && rows.length > 0 ? (
        <p className="mt-3 text-[12.5px] text-text-muted" data-discussion-closed>
          {s.closedForComments}
        </p>
      ) : null}

      <ReportSheet requestId={requestId} comment={reporting} onClose={() => setReporting(null)} />
      {confirmDialog}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function SystemRow({ c, s, lang }: { c: RequestComment; s: RequestStrings; lang: 'ar' | 'en' | 'ckb' }) {
  return (
    <p className="flex items-center gap-2 text-[12.5px] text-text-muted" data-comment={c.id} data-comment-kind="system_update" data-system-code={c.system?.code ?? ''}>
      <History aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{systemUpdateLabel(c.system?.code ?? '', c.system?.meta, s)}</span>
      <time dateTime={c.created_at} className="shrink-0 text-[11.5px]">
        {timeAgo(c.created_at, lang)}
      </time>
    </p>
  );
}

function Row({
  c,
  s,
  lang,
  signedIn,
  onReply,
  onAnswer,
  onRemove,
  onReport,
}: {
  c: RequestComment;
  s: RequestStrings;
  lang: 'ar' | 'en' | 'ckb';
  signedIn: boolean;
  onReply?: () => void;
  onAnswer?: () => void;
  onRemove: () => void;
  onReport: () => void;
}) {
  const name = c.author?.name || c.author?.username || '—';
  const role = roleWord(c.author?.role, s);
  const items: MenuEntry[] = [
    ...(c.viewer.can_remove ? [{ id: 'remove', label: s.remove, icon: <Trash2 className="h-4 w-4" />, destructive: true, onSelect: onRemove }] : []),
    ...(!c.viewer.mine && signedIn ? [{ id: 'report', label: s.report, icon: <Flag className="h-4 w-4" />, onSelect: onReport }] : []),
  ];
  return (
    <article data-comment={c.id} data-comment-kind={c.kind} data-comment-role={c.author?.role ?? ''} className="relative flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-selected text-[12px] font-bold text-text-secondary">
        {name.trim().charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px] ${items.length > 0 ? 'pe-8' : ''}`}>
          <bdi className="min-w-0 truncate font-semibold text-text-primary">{name}</bdi>
          {role && <span className="text-[11.5px] text-text-muted">{role}</span>}
          {c.kind === 'merchant_question' && (
            <StatusChip tone="info" icon={<HelpCircle aria-hidden="true" className="h-3 w-3" />}>
              {s.question}
            </StatusChip>
          )}
          {c.kind === 'customer_answer' && <span className="text-[11.5px] font-semibold text-success">{s.answerLabel}</span>}
          <time dateTime={c.created_at} className="text-[11.5px] text-text-muted">
            {timeAgo(c.created_at, lang)}
          </time>
        </p>
        <p dir="auto" className="mt-0.5 whitespace-pre-line break-words text-start text-[14px] leading-relaxed text-text-secondary">
          {c.body}
        </p>
        {/* The first link as a card (§9.4) — only when the server already holds it. */}
        <LinkRow text={c.body} variant="compact" className="mt-1.5" />
        {(onReply || onAnswer) && (
          <div className="-ms-2 mt-0.5 flex items-center gap-1">
            {onAnswer && (
              <button
                type="button"
                onClick={onAnswer}
                className="inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-[12.5px] font-semibold text-text-primary transition-colors hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                data-comment-answer={c.id}
              >
                <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 rtl:-scale-x-100" />
                {s.answer}
              </button>
            )}
            {onReply && (
              <button
                type="button"
                onClick={onReply}
                className="inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-[12.5px] font-semibold text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                data-comment-reply={c.id}
              >
                <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 rtl:-scale-x-100" />
                {s.reply}
              </button>
            )}
          </div>
        )}
      </div>
      {/* Remove (the author's own) and report (anyone else signed in), drawn
          small at the row's corner — a 44px target all the same (lv-hit). */}
      {items.length > 0 && (
        <Menu
          label={s.options}
          items={items}
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label={s.options}
              className="lv-hit absolute -top-1 end-0 inline-flex size-8 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-comment-menu={c.id}
            >
              <span aria-hidden="true" className="text-[16px] leading-none">
                ⋯
              </span>
            </button>
          )}
        />
      )}
    </article>
  );
}

/** «إبلاغ» — a reason from the closed list, once per reporter per row (a replay is answered as the same report). */
function ReportSheet({ requestId, comment, onClose }: { requestId: string; comment: RequestComment | null; onClose: () => void }) {
  const s = useRequestStrings();
  const { lang } = useLanguage();
  const L = requestLang(lang);
  const toast = useToast();
  const titleId = useId();
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [error, setError] = useState('');
  useEffect(() => {
    setReason('');
    setError('');
  }, [comment]);

  const submit = async () => {
    if (!comment || !reason) return;
    setError('');
    try {
      await discussionApi.reportComment(requestId, comment.id, { reason });
      toast.success(s.reported);
      onClose();
    } catch (e) {
      setError(apiRefusal(e, L, s.actionFailed));
    }
  };

  return (
    <Sheet
      open={!!comment}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-full sm:max-w-md"
      testId="discussion-report"
      header={
        <h2 id={titleId} className="px-5 pb-1 pt-1 text-[16px] font-bold text-text-primary">
          {s.reportTitle}
        </h2>
      }
      footer={
        <div className="space-y-2 px-1">
          {error && (
            <p className="lv-field-error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" block onClick={submit} disabled={!reason} data-report-send>
            {s.reportSend}
          </Button>
        </div>
      }
    >
      <div role="radiogroup" aria-label={s.reportReason} className="flex flex-col gap-2 px-5 pb-3 pt-1">
        {REPORT_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            onClick={() => setReason(r)}
            className="lv-choice flex items-center justify-between gap-3 px-3.5 text-start text-[13.5px]"
            data-report-reason={r}
          >
            <span>{s.reasons[r]}</span>
            <span aria-hidden="true" className="lv-choice-mark text-[11px]">
              ✓
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function DiscussionSkeleton() {
  return (
    <SkeletonGroup className="flex flex-col gap-4 py-2">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex items-start gap-2.5">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}
