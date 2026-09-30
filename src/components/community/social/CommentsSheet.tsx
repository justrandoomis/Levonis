/**
 * THE COMMENTS ON A POST — a sheet, oldest first, one level of replies, the
 * composer stuck to its footer where the thumb is.
 *
 * A LAZY CHUNK: ActionRow imports it the first time someone opens it.
 *
 * WHAT THE SERVER DECIDES (worker/routes/communitySocial.ts): who may write
 * (not a blocked pair, not on a draft), the 10-second cooldown per post, the
 * decency filter, and who may remove — the comment's author, or the post's
 * author under their own post. A removed comment comes back as a stub with
 * an empty body so its replies keep their place; this sheet draws the stub
 * as «حُذف التعليق».
 *
 * A send is OPTIMISTIC with a `client_id`: the row appears at once, and a
 * retry of the same send is the same comment on the server. A refusal takes
 * the row back and says why in the composer.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownLeft, Flag, MessageCircle, Send, Trash2, X } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { useSignInPrompt } from '../../../lib/guest';
import { apiRefusal } from '../../../lib/refusalStrings';
import LoadMore from '../../listing/LoadMore';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/ConfirmDialog';
import { Textarea } from '../../ui/Field';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/Toast';
import { timeAgo } from '../hub/copy';
import { clientId, creatorHref, socialApi, type Comment } from './api';
import ReportSheet from './ReportSheet';
import { commentsLabel, replyToLabel, socialLang, useSocialStrings } from './strings';
import { LinkRow } from '../links/LinkCard';
import { warmLinksOnPaste } from '../links/useLinkCard';

export interface CommentsSheetProps {
  postId: string;
  open: boolean;
  onClose: () => void;
  /** The total the server knows, after every add and remove. */
  onCountChange?: (n: number) => void;
}

const MAX = 2000;

