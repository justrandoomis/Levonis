/**
 * THE «⋯» ON A POST. For everyone: copy the link, report. For a signed-in
 * reader: mute or block the author (a block asks first — it cuts messages
 * and follows both ways). For the author: edit, archive or restore, delete —
 * the caller does those (it owns the post's state); this menu only asks.
 *
 * It is the shared `Menu` (anchored beside a pointer, a sheet under a thumb),
 * so the keyboard model and the 44 px rows come with it.
 */
import { useState } from 'react';
import { Archive, Ban, Flag, Link2, MoreHorizontal, Pencil, RotateCcw, Trash2, VolumeX, Volume2 } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { useSignInPrompt } from '../../../lib/guest';
import { apiRefusal } from '../../../lib/refusalStrings';
import { useConfirm } from '../../ui/ConfirmDialog';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { forgetAfterBlock } from '../hub/feedCache';
import { socialApi, type PostCard } from './api';
import ReportSheet from './ReportSheet';
import { useSocial } from './SocialContext';
import { socialLang, useSocialStrings } from './strings';

export type AuthorAction = 'edit' | 'archive' | 'restore' | 'delete';

export interface PostMenuProps {
  post: PostCard;
  /** The viewer wrote this post: the author's rows replace mute/block. */
  mine: boolean;
  /** Which author rows to offer; defaults to edit, archive and delete when `mine`. */
  can?: Partial<Record<AuthorAction, boolean>>;
  onAuthorAction?: (action: AuthorAction) => void;
  /** The trigger's size; `sm` keeps the 44 px target and draws a 16 px glyph. */
  size?: 'sm' | 'md';
  align?: 'start' | 'end';
  className?: string;
}

export default function PostMenu({ post, mine, can, onAuthorAction, size = 'md', align = 'end', className = '' }: PostMenuProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const social = useSocial();
  const [confirm, confirmDialog] = useConfirm();
  const [reporting, setReporting] = useState(false);
  const l = socialLang(lang);
  const authorId = post.author.id;
  const muted = social.muted.has(authorId);
  const blocked = social.blocked.has(authorId);

  const copyLink = async () => {
    const url = `${window.location.origin}${post.url}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(s.linkCopied);
    } catch {
      toast.error(s.actionFailed);
    }
  };

  const toggleMute = async () => {
    if (!isAuthenticated) return signIn();
    const next = !muted;
    social.setMuted(authorId, next);
    try {
      await (next ? socialApi.mute(authorId) : socialApi.unmute(authorId));
      forgetAfterBlock();
      toast.success(next ? s.mutedToast : s.unmutedToast);
    } catch (e) {
      social.setMuted(authorId, !next);
      toast.error(apiRefusal(e, l, s.actionFailed));
    }
  };

  const toggleBlock = async () => {
    if (!isAuthenticated) return signIn();
    const next = !blocked;
    if (!(await confirm({ title: next ? s.blockQ : s.unblockQ, consequence: next ? s.blockConsequence : undefined, confirmLabel: next ? s.block : s.unblock, destructive: next }))) return;
    social.setBlocked(authorId, next);
    try {
      await (next ? socialApi.block(authorId) : socialApi.unblock(authorId));
      forgetAfterBlock();
      toast.success(next ? s.blockedToast : s.unblockedToast);
    } catch (e) {
      social.setBlocked(authorId, !next);
      toast.error(apiRefusal(e, l, s.actionFailed));
    }
  };

  const allowed: Partial<Record<AuthorAction, boolean>> = can ?? (mine ? { edit: true, archive: post.state === 'published', restore: post.state === 'archived', delete: true } : {});
  const items: MenuEntry[] = [
    { id: 'copy', label: s.copyLink, icon: <Link2 className="h-4 w-4" />, onSelect: () => void copyLink() },
    ...(mine
      ? [
          { id: 'sep-author', separator: true as const },
          ...(allowed.edit ? [{ id: 'edit', label: s.edit, icon: <Pencil className="h-4 w-4" />, onSelect: () => onAuthorAction?.('edit') }] : []),
          ...(allowed.archive ? [{ id: 'archive', label: s.archive, icon: <Archive className="h-4 w-4" />, onSelect: () => onAuthorAction?.('archive') }] : []),
          ...(allowed.restore ? [{ id: 'restore', label: s.restore, icon: <RotateCcw className="h-4 w-4" />, onSelect: () => onAuthorAction?.('restore') }] : []),
          ...(allowed.delete ? [{ id: 'delete', label: s.delete, icon: <Trash2 className="h-4 w-4" />, destructive: true, onSelect: () => onAuthorAction?.('delete') }] : []),
        ]
      : [
          { id: 'report', label: s.reportPost, icon: <Flag className="h-4 w-4" />, onSelect: () => (isAuthenticated ? setReporting(true) : signIn()) },
          { id: 'sep-person', separator: true as const },
          {
            id: 'mute',
            label: muted ? s.unmuteAuthor : s.muteAuthor,
            icon: muted ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />,
            onSelect: () => void toggleMute(),
          },
          { id: 'block', label: blocked ? s.unblock : s.blockAuthor, icon: <Ban className="h-4 w-4" />, destructive: !blocked, onSelect: () => void toggleBlock() },
        ]),
  ];

  return (
    <>
      <Menu
        label={s.options}
        align={align}
        items={items}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            aria-label={s.options}
            data-social="menu"
            className={`press-scale relative z-10 flex size-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
          >
            <MoreHorizontal className={size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden="true" />
          </button>
        )}
      />
      {/* Mounted only once asked: a feed of forty cards must not carry forty idle sheets. */}
      {!mine && reporting && <ReportSheet open onClose={() => setReporting(false)} target={{ type: 'post', id: post.id }} />}
      {confirmDialog}
    </>
  );
}
