/**
 * THE ROW UNDER A POST — like, comment, save, share, «⋯» — used by the
 * project page and by the home feed's post card.
 *
 * Every control is a sibling of the card's stretched link (`relative z-10`),
 * never inside it, and a 44 px round target. The comments sheet is a lazy
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
  /** Open the comments sheet from outside (a `#comments` link). */
  openComments?: boolean;
  className?: string;
}

export default function ActionRow({ post, viewer, mine = false, can, onAuthorAction, onCounts, onViewer, size = 'md', openComments = false, className = '' }: ActionRowProps) {
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
      {commentsMounted && (
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
      )}
    </div>
  );
}
