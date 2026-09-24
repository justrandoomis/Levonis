/**
 * The store's bell in the workspace header: the unread count of the STORE's
 * notices (not the owner's personal ones — the site header keeps those), and
 * one tap to the notification centre.
 *
 * The count is polled once a minute while the tab is in front and not at all
 * while it is hidden (the timer is cleared, not skipped); coming back asks at
 * once. `unread` from the parent overrides the poll right after the centre
 * changes it, so the two never disagree for a minute.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { IconButton } from '../../ui/Button';
import { useLanguage } from '../../../LanguageContext';
import { merchantNotificationsApi } from './merchantNotificationsApi';

const POLL_MS = 60_000;

export default function MerchantNotificationBell({
  onOpen,
  unread: pushed,
}: {
  onOpen: () => void;
  /** The latest figure the notification centre reported, when it is open. */
  unread?: number | null;
}) {
  const { loc } = useLanguage();
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(() => {
    merchantNotificationsApi
      .unreadCount()
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (typeof pushed === 'number') setUnread(pushed);
  }, [pushed]);

  useEffect(() => {
    let timer: number | null = null;
    const arm = () => {
      if (timer === null) timer = window.setInterval(refresh, POLL_MS);
    };
    const disarm = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') disarm();
      else {
        refresh();
        arm();
      }
    };
    if (document.visibilityState === 'visible') {
      refresh();
      arm();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disarm();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const label =
    unread > 0
      ? loc(`إشعارات المتجر، ${unread.toLocaleString('ar')} غير مقروءة`, `Store notifications, ${unread} unread`)
      : loc('إشعارات المتجر', 'Store notifications');
  // OWNER: Sorani to be written by hand.
  return (
    <IconButton
      label={label}
      icon={<Bell className="h-5 w-5" />}
      variant="secondary"
      badge={unread}
      onClick={onOpen}
      data-merchant-bell={unread}
    />
  );
}
