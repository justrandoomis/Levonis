/**
 * A CREATOR — /u/:username. Who makes things in Levo Community: their name,
 * what they print with, their projects, and — when they run one — their store.
 *
 * The page exists only for an account that chose to be public (or a store
 * owner, who is public through the store): the server answers 404 otherwise
 * (worker/routes/communityPosts.ts, `creatorVisible`), and this page shows
 * the same «لا صفحة بهذا الاسم» for a private account and a misspelt name, so
 * the page itself never confirms that an account exists.
 */
import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, BadgeCheck, Ban, Flag, Globe, MoreHorizontal, Pencil, Plus, UserRound, Volume2, VolumeX } from 'lucide-react';
import { IconButton } from '../../components/ui/Button';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useGoBack } from '../../lib/useGoBack';
import { useMotion } from '../../lib/motion';
import { ApiError } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { EmptyState, ErrorState } from '../../components/ui/AsyncStates';
import { Menu, type MenuEntry } from '../../components/ui/Menu';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { TabPanels, TabStrip } from '../../components/ui/Tabs';
import LoadMore from '../../components/listing/LoadMore';
import StoreCard from '../../components/community/hub/StoreCard';
import type { CommunityStore } from '../../components/community/hub/api';
import { communityHubApi } from '../../components/community/hub/api';
import { useSignInPrompt } from '../../lib/guest';
import { toast } from '../../components/ui/Toast';
import ProjectCard, { ProjectCardSkeleton } from '../../components/community/projects/ProjectCard';
import { projectsApi, type Creator, type PostCard, type PostFilters } from '../../components/community/projects/api';
import { useProjectStrings } from '../../components/community/projects/strings';
import { socialApi } from '../../components/community/social/api';
import { forgetAfterBlock } from '../../components/community/hub/feedCache';
import FollowUserButton from '../../components/community/social/FollowUserButton';
import ReportSheet from '../../components/community/social/ReportSheet';
import { useSocial } from '../../components/community/social/SocialContext';
import { followersLabel, socialLang, useSocialStrings } from '../../components/community/social/strings';
import { dateLocale } from '../../components/orders/format';

const TABS = ['projects', 'posts', 'about'] as const;
type Tab = (typeof TABS)[number];

const SOCIAL_HOST: Record<string, string> = {
  instagram: 'https://instagram.com/',
  x: 'https://x.com/',
  tiktok: 'https://tiktok.com/@',
  facebook: 'https://facebook.com/',
  youtube: 'https://youtube.com/@',
};

/** «@name» or a pasted link → the profile's address; anything else is not a link. */
function socialHref(kind: string, value: string): string | null {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '');
  if (!/^[\w.-]{1,60}$/.test(handle)) return null;
  return `${SOCIAL_HOST[kind] ?? ''}${handle}`;
}

