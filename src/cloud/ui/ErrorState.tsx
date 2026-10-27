/**
 * A FAILED LOAD, SAID PLAINLY, WITH THE WAY ON.
 *
 *   no connection / timeout  → «No connection» + retry
 *   401                      → «Sign in to continue» + the sign-in handoff
 *   PRINT_CLOUD_DISABLED     → «Print Cloud is not open yet»
 *   PRINT_CLOUD_NOT_INSTALLED→ the database is not set up yet
 *   404                      → «not found»
 *   any other refusal        → the server's own words in the reader's
 *                              language (`cloudErrorText`) + retry
 *
 * Never an empty list in place of an error: «nothing here» and «could not
 * load» are different facts.
 */
import React from 'react';
import { ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { cloudErrorCode, cloudErrorText } from '../api';
import { useSignIn } from '../auth';
import { common, service } from '../strings/common';
import { useCloudText } from '../text';
import { LogIn, PackageSearch, RefreshCw, TriangleAlert, WifiOff } from './icons';

export interface CloudErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}

export function CloudErrorState({ error, onRetry, compact = false, className = '' }: CloudErrorStateProps) {
  const { t, lang } = useCloudText();
  const signIn = useSignIn();
  const code = cloudErrorCode(error);
  const status = error instanceof ApiError ? error.status : -1;

  let icon: React.ReactNode = <TriangleAlert className="h-6 w-6" />;
  let title = t(common.errorTitle);
  let body: string | null = cloudErrorText(error, lang);
  let retry = !!onRetry;
  let action: React.ReactNode = null;

  if (status === 0) {
    icon = <WifiOff className="h-6 w-6" />;
    title = t(common.networkTitle);
    body = t(common.networkBody);
  } else if (status === 401) {
    icon = <LogIn className="h-6 w-6" />;
    title = t(common.signInTitle);
    body = t(common.signInBody);
    retry = false;
    action = (
      <Button variant="primary" icon={<LogIn aria-hidden="true" className="h-4 w-4" />} onClick={() => signIn()}>
        {t(common.signInTitle)}
      </Button>
    );
  } else if (code === 'PRINT_CLOUD_DISABLED') {
    title = t(service.closedTitle);
    body = t(service.closedBody);
    retry = false;
  } else if (code === 'PRINT_CLOUD_NOT_INSTALLED') {
    title = t(service.closedTitle);
    body = t(service.notInstalled);
    retry = false;
  } else if (status === 404) {
    icon = <PackageSearch className="h-6 w-6" />;
    title = t(common.notFoundTitle);
    retry = false;
  }

  return (
    <div role="alert" className={`lv-surface flex flex-col items-center gap-3 text-center ${compact ? 'px-4 py-6' : 'px-6 py-12'} ${className}`}>
      <div aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full lv-well text-text-muted">
        {icon}
      </div>
      <p className="text-[15px] font-bold text-text-primary">{title}</p>
      {body ? <p className="max-w-xs text-sm leading-relaxed text-text-muted">{body}</p> : null}
      {action}
      {retry && onRetry ? (
        <Button variant="secondary" icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />} onClick={onRetry}>
          {t(common.retry)}
        </Button>
      ) : null}
    </div>
  );
}
