/**
 * «أتابعهم» as the home's old `?tab=following` panel. The feed itself moved to
 * feed/FollowingFeed.tsx with the section page /community/following
 * (community UI plan C2.1); this is the one door the home still mounts until
 * its tab redirects to that page (C1), after which this file can go.
 */
import FollowingFeed from '../feed/FollowingFeed';

export default function FollowingPanel({ composerLink }: { viewer: string; composerLink: { to: string; state?: unknown } }) {
  return <FollowingFeed from="all" composerLink={composerLink} />;
}
