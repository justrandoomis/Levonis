/**
 * HOW PRINT CLOUD WORKS — the real flow, as built (docs/PRINT_CLOUD.md
 * §§3–8), in seven steps and three languages: hours bought per printer class,
 * filament bought by the gram and kept at the workshop, a model uploaded or
 * imported, an estimate from the slicer (or a job that waits for one),
 * confirmation reserving hours and grams, the queue and the printer, and
 * pickup, delivery or buyback. No figure anywhere: prices and durations are
 * the server's, on the screens that read them.
 */
import { Link } from 'react-router-dom';
import { useCloud } from '../CloudContext';
import { nav } from '../strings/common';
import { guide } from '../strings/guide';
import { home } from '../strings/home';
import { useCloudText } from '../text';
import { Clock, Disc3, Hourglass, Lock, PageHeader, Printer, Truck, Upload } from '../ui';

export default function HowItWorks() {
  const { t } = useCloudText();
  const cloud = useCloud();
  const steps = [
    { icon: Clock, title: guide.hoursTitle, body: guide.hoursBody },
    { icon: Disc3, title: guide.filamentTitle, body: guide.filamentBody },
    { icon: Upload, title: guide.uploadTitle, body: guide.uploadBody },
    { icon: Hourglass, title: guide.estimateTitle, body: guide.estimateBody },
    { icon: Lock, title: guide.confirmTitle, body: guide.confirmBody },
    { icon: Printer, title: guide.queueTitle, body: guide.queueBody },
    { icon: Truck, title: guide.fulfilTitle, body: guide.fulfilBody },
  ];

  return (
    <div>
      <PageHeader title={t(guide.title)} subtitle={t(guide.intro)} back={{ to: '/', label: t(nav.home) }} />
      <ol className="space-y-3" aria-label={t(guide.stepsLabel)}>
        {steps.map(({ icon: Icon, title, body }, i) => (
          <li key={title.en} className="lv-surface flex gap-3 p-4">
            <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl lv-well text-text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold text-text-primary">
                <span className="tabular-nums text-text-muted">{i + 1}. </span>
                {t(title)}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-text-muted">{t(body)}</p>
            </div>
          </li>
        ))}
      </ol>
      {cloud.canUse ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {cloud.signedIn ? (
            <Link to="/print" className="lv-button lv-button-primary">
              {t(home.startPrint)}
            </Link>
          ) : null}
          <Link to="/printers" className="lv-button lv-button-secondary">
            {t(home.viewPrinters)}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