export default function CommentsSheet({ postId, open, onClose, onCountChange }: CommentsSheetProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const l = socialLang(lang);
  const { user, isAuthenticated } = useAuth();
  const { to: signInTo } = useSignInPrompt();
  const [confirm, confirmDialog] = useConfirm();
  const [rows, setRows] = useState<Comment[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const loadedFor = useRef<string | null>(null);
  // The parent's callback is read through a ref, so a parent that hands a
  // new arrow on every render (ActionRow does) never re-runs the load effect.
  // Re-running it aborted the request in flight and then found `loadedFor`
  // already set, so nothing was loaded again and the sheet stayed on its
  // skeleton — deterministically under <StrictMode>'s mount/cleanup/mount.
  const onCountChangeRef = useRef(onCountChange);
  useEffect(() => {
    onCountChangeRef.current = onCountChange;
  });

  const announce = useCallback((n: number) => {
    setTotal(n);
    onCountChangeRef.current?.(n);
  }, []);

  // The first opening loads; a later one keeps what it has (a retry reloads).
  // Keyed on (open, postId, nonce) ONLY. A cleanup that cancels a load also
  // forgets it was made, so the run after it (StrictMode, a re-render between
  // open and answer) loads again instead of returning to nothing.
  useEffect(() => {
    if (!open) return;
    if (loadedFor.current === postId && nonce === 0) return;
    loadedFor.current = postId;
    let alive = true;
    setError(null);
    setRows(null);
    socialApi
      .comments(postId)
      .then((p) => {
        if (!alive) return;
        setRows(p.comments);
        setNext(p.next);
        announce(p.total);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
      if (loadedFor.current === postId) loadedFor.current = null;
    };
  }, [open, postId, nonce, announce]);

  const loadMore = () => {
    if (!next || more === 'loading') return;
    setMore('loading');
    socialApi
      .comments(postId, next)
      .then((p) => {
        setRows((r) => {
          const seen = new Set((r ?? []).map((c) => c.id));
          return [...(r ?? []), ...p.comments.filter((c) => !seen.has(c.id))];
        });
        setNext(p.next);
        announce(p.total);
        setMore('idle');
      })
      .catch(() => setMore('error'));
  };

  const send = async () => {
    const body = draft.trim();
    if (!user || body.length < 2 || body.length > MAX) return;
    const id = clientId();
    const parent = replyTo ? replyTo.parent_id ?? replyTo.id : null;
    const pending: Comment = {
      id,
      post_id: postId,
      parent_id: parent,
      body,
      state: 'visible',
      created_at: new Date().toISOString(),
      author: { id: user.id, username: user.username ?? null, name: user.name ?? '', avatarUrl: null },
      viewer: { mine: true, can_remove: true },
      pending: true,
    };
    setSendError(null);
    setRows((r) => [...(r ?? []), pending]);
    setDraft('');
    setReplyTo(null);
    try {
      const r = await socialApi.addComment(postId, { body, parent_id: parent, client_id: id });
      setRows((rows) => (rows ?? []).map((c) => (c.id === id ? r.comment : c)));
      if (!r.replayed) announce(total + 1);
    } catch (e) {
      setRows((rows) => (rows ?? []).filter((c) => c.id !== id));
      setDraft(body);
      const code = e instanceof ApiError ? e.code : '';
      const fallback = e instanceof ApiError && e.status === 429 ? s.tooFast : s.actionFailed;
      setSendError(code === 'COMMENT_TOO_FAST' ? s.tooFast : apiRefusal(e, l, fallback));
    }
  };

  const remove = async (c: Comment) => {
    if (!(await confirm({ title: s.removeQ, consequence: s.removeConsequence, confirmLabel: s.remove, destructive: true }))) return;
    try {
      await socialApi.removeComment(c.id);
      setRows((rows) => (rows ?? []).map((x) => (x.id === c.id ? { ...x, state: 'removed', body: '' } : x)));
      announce(Math.max(0, total - 1));
    } catch (e) {
      toast.error(apiRefusal(e, l, s.actionFailed));
    }
  };

  const startReply = (c: Comment) => {
    setReplyTo(c);
    inputRef.current?.focus();
  };

  // One level: a reply to a reply hangs under the same parent.
  const threads = useMemo(() => {
    const list = rows ?? [];
    const byParent = new Map<string, Comment[]>();
    const top: Comment[] = [];
    for (const c of list) {
      if (c.parent_id && list.some((p) => p.id === c.parent_id)) {
        const arr = byParent.get(c.parent_id) ?? [];
        arr.push(c);
        byParent.set(c.parent_id, arr);
      } else top.push(c);
    }
    return top.map((c) => ({ comment: c, replies: byParent.get(c.id) ?? [] }));
  }, [rows]);

  const title = total > 0 ? commentsLabel(total, l) : s.comments;
  const canSend = draft.trim().length >= 2 && draft.length <= MAX;

  const composer = isAuthenticated ? (
    <div className="flex flex-col gap-2" data-comments-composer>
      {replyTo && (
        <p className="flex items-center gap-2 text-[12.5px] text-text-muted">
          <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 rtl:-scale-x-100" />
          <span className="min-w-0 flex-1 truncate">
            {replyToLabel(s, '')}
            <bdi>{replyTo.author.name}</bdi>
          </span>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            aria-label={s.cancel}
            className="flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </p>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={inputRef}
          value={draft}
          rows={1}
          maxLength={MAX}
          placeholder={replyTo ? replyToLabel(s, replyTo.author.name) : s.writeComment}
          aria-label={s.writeComment}
          aria-invalid={sendError ? true : undefined}
          onPaste={warmLinksOnPaste}
          onChange={(e) => {
            setDraft(e.target.value);
            if (sendError) setSendError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
              e.preventDefault();
              void send();
            }
          }}
          dir="auto"
          className="max-h-32 min-h-11 flex-1"
        />
        <Button variant="primary" onClick={send} disabled={!canSend} aria-label={s.send} loadingLabel={s.sending} className="shrink-0" data-comments-send>
          <Send aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />
        </Button>
      </div>
      {sendError && (
        <p role="alert" className="lv-field-error">
          {sendError}
        </p>
      )}
    </div>
  ) : (
    <p className="lv-alert lv-alert-info flex items-center justify-between gap-3 text-[13px]" data-comments-signin>
      <span>{s.signInToComment}</span>
      <Link to={signInTo.pathname} state={signInTo.state} className="lv-button lv-button-secondary lv-button-sm shrink-0">
        {s.signIn}
      </Link>
    </p>
  );

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        label={s.comments}
        detents={['medium', 'large']}
        dragHandle
        dirty={draft.trim().length > 0}
        testId="comments-sheet"
        header={
          <h2 className="px-4 pb-2 pt-1 text-[16px] font-bold text-text-primary" data-comments-title>
            {title}
          </h2>
        }
        footer={composer}
      >
        <div className="px-4 pb-3" data-comments-list>
          {error ? (
            <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} compact />
          ) : !rows ? (
            <CommentsSkeleton />
          ) : rows.length === 0 ? (
            <EmptyState compact icon={<MessageCircle aria-hidden="true" className="h-6 w-6" />} title={s.emptyComments} description={isAuthenticated ? s.emptyCommentsHint : undefined} />
          ) : (
            <ol className="flex flex-col divide-y divide-border-subtle/60">
              {threads.map(({ comment, replies }) => (
                <li key={comment.id} className="py-3">
                  <Row c={comment} onReply={startReply} onRemove={remove} onReport={(id) => setReporting(id)} />
                  {replies.length > 0 && (
                    <ol className="ms-6 mt-2 flex flex-col gap-3 border-s border-border-subtle/60 ps-3">
                      {replies.map((r) => (
                        <li key={r.id}>
                          <Row c={r} onReply={startReply} onRemove={remove} onReport={(id) => setReporting(id)} />
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          )}
          {rows && next && <LoadMore remaining={total > rows.length ? total - rows.length : null} state={more} onMore={loadMore} />}
        </div>
      </Sheet>
      {reporting && <ReportSheet open onClose={() => setReporting(null)} target={{ type: 'comment', id: reporting }} />}
      {confirmDialog}
    </>
  );
}

// ------------------------------------------------------------------- pieces

function Row({ c, onReply, onRemove, onReport }: { c: Comment; onReply: (c: Comment) => void; onRemove: (c: Comment) => void; onReport: (id: string) => void }) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const { isAuthenticated } = useAuth();
  const l = socialLang(lang);
  if (c.state === 'removed') {
    return (
      <p className="py-1 text-[13px] italic text-text-muted" data-comment={c.id} data-comment-removed>
        {s.removed}
      </p>
    );
  }
  const href = c.author.username ? creatorHref(c.author.username) : null;
  const items: MenuEntry[] = [
    ...(c.viewer.can_remove ? [{ id: 'remove', label: s.remove, icon: <Trash2 className="h-4 w-4" />, destructive: true, onSelect: () => void onRemove(c) }] : []),
    ...(!c.viewer.mine && isAuthenticated ? [{ id: 'report', label: s.report, icon: <Flag className="h-4 w-4" />, onSelect: () => onReport(c.id) }] : []),
  ];
  return (
    <article data-comment={c.id} className={`flex items-start gap-2.5 ${c.pending ? 'opacity-60' : ''}`} aria-busy={c.pending || undefined}>
      <span aria-hidden="true" className="mt-0.5 size-8 shrink-0 overflow-hidden rounded-full bg-surface-selected">
        {c.author.avatarUrl && <img src={c.author.avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-[12.5px]">
          {href ? (
            <Link to={href} className="lv-hit relative min-w-0 truncate rounded font-semibold text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <bdi>{c.author.name}</bdi>
            </Link>
          ) : (
            <bdi className="min-w-0 truncate font-semibold text-text-primary">{c.author.name}</bdi>
          )}
          <time dateTime={c.created_at} className="shrink-0 text-text-muted">
            {timeAgo(c.created_at, l)}
          </time>
        </p>
        <p dir="auto" className="mt-0.5 whitespace-pre-line break-words text-start text-[14px] leading-relaxed text-text-secondary">
          {c.body}
        </p>
        {/* the first link in the comment as a card (§9.4) — only when the
            server already holds it; a reader never makes it fetch. */}
        <LinkRow text={c.body} variant="compact" className="mt-1.5" />
        <div className="-ms-2 mt-0.5 flex items-center gap-1">
          {isAuthenticated && !c.pending && (
            <button
              type="button"
              onClick={() => onReply(c)}
              className="inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-[12.5px] font-semibold text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-comment-reply
            >
              <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 rtl:-scale-x-100" />
              {s.reply}
            </button>
          )}
          {items.length > 0 && !c.pending && (
            <Menu
              label={s.options}
              items={items}
              trigger={(props) => (
                <button
                  type="button"
                  {...props}
                  aria-label={s.options}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  data-comment-menu
                >
                  <span aria-hidden="true" className="text-[16px] leading-none">
                    ⋯
                  </span>
                </button>
              )}
            />
          )}
        </div>
      </div>
    </article>
  );
}

function CommentsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4 py-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <div className="size-8 shrink-0 animate-pulse rounded-full bg-surface-selected motion-reduce:animate-none" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
            <div className="h-3.5 w-4/5 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}
