/**
 * What the shell says about the SERVICE itself, never about a page:
 *
 *   PreviewBanner       an admin's view of a closed (or uninstalled) service —
 *                       visible on every screen, so nobody mistakes the
 *                       preview for the open shop;
 *   ClosedNotice        a public visitor at an address the closed service
 *                       does not answer yet;
 *   ServiceUnreachable  GET /status itself failed;
 *   CloudNotFound       an address nothing answers.
 *
 * The 404 is part of the shell's own chunk on purpose: it is a few lines, and
 * a chunk of its own would be one more request under 1 KB
 * (tests/motionLazy.test.ts counts them).
 */
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { StatusChip } from '../../components/ui/Badge';
import { common, nav, service } from '../strings/common';
import { useCloudText } from '../text';
import { CloudEmptyState } from '../ui/EmptyState';
import { Eye, Info, PackageSearch, RefreshCw, WifiOff } from '../ui/icons';

export function PreviewBanner({ notInstalled }: { notInstalled: boolean }) {
  const { t } = useCloudText();
  return (
    <div role="status" className="shrink-0 border-b border-border-subtle">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6 lg:px-8">
        <StatusChip tone="warning" icon={<Eye aria-hidden="true" className="h-3.5 w-3.5" />}>
          {t(service.previewBanner)}
        </StatusChip>
        <p className="min-w-0 text-[12px] leading-snug text-text-muted">{notInstalled ? t(service.notInstalled) : t(service.previewHint)}</p>
      </div>
    </div>
  );
}

export function ClosedNotice() {
  const { t } = useCloudText();
  return (
    <CloudEmptyState
      icon={<Info className="h-6 w-6" />}
      title={t(service.closedTitle)}
      body={t(service.closedBody)}
      action={
        <>
          <Link to="/" className="lv-button lv-button-secondary">
            {t(common.backHome)}
          </Link>
          <Link to="/how-it-works" className="lv-button lv-button-ghost">
            {t(nav.howItWorks)}
          </Link>
        </>
      }
    />
  );
}

export function ServiceUnreachable({ onRetry }: { onRetry: () => void }) {
  const { t } = useCloudText();
  return (
    <CloudEmptyState
      role="alert"
      icon={<WifiOff className="h-6 w-6" />}
      title={t(service.unreachableTitle)}
      body={t(service.unreachableBody)}
      action={
        <Button variant="secondary" icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />} onClick={onRetry}>
          {t(common.retry)}
        </Button>
      }
    />
  );
}

export function CloudNotFound() {
  const { t } = useCloudText();
  return (
    <CloudEmptyState
      icon={<PackageSearch className="h-6 w-6" />}
      title={t(common.notFoundTitle)}
      body={t(common.notFoundBody)}
      action={
        <Link to="/" className="lv-button lv-button-secondary">
          {t(common.backHome)}
        </Link>
      }
    />
  );
}
