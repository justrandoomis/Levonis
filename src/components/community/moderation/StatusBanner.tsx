/**
 * «حسابك مقيَّد» — THE ACCOUNT'S STANDING, SAID WHERE IT MATTERS
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6 Moderation V2, «Enforcement»).
 *
 * A restricted, suspended or banned account learns it before it writes a
 * whole post the server will refuse: the banner stands on the community home
 * and at the composer's door with the standing, what it takes away, the reason
 * the desk wrote, the end date when there is one, and the way to contest it —
 * /moderation, where every decision waits with its own «اعتراض» (one per
 * decision). An active account draws NOTHING.
 *
 * THE STANDING RIDES ON THE SESSION (`user.moderation`, read by
 * `standingOf`, which reads an older server's user as active): no request of
 * its own, so it is there on the first frame. It is a hint, never the gate —
 * every write door asks the server again (USER_RESTRICTED / USER_SUSPENDED /
 * USER_BANNED, worded by src/lib/refusalStrings.ts where they are refused).
 * A restriction past its end date already reads active on the server; the
 * banner goes with the next session read.
 */
import { Link } from 'react-router-dom';
import { Ban, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { moderationHref, standingOf, type Standing } from './api';
import { modDate, modLang, moderationStrings } from './strings';

export interface StatusBannerProps {
  /** The standing to show; the signed-in account's own by default. */
  standing?: Standing;
  /** Where «الاعتراض على القرار» goes; `null` draws no door (the decisions page itself). */
  appealHref?: string | null;
  className?: string;
}

export default function StatusBanner({ standing: given, appealHref = moderationHref(), className = '' }: StatusBannerProps) {
  const { user } = useAuth();
  const { lang } = useLanguage();
  const l = modLang(lang);
  const s = moderationStrings(l);
  const standing = given ?? standingOf(user);
  if (standing.status === 'active') return null;
  const status = standing.status;
  // The date is one unit: a narrow screen breaks the heading before it, never inside it.
  const until = status === 'banned' ? '' : modDate(standing.until, l).replace(/ /g, '\u00a0');
  const Icon = status === 'banned' ? Ban : ShieldAlert;
  const tone = status === 'restricted' ? 'lv-alert-warning' : 'lv-alert-danger';
  const headingId = `status-banner-${status}`;
  return (
    <section aria-labelledby={headingId} data-status-banner={status} className={`lv-alert ${tone} ${className}`}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${status === 'restricted' ? 'text-warning' : 'text-danger'}`} />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-[14px] font-bold leading-snug text-text-primary">
            {s.title[status](until)}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{s.meaning[status]}</p>
          {standing.reason && (
            <p dir="auto" className="mt-1.5 text-[12.5px] leading-relaxed text-text-secondary" data-status-reason>
              {s.reason(standing.reason)}
            </p>
          )}
          {appealHref && (
            <Link to={appealHref} className="lv-button lv-button-secondary lv-button-sm mt-3" data-status-appeal>
              {s.appealDoor}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