export default function CreatorPage() {
  const { username = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'projects';
  const goBack = useGoBack('/community');
  const { loc, lang, dir } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const s = useProjectStrings();
  const ss = useSocialStrings();
  const social = useSocial();
  const m = useMotion();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [followers, setFollowers] = useState<number | null>(null);
  const [reporting, setReporting] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const l = socialLang(lang);

  useEffect(() => setFollowers(null), [username]);

  const say = (e: unknown) => toast.error(apiRefusal(e, l, ss.actionFailed));
  const toggleMute = async (c: Creator) => {
    if (!isAuthenticated) return signIn();
    const next = !social.muted.has(c.id);
    social.setMuted(c.id, next);
    try {
      await (next ? socialApi.mute(c.id) : socialApi.unmute(c.id));
      forgetAfterBlock();
      toast.success(next ? ss.mutedToast : ss.unmutedToast);
    } catch (e) {
      social.setMuted(c.id, !next);
      say(e);
    }
  };
  const toggleBlock = async (c: Creator) => {
    if (!isAuthenticated) return signIn();
    const next = !social.blocked.has(c.id);
    if (!(await confirm({ title: next ? ss.blockQ : ss.unblockQ, consequence: next ? ss.blockConsequence : undefined, confirmLabel: next ? ss.block : ss.unblock, destructive: next }))) return;
    social.setBlocked(c.id, next);
    try {
      await (next ? socialApi.block(c.id) : socialApi.unblock(c.id));
      forgetAfterBlock();
      toast.success(next ? ss.blockedToast : ss.unblockedToast);
      // Blocked either way, the page is a 404: read it again and land there.
      if (next) setNonce((n) => n + 1);
    } catch (e) {
      social.setBlocked(c.id, !next);
      say(e);
    }
  };

  useEffect(() => {
    let alive = true;
    setError(null);
    projectsApi
      .creator(username)
      .then((c) => {
        if (alive) setCreator(c);
      })
      .catch((e: unknown) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [username, nonce, user?.id]);

  const chooseTab = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('tab', id);
    setParams(p);
  };

  const personItems = (c: Creator): MenuEntry[] => {
    const muted = social.muted.has(c.id);
    const blocked = social.blocked.has(c.id);
    return [
      { id: 'report', label: ss.report, icon: <Flag className="h-4 w-4" />, onSelect: () => (isAuthenticated ? setReporting(true) : signIn()) },
      { id: 'sep', separator: true },
      { id: 'mute', label: muted ? ss.unmute : ss.mute, icon: muted ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />, onSelect: () => void toggleMute(c) },
      { id: 'block', label: blocked ? ss.unblock : ss.block, icon: <Ban className="h-4 w-4" />, destructive: !blocked, onSelect: () => void toggleBlock(c) },
    ];
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const notFound = error instanceof ApiError && error.status === 404;

  return (
    <div className="min-h-screen pb-28 text-text-primary">
      <div className="material scroll-edge sticky top-0 z-40 h-14 px-4">
        <div className="mx-auto flex h-full max-w-3xl items-center gap-2">
          <IconButton
            label={loc('رجوع', 'Back', 'گەڕانەوە')}
            onClick={goBack}
            className="-ms-2"
            icon={<Back className="h-5 w-5" />}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] text-text-muted" dir="ltr">
            {creator ? `@${creator.username}` : ''}
          </span>
          {creator?.viewer.mine && (
            <Link to="/edit-profile" className="lv-button lv-button-secondary lv-button-sm gap-1.5">
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              {s.editProfile}
            </Link>
          )}
          {creator && !creator.viewer.mine && (
            <Menu
              label={ss.options}
              items={personItems(creator)}
              trigger={(props) => (
                <IconButton {...props} label={ss.options} data-creator-menu className="-me-2" icon={<MoreHorizontal className="h-5 w-5" aria-hidden="true" />} />
              )}
            />
          )}
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4">
        {notFound ? (
          <EmptyState icon={<UserRound aria-hidden="true" className="h-6 w-6" />} title={s.creatorNotFound} description={s.creatorNotFoundHint} className="mt-10" />
        ) : error ? (
          <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} className="mt-10" />
        ) : !creator ? (
          <HeaderSkeleton />
        ) : (
          <motion.div initial={{ opacity: 0, y: m.travel(12) }} animate={{ opacity: 1, y: 0 }} transition={m.spring('ui')}>
            <header className="flex items-start gap-4 pt-6 text-start">
              <span className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-border-subtle/60 bg-surface-selected">
                {creator.avatarUrl ? (
                  <img src={creator.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-text-muted">
                    <UserRound className="h-10 w-10" />
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
                  <span aria-hidden="true" className="h-px w-4 bg-gold" />
                  {s.creator}
                </p>
                <h1 dir="auto" className="mt-1 text-[24px] font-black leading-tight">
                  <bdi>{creator.name}</bdi>
                </h1>
                <p className="mt-0.5 text-[13px] text-text-muted" dir="ltr">
                  @{creator.username}
                </p>
                {(creator.badges.verified_merchant || creator.badges.pro || creator.badges.premium) && (
                  <p className="mt-2 flex flex-wrap gap-1.5">
                    {creator.badges.verified_merchant && <Badge icon={<BadgeCheck className="h-3.5 w-3.5" />}>{s.verifiedMerchant}</Badge>}
                    {creator.badges.pro && <Badge>PRO</Badge>}
                    {creator.badges.premium && <Badge>PREMIUM</Badge>}
                  </p>
                )}
                {creator.bio && (
                  <p dir="auto" className="mt-3 text-balance text-[14px] leading-relaxed text-text-secondary">
                    {creator.bio}
                  </p>
                )}
                {/* Counts hidden at zero (plan §4): a fresh maker's page says nothing rather than «0 متابعون». */}
                {(creator.stats.projects > 0 || (followers ?? creator.stats.followers ?? 0) > 0 || creator.stats.completed_jobs > 0) && (
                  <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                    {creator.stats.projects > 0 && <Stat n={creator.stats.projects} label={s.projectsCount} />}
                    {(followers ?? creator.stats.followers ?? 0) > 0 && (
                      <Stat n={followers ?? creator.stats.followers ?? 0} label={ss.followers} sr={followersLabel(followers ?? creator.stats.followers ?? 0, l)} data-creator-followers />
                    )}
                    {creator.stats.completed_jobs > 0 && <Stat n={creator.stats.completed_jobs} label={s.completedJobs} />}
                  </ul>
                )}
                {!creator.viewer.mine && (
                  <div className="mt-3">
                    <FollowUserButton
                      userId={creator.id}
                      following={!!creator.viewer.following}
                      followers={followers ?? creator.stats.followers ?? 0}
                      onChange={(_on, n) => setFollowers(n)}
                    />
                  </div>
                )}
              </div>
            </header>

            <div className="material material-thin scroll-edge sticky top-14 z-30 -mx-4 mt-5 px-4">
              <TabStrip
                group="creator"
                panels
                fill
                label={loc('أقسام الصفحة', 'Page sections', 'بەشەکانی پەڕە')}
                value={tab}
                onChange={chooseTab}
                indicatorClassName="bg-gold"
                items={[
                  { id: 'projects', label: s.projects },
                  { id: 'posts', label: ss.posts },
                  { id: 'about', label: s.about },
                ]}
                className="mx-auto max-w-3xl"
              />
            </div>

            <div className="min-h-[320px] pt-4">
              <TabPanels value={tab} order={[...TABS]} group="creator">
                {tab === 'projects' && <ProjectsTab creator={creator} filters={{ kind: 'project' }} />}
                {tab === 'posts' && <ProjectsTab creator={creator} filters={{ not_kind: 'project' }} empty={ss.noPostsYet} />}
                {tab === 'about' && (
                  <AboutTab
                    creator={creator}
                    lang={lang}
                    canFollow={creator.store?.user_id !== user?.id}
                    onFollow={async (store) => {
                      if (!isAuthenticated) return signIn();
                      try {
                        await (store.following ? communityHubApi.unfollow(store.id) : communityHubApi.follow(store.id));
                        setNonce((n) => n + 1);
                      } catch {
                        toast.error(loc('تعذّر تحديث المتابعة. حاول مرة أخرى.', 'Could not update the follow. Try again.', 'نەتوانرا شوێنکەوتن نوێ بکرێتەوە. دووبارە هەوڵ بدە.'));
                      }
                    }}
                  />
                )}
              </TabPanels>
            </div>
          </motion.div>
        )}
      </div>
      {creator && <ReportSheet open={reporting} onClose={() => setReporting(false)} target={{ type: 'user', id: creator.id }} />}
      {confirmDialog}
    </div>
  );
}

// ------------------------------------------------------------------- pieces

function Badge({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle/60 bg-surface px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
      {icon && <span aria-hidden="true" className="text-gold">{icon}</span>}
      {children}
    </span>
  );
}

/**
 * One count: the number then the noun, as a list item (a `<dl>` would put the
 * definition before its term). When `sr` names the counted phrase («41
 * متابعًا»), the visible number and noun are both hidden from the reader and
 * the phrase is read ONCE — not «41» and then «41 متابعًا».
 */
function Stat({ n, label, sr, ...rest }: { n: number; label: string; /** The counted phrase, when the visible noun is invariable. */ sr?: string; 'data-creator-followers'?: boolean }) {
  return (
    <li className="flex items-baseline gap-1" {...rest}>
      <span aria-hidden={sr ? true : undefined} data-count className="text-[16px] font-bold tabular-nums text-text-primary">
        <bdi>{n}</bdi>
      </span>
      <span aria-hidden={sr ? true : undefined} className="text-text-muted">
        {label}
      </span>
      {sr && <span className="sr-only">{sr}</span>}
    </li>
  );
}

function ProjectsTab({ creator, filters, empty }: { creator: Creator; filters: PostFilters; empty?: string }) {
  const s = useProjectStrings();
  const [rows, setRows] = useState<PostCard[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    projectsApi
      .list({ ...filters, author: creator.username })
      .then((p) => {
        if (!alive) return;
        setRows(p.posts);
        setNext(p.next);
        setTotal(p.total);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
    // `filters` is a literal per tab; the tab itself is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creator.username, filters.kind, filters.not_kind, nonce]);

  const loadMore = () => {
    if (!next || more === 'loading') return;
    setMore('loading');
    projectsApi
      .list({ ...filters, author: creator.username }, next)
      .then((p) => {
        setRows((r) => [...(r ?? []), ...p.posts]);
        setNext(p.next);
        setMore('idle');
      })
      .catch(() => setMore('error'));
  };

  if (error) return <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!rows) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <ProjectCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={empty ?? s.noProjectsYet}
        description={creator.viewer.mine ? s.myProjectsEmpty : undefined}
        action={
          creator.viewer.mine ? (
            <Link to="/community/projects/new" className="lv-button lv-button-primary mt-1 gap-2">
              <Plus aria-hidden="true" className="h-4 w-4" />
              {s.yourFirstProject}
            </Link>
          ) : undefined
        }
      />
    );
  }
  return (
    <div data-creator-projects={filters.not_kind ? 'posts' : 'projects'}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {rows.map((p, i) => (
          <ProjectCard key={p.id} post={p} eager={i < 4} />
        ))}
      </div>
      <LoadMore remaining={next ? Math.max(1, (total ?? 0) - rows.length) : 0} state={more} onMore={loadMore} />
    </div>
  );
}

function AboutTab({
  creator,
  lang,
  canFollow,
  onFollow,
}: {
  creator: Creator;
  lang: string;
  canFollow: boolean;
  onFollow: (store: CommunityStore) => void | Promise<void>;
}) {
  const s = useProjectStrings();
  const since = new Intl.DateTimeFormat(dateLocale(lang), { month: 'long', year: 'numeric' }).format(new Date(creator.member_since));
  const socials = Object.entries(creator.socials).filter(([, v]) => !!v);
  return (
    <div className="flex flex-col gap-5">
      {creator.store && (
        <section aria-label={s.theirStore}>
          <StoreCard store={creator.store as unknown as CommunityStore} canFollow={canFollow} busy={false} onToggleFollow={onFollow} />
        </section>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13.5px]">
        <dt className="text-text-muted">{s.memberSince}</dt>
        <dd>{since}</dd>
        {creator.printers.length > 0 && (
          <>
            <dt className="text-text-muted">{s.prints}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {creator.printers.map((p) => (
                <span key={p} className="rounded-full bg-surface px-2.5 py-0.5 text-[12.5px]">
                  {p}
                </span>
              ))}
            </dd>
          </>
        )}
        {creator.materials.length > 0 && (
          <>
            <dt className="text-text-muted">{s.materialsUsed}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {creator.materials.map((p) => (
                <span key={p} className="rounded-full bg-surface px-2.5 py-0.5 text-[12.5px]">
                  {p}
                </span>
              ))}
            </dd>
          </>
        )}
        {creator.website && (
          <>
            <dt className="text-text-muted">{s.website}</dt>
            <dd>
              <a href={/^https?:\/\//i.test(creator.website) ? creator.website : `https://${creator.website}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1.5 underline decoration-border-subtle underline-offset-4" dir="ltr">
                <Globe aria-hidden="true" className="h-3.5 w-3.5" />
                {creator.website.replace(/^https?:\/\//i, '')}
              </a>
            </dd>
          </>
        )}
      </dl>
      {socials.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={loc3(lang)}>
          {socials.map(([k, v]) => {
            const href = socialHref(k, v ?? '');
            const label = `${k === 'x' ? 'X' : k[0].toUpperCase() + k.slice(1)}`;
            return (
              <li key={k}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="lv-hit relative inline-flex min-h-9 items-center rounded-full border border-border-subtle bg-surface-raised px-3 text-[12.5px] font-semibold text-text-secondary shadow-xs hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    {label}
                  </a>
                ) : (
                  <span className="inline-flex min-h-9 items-center rounded-full border border-border-subtle/60 bg-surface px-3 text-[12.5px] text-text-secondary">
                    {label}: <bdi dir="ltr">{v}</bdi>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const loc3 = (lang: string) => (lang === 'en' ? 'Social links' : lang === 'ckb' ? 'بەستەرە کۆمەڵایەتییەکان' : 'روابط التواصل');

function HeaderSkeleton() {
  return (
    <div aria-hidden="true" className="flex items-start gap-4 pt-6">
      <div className="h-20 w-20 shrink-0 animate-pulse rounded-full bg-surface-selected motion-reduce:animate-none" />
      <div className="flex w-full flex-col gap-2">
        <div className="h-3 w-16 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
        <div className="h-6 w-40 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
        <div className="h-3 w-24 animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
        <div className="mt-2 h-10 w-full max-w-md animate-pulse rounded bg-surface-selected motion-reduce:animate-none" />
      </div>
    </div>
  );
}
