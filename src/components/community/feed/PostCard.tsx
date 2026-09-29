/**
 * ONE POST IN THE FEED — a hairline row on the canvas, no box. Who, what kind,
 * when; the cover photograph; the title as the card's one stretched link; the
 * story's first lines; the specs as chips that are themselves doors (the
 * printer's page, the material's, the product for sale, the store, the tags);
 * then the social row (src/components/community/social/ActionRow.tsx) and,
 * for a printed project, the two commerce verbs.
 *
 * Every pressable thing beside the title is a sibling with `relative z-10`,
 * never inside the link, and every one of them is a 44 px target: the chips
 * and the author's name are drawn small and grown with `lv-hit`. The avatar
 * is decoration — the name is the one link to the maker, not two tab stops
 * to one page. In the feed only the cover is shown — the strip of pictures
 * is the project page's.
 *
 * Memoised: the feed appends a page by re-rendering the list, and thirty
 * cards that did not change must not re-render with it.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import { useAuth } from '../../../AuthContext';
import SafeImage from '../../ui/SafeImage';
import ActionRow from '../social/ActionRow';
import { creatorHref, type PostCard as PostCardData } from '../projects/api';
import { Avatar, HubLink } from '../hub/parts';
import { timeAgo } from '../hub/copy';
import { useHubStrings } from '../hub/strings';

const CHIP =
  'lv-hit relative z-10 inline-flex min-h-8 max-w-full items-center gap-1 truncate rounded-full border border-border-subtle/60 bg-surface px-2.5 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

/** What a press on the card changed: the counts, the viewer's own marks. */
export interface PostPatch {
  counts?: Partial<PostCardData['counts']>;
  viewer?: { liked?: boolean; saved?: boolean };
}

export default React.memo(PostCard);

function PostCard({ post: p, eager = false, onPatch }: { post: PostCardData; eager?: boolean; onPatch?: (id: string, change: PostPatch) => void }) {
  const { lang } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const { money } = useMoney();
  const s = useHubStrings();
  const author = p.author.username ? creatorHref(p.author.username) : null;
  const portrait = !!p.cover && (p.cover.height ?? 0) > (p.cover.width ?? 0);
  const mine = !!user && user.id === p.author.id;

  const chips: Array<{ key: string; href: string; label: string }> = [];
  if (p.printer.product) chips.push({ key: 'printer', href: p.printer.product.url, label: p.printer.name || p.printer.product.name });
  if (p.material.product) chips.push({ key: 'material', href: p.material.product.url, label: p.material.name || p.material.product.name });
  if (p.product) chips.push({ key: 'product', href: p.product.url, label: `${lang === 'ar' ? p.product.name_ar || p.product.name : p.product.name} · ${money(p.product.price_iqd)}` });
  if (p.store) chips.push({ key: 'store', href: p.store.url, label: p.store.name });
  for (const tag of p.tags) {
    if (chips.length >= 6) break;
    chips.push({ key: `tag:${tag}`, href: `/community?tab=projects&tag=${encodeURIComponent(tag)}`, label: `#${tag}` });
  }

  const printPath = `/requests?view=new&project=${encodeURIComponent(p.id)}`;
  const printLink = isAuthenticated ? { to: printPath } : { to: '/auth', state: { from: printPath } };

  return (
    <article data-post-card={p.id} data-post-kind={p.kind} className="lv-section relative flex flex-col gap-3 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus rounded-lg">
      <header className="flex items-center gap-2.5">
        <Avatar src={p.author.avatarUrl} className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-bold leading-tight text-text-primary">
            {author ? (
              <Link to={author} className="lv-hit relative z-10 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                <bdi>{p.author.name}</bdi>
              </Link>
            ) : (
              <bdi>{p.author.name}</bdi>
            )}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
            <span>{s.kinds[p.kind]}</span>
            {p.published_at && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={p.published_at}>{timeAgo(p.published_at, lang)}</time>
              </>
            )}
          </p>
        </div>
      </header>

      {p.cover && (
        <div className={`relative -mx-4 overflow-hidden sm:mx-0 sm:rounded-xl ${portrait ? 'aspect-[4/5]' : 'aspect-[4/3]'}`}>
          <SafeImage src={p.cover.url} alt="" aspect="auto" eager={eager} className="h-full w-full" bgClassName="bg-surface-selected" />
          {p.cover.kind === 'video' && (
            <span className="absolute start-3 top-3 flex size-8 items-center justify-center rounded-full bg-black/60 text-snow">
              <Play aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
              <span className="sr-only">{s.video}</span>
            </span>
          )}
        </div>
      )}

      <div className="min-w-0">
        <h3 dir="auto" className="text-start text-[15px] font-bold leading-snug text-text-primary">
          <Link to={p.url} className="after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none">
            {p.title}
          </Link>
        </h3>
        {p.excerpt && (
          <p dir="auto" className="mt-1 line-clamp-3 text-start text-[13px] leading-relaxed text-text-secondary">
            {p.excerpt}
          </p>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <HubLink key={c.key} href={c.href} className={CHIP}>
              <bdi className="truncate">{c.label}</bdi>
            </HubLink>
          ))}
        </div>
      )}

      <ActionRow post={p} viewer={p.viewer} mine={mine} size="sm" className="-mx-2"
        onCounts={(counts) => onPatch?.(p.id, { counts })}
        onViewer={(viewer) => onPatch?.(p.id, { viewer })}
      />

      {p.kind === 'project' && (
        <div className="flex flex-wrap gap-2">
          <Link to={printLink.to} state={printLink.state} data-post-print className="lv-button lv-button-sm lv-button-accent relative z-10">
            {s.printIt}
          </Link>
          {p.material.product && (
            <HubLink href={p.material.product.url} className="lv-button lv-button-sm lv-button-secondary relative z-10">
              {s.buyMaterials}
            </HubLink>
          )}
        </div>
      )}
    </article>
  );
}
