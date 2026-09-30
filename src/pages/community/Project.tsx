/**
 * A PROJECT — /community/projects/:id. What a maker printed: the pictures,
 * the facts, the story, and the doors out of it — the store that made it, the
 * product it became, «اطلب طباعة مثلها» into the request wizard, the material
 * on the shelf.
 *
 * WHO SEES WHAT is the server's (worker/routes/communityPosts.ts): a draft is
 * its author's, an unlisted piece is the link's, a hidden one is a 404 to all
 * but its author and staff. This page draws the author's own controls only
 * from `viewer.can`, and the consent card only when `viewer.consent` says the
 * viewer is the customer being asked.
 */
import React, { Suspense, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Archive, ChevronLeft, ChevronRight, EyeOff, Printer, ShoppingBag, Store } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useGoBack } from '../../lib/useGoBack';
import { useMotion } from '../../lib/motion';
import { apiRefusal } from '../../lib/refusalStrings';
import { useMoney } from '../../CurrencyContext';
import { productName } from '../../lib/productText';
import { ErrorState } from '../../components/ui/AsyncStates';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { toast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { StoreMark } from '../../components/community/hub/parts';
import { timeAgo } from '../../components/community/hub/copy';
import MediaStrip from '../../components/community/projects/MediaStrip';
import SpecList from '../../components/community/projects/SpecList';
import FileRows from '../../components/community/projects/FileRows';
import type { PostFile } from '../../components/community/files/api';
import { creatorHref, projectsApi, type Post } from '../../components/community/projects/api';
import { useProjectStrings } from '../../components/community/projects/strings';
import ActionRow from '../../components/community/social/ActionRow';
import FollowUserButton from '../../components/community/social/FollowUserButton';
import { LinkRow } from '../../components/community/links/LinkCard';

/** «قد يعجبك» — other pieces on the same material, printer or tags (Phase 3), a lazy rail below the doors. */
const RecommendRail = React.lazy(() => import('../../components/community/search/RecommendRail'));

export default function ProjectPage() {
  const { id = '' } = useParams();
  const goBack = useGoBack('/community');
  const navigate = useNavigate();
  const location = useLocation();
  const { loc, lang, dir } = useLanguage();
  const { user } = useAuth();
  const s = useProjectStrings();
  const m = useMotion();
  const { money } = useMoney();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [confirm, confirmDialog] = useConfirm();
  const refusalLang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';

  useEffect(() => {
    let alive = true;
    setError(null);
    projectsApi
      .get(id)
      .then((p) => {
        if (alive) setPost(p);
      })
      .catch((e: unknown) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [id, nonce, user?.id]);

  const say = (e: unknown, fallback: string) => toast.error(apiRefusal(e, refusalLang, fallback));

  const act = async (what: 'publish' | 'archive' | 'restore' | 'delete' | 'edit') => {
    if (!post) return;
    if (what === 'edit') {
      navigate(`${post.url}/edit`);
      return;
    }
    try {
      if (what === 'delete') {
        if (!(await confirm({ title: s.deleteQ, consequence: s.deleteConsequence, confirmLabel: s.delete, destructive: true }))) return;
        await projectsApi.remove(post.id);
        navigate('/profile?tab=projects', { replace: true });
        return;
      }
      if (what === 'archive' && !(await confirm({ title: s.archiveQ, consequence: s.archiveConsequence, confirmLabel: s.archive }))) return;
      const next = await projectsApi[what](post.id);
      setPost(next);
      if (what === 'publish') toast.success(s.published);
    } catch (e) {
      say(e, loc('تعذّر تنفيذ الإجراء.', 'Could not do that.', 'نەتوانرا ئەنجام بدرێت.'));
    }
  };

  const decide = async (decision: 'granted' | 'declined') => {
    if (!post) return;
    try {
      await projectsApi.consent(post.id, decision);
      setNonce((n) => n + 1);
    } catch (e) {
      say(e, loc('تعذّر تسجيل قرارك.', 'Could not record your decision.', 'نەتوانرا بڕیارەکەت تۆمار بکرێت.'));
    }
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  /** The attachments (§9.4): GET /posts/:id answers `files[]`; the projects api type predates it. */
  const files: PostFile[] = post ? ((post as Post & { files?: PostFile[] }).files ?? []) : [];

  /** The facts and the doors — placed once per layout, never shown twice. */
  const facts = post ? (
    <>
      <SpecList post={post} />
      {(post.store || post.product || post.material.product) && (
        <section aria-label={loc('روابط المشروع', 'Where this leads', 'بەستەرەکانی پڕۆژە')} className="flex flex-col divide-y divide-border-subtle/60 overflow-hidden rounded-2xl border border-border-subtle/60 bg-surface">
          {post.store && <Door href={post.store.url} icon={<StoreMark src={post.store.logoUrl} />} kicker={s.fromWorkshop} title={post.store.name} />}
          {post.product && (
            <Door
              href={post.product.url}
              icon={<span className="flex size-12 items-center justify-center rounded-full bg-gold/10 text-gold"><ShoppingBag className="h-5 w-5" /></span>}
              kicker={s.buyThisPiece}
              title={productName(post.product, lang)}
              trail={<span className="text-[14px] font-bold tabular-nums text-text-primary">{money(post.product.price_iqd)}</span>}
            />
          )}
          {post.material.product && (
            <Door
              href={post.material.product.url}
              icon={<span className="flex size-12 items-center justify-center rounded-full bg-surface-selected text-text-secondary"><Store className="h-5 w-5" /></span>}
              kicker={s.buyTheMaterial}
              title={productName(post.material.product, lang)}
            />
          )}
        </section>
      )}
    </>
  ) : null;

  return (
    <div className="min-h-screen bg-canvas pb-8 text-text-primary">
      <div className="material scroll-edge sticky top-0 z-40 h-14 px-4">
        <div className="mx-auto flex h-full max-w-3xl items-center gap-2">
          <button
            type="button"
            aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
            onClick={goBack}
            className="press-scale -ms-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Back className="h-5 w-5" />
          </button>
          <span className="min-w-0 flex-1 truncate text-[13px] text-text-muted">{s.project}</span>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4">
        {error ? (
          <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} className="mt-10" />
        ) : !post ? (
          <ProjectSkeleton />
        ) : (
          <motion.article
            initial={{ opacity: 0, y: m.travel(12) }}
            animate={{ opacity: 1, y: 0 }}
            transition={m.spring('ui')}
            className="flex flex-col gap-5 pt-3"
          >
            {/* the author's own banners */}
            {post.viewer.mine && post.state === 'draft' && (
              <Banner tone="info" icon={<EyeOff className="h-4 w-4" />}>
                <span className="flex-1">
                  {post.consent_status === 'pending' ? s.consentPending : post.consent_status === 'declined' ? s.consentDeclined : s.draftBanner}
                </span>
                {post.viewer.can.publish && post.consent_status !== 'pending' && (
                  <Button size="sm" variant="primary" onClick={() => act('publish')} data-project-publish>
                    {s.publish}
                  </Button>
                )}
              </Banner>
            )}
            {post.viewer.mine && post.state === 'archived' && <Banner tone="info" icon={<Archive className="h-4 w-4" />}>{s.archivedBanner}</Banner>}
            {post.hidden && (
              <Banner tone="danger" icon={<EyeOff className="h-4 w-4" />}>
                {s.hiddenBanner}
                {post.hidden.reason ? ` ${s.reason}: ${post.hidden.reason}` : ''}
              </Banner>
            )}
            {/* the customer being asked */}
            {post.viewer.consent && (
              <section aria-labelledby="consent-title" data-project-consent className="rounded-2xl border border-gold/40 bg-surface p-4">
                <h2 id="consent-title" className="text-[14.5px] font-bold">
                  {s.askedTitle}
                </h2>
                <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
                  {post.viewer.consent === 'pending' ? s.askedBody : post.viewer.consent === 'granted' ? s.youAllowed : s.youDeclined}
                </p>
                {post.viewer.consent === 'pending' && (
                  <div className="mt-3 flex gap-2">
                    <Button variant="primary" size="sm" onClick={() => decide('granted')} data-consent="granted">
                      {s.allow}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => decide('declined')} data-consent="declined">
                      {s.decline}
                    </Button>
                  </div>
                )}
              </section>
            )}

            {/* On a phone one column: pictures, title, counts, facts, story,
                tags, doors. On a wide screen the facts and the doors sit
                beside the pictures, where the eye goes after the title. */}
            <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8">
              <div className="flex min-w-0 flex-col gap-5">
                <MediaStrip media={post.media} title={post.title} />

                <header>
                  <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
                    <span aria-hidden="true" className="h-px w-4 bg-gold" />
                    {s.kinds[post.kind]}
                  </p>
                  <h1 dir="auto" className="mt-1 text-balance text-start text-[22px] font-black leading-tight sm:text-[28px]">
                    {post.title}
                  </h1>
                  <Byline post={post} />
                </header>

                {/* like · comment · save · share · ⋯ — the server's flags
                    decide the pressed states; the counts move with them. */}
                <ActionRow
                  post={post}
                  viewer={post.viewer}
                  mine={post.viewer.mine}
                  can={{ edit: post.viewer.can.edit, archive: post.viewer.can.archive, restore: post.state === 'archived', delete: post.viewer.can.delete }}
                  onAuthorAction={(a) => void act(a)}
                  onCounts={(counts) => setPost((p) => (p ? { ...p, counts: { ...p.counts, ...counts } } : p))}
                  openComments={location.hash === '#comments'}
                  className="-mx-2"
                />

                <div className="flex flex-col gap-5 lg:hidden">{facts}</div>

                {post.body && (
                  <p dir="auto" className="whitespace-pre-line text-start text-[14.5px] leading-relaxed text-text-secondary">
                    {post.body}
                  </p>
                )}
                {/* the first link in the story as a card (§9.4): the page's
                    title, its host, our copy of its picture; a model page
                    offers «اطلب طباعته». Drawn only when the server already
                    holds the card — a reader never makes it fetch. */}
                <LinkRow text={post.body} variant="full" />

                {/* the model and the documents behind the pictures (§9.4):
                    «عرض ثلاثي الأبعاد» mints a viewer link; the download only
                    when the author allowed it and the reader is signed in. */}
                <FileRows postId={post.id} files={files} signedIn={!!user} />

                {post.tags.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label={s.tags}>
                    {post.tags.map((t) => (
                      <li key={t}>
                        <Link
                          to={`/community/projects?tag=${encodeURIComponent(t)}`}
                          className="lv-hit relative inline-flex min-h-8 items-center rounded-full bg-surface px-3 text-[12.5px] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          #{t}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <aside className="hidden lg:grid lg:gap-5">{facts}</aside>
            </div>

            {post.state === 'published' && (
              <Suspense fallback={null}>
                <RecommendRail anchor={`post:${post.id}`} kind="projects" />
              </Suspense>
            )}
          </motion.article>
        )}
      </div>

      {/* «اطلب طباعة مثلها» — the page's one accent verb, under the thumb. */}
      {post && post.kind === 'project' && !post.viewer.mine && (
        <div
          className="material material-thick scroll-edge-up sticky z-30 mt-6 px-4 py-3"
          style={{ insetBlockEnd: 'calc(max(var(--shell-bottom-inset, 0px), var(--nav-stack, 0px)) + 0.5rem)' }}
          data-project-action-bar
        >
          <div className="mx-auto flex max-w-3xl items-center gap-2 sm:justify-end">
            <Link
              to={`/requests?view=new&project=${encodeURIComponent(post.id)}`}
              state={{ project: { id: post.id, title: post.title, material: post.material.name, color: post.color } }}
              data-project-print
              className="lv-button lv-button-accent flex-1 gap-2 sm:flex-none sm:px-6"
            >
              <Printer aria-hidden="true" className="h-4 w-4" />
              {s.printOneLikeIt}
            </Link>
            {post.product && (
              <Link to={post.product.url} className="lv-button lv-button-secondary gap-2">
                <ShoppingBag aria-hidden="true" className="h-4 w-4" />
                {s.buyThisPiece}
              </Link>
            )}
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Byline({ post }: { post: Post }) {
  const { lang } = useLanguage();
  const hubLang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const href = post.author.username ? creatorHref(post.author.username) : null;
  const when = timeAgo(post.published_at ?? post.created_at, hubLang);
  const inner = (
    <>
      <span aria-hidden="true" className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-surface-selected">
        {post.author.avatarUrl && <img src={post.author.avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold text-text-primary">
          <bdi>{post.author.name}</bdi>
        </span>
        <span className="block text-[12px] text-text-muted">{when}</span>
      </span>
    </>
  );
  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      {href ? (
        <Link to={href} data-project-author className="inline-flex min-w-0 max-w-full items-center gap-2.5 rounded-full pe-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {inner}
        </Link>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-center gap-2.5">{inner}</span>
      )}
      <FollowUserButton userId={post.author.id} following={!!post.viewer.following_author} size="sm" />
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: 'info' | 'danger'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-[13px] ${
        tone === 'danger' ? 'border-danger/30 bg-danger/10 text-text-primary' : 'border-border-subtle/60 bg-surface text-text-secondary'
      }`}
    >
      <span aria-hidden="true" className="shrink-0 text-text-muted">
        {icon}
      </span>
      {children}
    </div>
  );
}

function Door({ href, icon, kicker, title, trail }: { href: string; icon: React.ReactNode; kicker: string; title: string; trail?: React.ReactNode }) {
  const { dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const external = /^https?:\/\//.test(href) && !href.startsWith(window.location.origin);
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] text-text-muted">{kicker}</span>
        <span dir="auto" className="block truncate text-start text-[14px] font-semibold text-text-primary">
          {title}
        </span>
      </span>
      {trail}
      <Chevron aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
    </>
  );
  const cls = 'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus';
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {body}
    </a>
  ) : (
    <Link to={href} className={cls}>
      {body}
    </Link>
  );
}

function ProjectSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-5 pt-3">
      <div className="-mx-4 aspect-[4/3] animate-pulse bg-surface-selected sm:mx-0 sm:rounded-xl motion-reduce:animate-none" />
      <div className="h-3 w-16 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
      <div className="h-6 w-3/4 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
      <div className="h-9 w-40 animate-pulse rounded-full bg-surface-selected motion-reduce:animate-none" />
      <div className="h-24 w-full animate-pulse rounded-2xl bg-surface-selected motion-reduce:animate-none" />
    </div>
  );
}
