/**
 * WHAT PRINT CLOUD IS — the first screen of a visitor who is not signed in,
 * and of the whole public while the service is closed.
 *
 * Words only, and true ones: what the service does, the three things a
 * customer does, whether it is open. No figure, no printer, no price — those
 * are the server's, on the screens that read them. Open, it offers the
 * printers and a sign-in; closed, «opening soon» and the guide, with a quiet
 * line for the platform admin who signs in to preview it.
 */
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { StatusChip } from '../../components/ui/Badge';
import { useSignIn } from '../auth';
import { CLOUD_TITLE } from '../brand';
import { useCloud } from '../CloudContext';
import { service } from '../strings/common';
import { guide } from '../strings/guide';
import { home } from '../strings/home';
import { useCloudText } from '../text';
import { Clock, Disc3, ExternalLink, LogIn, Printer, Upload } from '../ui/icons';

export default function Landing() {
  const { t } = useCloudText();
  const cloud = useCloud();
  const signIn = useSignIn();
  const open = cloud.access === 'open';

  const steps = [
    { icon: Clock, title: guide.hoursTitle, body: guide.hoursBody },
    { icon: Disc3, title: guide.filamentTitle, body: guide.filamentBody },
    { icon: Upload, title: guide.uploadTitle, body: guide.uploadBody },
  ];

  return (
    <div className="space-y-6">
      <section className="lv-surface-raised p-5 sm:p-6" aria-labelledby="cloud-landing-title">
        <StatusChip tone={open ? 'success' : 'warning'}>{open ? t(guide.open) : t(service.openingSoon)}</StatusChip>
        <h1 id="cloud-landing-title" className="mt-3 text-2xl font-extrabold tracking-tight text-text-primary">
          <bdi dir="ltr">{CLOUD_TITLE}</bdi>
        </h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-text-secondary">{t(guide.intro)}</p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {open && !cloud.signedIn ? (
            <Button variant="primary" icon={<LogIn aria-hidden="true" className="h-4 w-4" />} onClick={() => signIn('/')}>
              {t(guide.signInToStart)}
            </Button>
          ) : null}
          {open ? (
            <Link to="/printers" className="lv-button lv-button-secondary">
              <Printer aria-hidden="true" className="h-4 w-4" />
              {t(home.viewPrinters)}
            </Link>
          ) : null}
          <Link to="/how-it-works" className={`lv-button ${open ? 'lv-button-ghost' : 'lv-button-secondary'}`}>
            {t(guide.readAll)}
          </Link>
        </div>
        {open && !cloud.signedIn ? <p className="mt-3 text-[13px] text-text-muted">{t(guide.signInHint)}</p> : null}
      </section>

      <section aria-label={t(guide.stepsLabel)} className="grid gap-3 sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, body }) => (
          <article key={title.en} className="lv-surface p-4">
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-xl lv-well text-text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <h2 className="mt-3 text-[15px] font-bold text-text-primary">{t(title)}</h2>
            <p className="mt-1 text-sm leading-relaxed text-text-muted">{t(body)}</p>
          </article>
        ))}
      </section>

      <div className="flex flex-col items-start gap-2">
        {!open && !cloud.signedIn ? (
          <Button variant="ghost" size="sm" icon={<LogIn aria-hidden="true" className="h-4 w-4" />} onClick={() => signIn('/')}>
            {t(guide.adminHint)}
          </Button>
        ) : null}
        {cloud.mainSite ? (
          <a href={cloud.mainSite} className="lv-button lv-button-ghost lv-button-sm">
            {t(guide.visitLevonis)}
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
          </a>
        ) : null}
      </div>
    </div>
  );
}
