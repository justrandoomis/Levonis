/**
 * `/merchant/notifications` — the store's notification centre and its
 * switches (W2-E), mounted unchanged. The centre tells the shell's bell the
 * unread count it just changed, so the two never disagree for a minute.
 */
import MerchantNotificationCenter from '../../notifications/MerchantNotificationCenter';
import MerchantNotificationPreferences from '../../notifications/MerchantNotificationPreferences';
import { useWorkspace } from '../context';

export default function NotificationsSection() {
  const ws = useWorkspace();
  return (
    <div className="space-y-6">
      <MerchantNotificationCenter
        onUnreadChange={(n) => {
          ws.setBellUnread(n);
          ws.attention.refresh(true);
        }}
      />
      <MerchantNotificationPreferences />
    </div>
  );
}
