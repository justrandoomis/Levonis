/**
 * A TRENDING PROJECT ON THE HOME (community UI plan C1 R6 and D3 (d);
 * IMG_8487, IMG_8462): a card with the photograph in a tray, the title, the
 * line «material | author» with the author picture, and the actions row:
 * the like (the count beside it), the comments (a link to the project page at
 * its comments, the count beside it) and the save at the end.
 *
 * The title is the one stretched link (its ::after covers the card), so the
 * card is one Tab stop and a long press knows where it goes; the like, the
 * comments and the save are its siblings above it (`relative z-10`), never
 * inside it. Counts are Latin digits in every language, hidden at zero.
 *
 * A landscape photograph: 16:9 on a phone (two across), 3:2 from `lg`
 * (three across).
 */
import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import SafeImage from '../../ui/SafeImage';
import { useLanguage } from '../../../LanguageContext';
import LikeButton from '../social/LikeButton';
import SaveButton from '../social/SaveButton';
import { commentsLabel, socialLang } from '../social/strings';
import { KitAvatar } from '../kit/display';
import type { PostCard } from './api';

/** «PLA Matte | أحمد علي ◯»: the material, a hairline, the person (or the store) with their picture. */
export function ProjectMeta({ material, name, avatar, wide = false, size }: { material: string | null; name: string; avatar?: string | null; wide?: boolean; size?: 24 | 28 | 40 }) {
  return (
    <p className={`flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-text-muted ${wide ? 'text-base' : 'text-[12px]'}`}>
      {material && (
        <span className="inline-flex min-w-0 max-w-full items-center gap-2">
          <bdi className="truncate">{material}</bdi>
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border-subtle" />
        </span>
      )}
      <span className="inline-flex min-w-0 max-w-full items-center gap-2">
        <bdi className="min-w-0 truncate">{name}</bdi>
        <KitAvatar src={avatar} name={name} size={size ?? (wide ? 40 : 24)} />
      </span>
    </p>
  );
}

export default function ProjectFeatureCard({ post: p, wide = false, eager = false }: { post: PostCard; wide?: boolean; eager?: boolean }) {
  const { lang } = useLanguage();
  const comments = Math.max(0, p.counts.comments);
  return (
    <article data-project-card={p.id} data-project-feature className="cm-card relative flex min-w-0 flex-col rounded-lg p-1 shadow-sm has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus">
      <SafeImage
        sizes={wide ? '(min-width: 1280px) 320px, 30vw' : '50vw'}
        src={p.cover?.url ?? null}
        alt=""
        aspect="auto"
        eager={eager}
        className={`${wide ? 'aspect-[3/2]' : 'aspect-video'} w-full overflow-hidden rounded-md`}
        bgClassName="bg-surface-selected"
      />
      <div className={`flex min-w-0 flex-col gap-1 ${wide ? 'px-3 pt-3' : 'px-2 pt-2'}`}>
        <h3 dir="auto" className={`truncate text-start font-bold leading-snug text-text-primary ${wide ? 'text-xl' : 'text-[15px]'}`}>
          <Link to={p.url} className="after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none">
            {p.title}
          </Link>
        </h3>
        <ProjectMeta material={p.material.name || null} name={p.author.name} avatar={p.author.avatarUrl} size={wide ? 28 : 24} />
      </div>
      <div className="mt-auto flex items-center justify-between gap-1 text-text-secondary">
        <span className="flex items-center">
          <LikeButton postId={p.id} liked={!!p.viewer?.liked} count={p.counts.likes} size="sm" />
          <Link
            to={`${p.url}#comments`}
            aria-label={commentsLabel(comments, socialLang(lang))}
            className="relative z-10 inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 text-[12px] font-semibold tabular-nums hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <MessageCircle aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
            {comments > 0 && <span aria-hidden="true">{comments}</span>}
          </Link>
        </span>
        <SaveButton postId={p.id} saved={!!p.viewer?.saved} count={p.counts.saves} size="sm" />
      </div>
    </article>
  );
}
