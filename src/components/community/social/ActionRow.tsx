/**
 * THE ROW UNDER A POST — like, comment, save, share, «⋯» — used by the
 * project page and by the home feed's post card.
 *
 * Every control is a sibling of the card's stretched link (`relative z-10`),
 * never inside it, and a 44 px round target.
 *
 * `variant="labelled"` is the feed card of IMG_8486 (community UI plan C2.1):
 * four equal cells, each a word with its number and mark («إعجاب 24 ♥»,
 * «تعليقات 6», «حفظ», «مشاركة»), parted by short vertical rules. The «⋯»
 * menu is not in it: the card carries it in its header. The comments sheet is a lazy
 * chunk fetched the first time it is asked for (and warmed on the pointer
 * arriving), so a feed that is only scrolled never downloads it.
 */
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { MessageCircle, Share2 } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { toast } from '../../ui/Toast';
import type { PostCard } from './api';
import LikeButton from './LikeButton';
import PostMenu, { type AuthorAction } from './PostMenu';
import SaveButton from './SaveButton';
import { commentsLabel, socialLang, useSocialStrings } from './strings';

const loadComments = () => import('./CommentsSheet');
const CommentsSheet = React.lazy(loadComments);

export interface ActionRowProps {
  post: PostCard;
  /** The viewer's flags on this post; defaults to `post.viewer`. */
  viewer?: { liked?: boolean; saved?: boolean } | null;
  /** The viewer wrote this post. */
  mine?: boolean;
  can?: Partial<Record<AuthorAction, boolean>>;
  onAuthorAction?: (action: AuthorAction) => void;
  /** The counts moved (a like, a comment); the caller may mirror them. */
  onCounts?: (counts: Partial<PostCard['counts']>) => void;
  /** The viewer's own mark moved (liked, saved); a list that remembers its rows mirrors it. */
  onViewer?: (viewer: { liked?: boolean; saved?: boolean }) => void;
  size?: 'sm' | 'md';
  /** `icons` (default): the round marks and «⋯». `labelled`: the four worded cells of the feed card, no menu. */
  variant?: 'icons' | 'labelled';
  /** Open the comments sheet from outside (a `#comments` link). */
  openComments?: boolean;
  className?: string;
}

export default function ActionRow({ post, viewer, mine = false, can, onAuthorAction, onCounts, onViewer, size = 'md', variant = 'icons', openComments = false, className = '' }: ActionRowProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const l = socialLang(lang);
  const flags = viewer ?? post.viewer ?? {};
  const [commentCount, setCommentCount] = useState(post.counts.comments);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsMounted, setCommentsMounted] = useState(false);

  useEffect(() => setCommentCount(post.counts.comments), [post.counts.comments]);

  const openSheet = useCallback(() => {
    setCommentsMounted(true);
    setCommentsOpen(true);
  }, []);

  useEffect(() => {
    if (openComments) openSheet();
  }, [openComments, openSheet]);

  const share = async () => {
    const url = `${window.location.origin}${post.url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: post.title, url });
        return;
      }
    } catch {
      return; // the sheet was closed — not a reason to copy as well
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success(s.linkCopied);
    } catch {
      toast.error(s.actionFailed);
    }
  };

  const iconSize = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const round = `press-scale relative z-10 inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
    size === 'sm' ? 'text-[12px]' : 'text-[13px]'
  }`;

  const sheet = commentsMounted && (
    <Suspense fallback={null}>
      <CommentsSheet
        postId={post.id}
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        onCountChange={(n) => {
          setCommentCount(n);
          onCounts?.({ comments: n });
        }}
      />
    </Suspense>
  );

  if (variant === 'labelled') {
    // A cell fills its quarter; the rule is drawn at its inline start, short of both edges.
    const cell = 'relative flex min-w-0 justify-center';
    const rule = <span aria-hidden="true" className="absolute inset-y-3 start-0 w-px bg-border-subtle" />;
    // A word too long for its quarter (English, Sorani at 320) puts the
    // number and the mark under it rather than leaving the card.
    const wide = 'max-w-full flex-wrap px-1';
    return (
      <div className={`grid grid-cols-4 items-center ${className}`} data-action-row={post.id} data-action-variant="labelled">
        <div className={cell}>
          <LikeButton
            postId={post.id}
            liked={!!flags.liked}
            count={post.counts.likes}
            text={s.cell.like}
            className={wide}
            onChange={(liked, likes) => {
              onCounts?.({ likes });
              onViewer?.({ liked });
            }}
          />
        </div>
        <div className={cell}>
          {rule}
          <button
            type="button"
            onClick={openSheet}
            onPointerEnter={() => void loadComments()}
            onFocus={() => void loadComments()}
            aria-label={commentCount > 0 ? `${s.cell.comments} — ${commentsLabel(commentCount, l)}` : s.cell.comments}
            aria-expanded={commentsOpen}
            data-social="comments"
            className={`${round} ${wide}`}
          >
            <span>{s.cell.comments}</span>
            <span className="inline-flex items-center gap-1">
              {commentCount > 0 && (
                <span aria-hidden="true" className="font-semibold tabular-nums text-text-primary">
                  {commentCount}
                </span>
              )}
              <MessageCircle aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
            </span>
          </button>
        </div>
        <div className={cell}>
          {rule}
          <SaveButton
            postId={post.id}
            saved={!!flags.saved}
            count={post.counts.saves}
            showCount={mine}
            text={s.cell.save}
            className={wide}
            onChange={(saved, saves) => {
              onCounts?.({ saves });
              onViewer?.({ saved });
            }}
          />
        </div>
        <div className={cell}>
          {rule}
          <button type="button" onClick={() => void share()} aria-label={s.cell.share} data-social="share" className={`${round} ${wide}`}>
            <span>{s.cell.share}</span>
            <Share2 aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
        {sheet}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-0.5 ${className}`} data-action-row={post.id}>
      <LikeButton
        postId={post.id}
        liked={!!flags.liked}
        count={post.counts.likes}
        size={size}
        onChange={(liked, likes) => {
          onCounts?.({ likes });
          onViewer?.({ liked });
        }}
      />
      <button
        type="button"
        onClick={openSheet}
        onPointerEnter={() => void loadComments()}
        onFocus={() => void loadComments()}
        aria-label={commentCount > 0 ? `${s.comments} — ${commentsLabel(commentCount, l)}` : s.comments}
        aria-expanded={commentsOpen}
        data-social="comments"
        className={round}
      >
        <MessageCircle aria-hidden="true" className={iconSize} strokeWidth={1.75} />
        {commentCount > 0 && (
          <span aria-hidden="true" className="min-w-5 text-center font-semibold tabular-nums">
            {commentCount}
          </span>
        )}
      </button>
      <SaveButton
        postId={post.id}
        saved={!!flags.saved}
        count={post.counts.saves}
        size={size}
        showCount={mine}
        onChange={(saved, saves) => {
          onCounts?.({ saves });
          onViewer?.({ saved });
        }}
      />
      <button type="button" onClick={() => void share()} aria-label={s.share} data-social="share" className={round}>
        <Share2 aria-hidden="true" className={iconSize} strokeWidth={1.75} />
      </button>
      <span className="ms-auto">
        <PostMenu post={post} mine={mine} can={can} onAuthorAction={onAuthorAction} size={size} />
      </span>
      {sheet}
    </div>
  );
}
