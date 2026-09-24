/**
 * «أين يصلك الخبر» — the store's notification switches.
 *
 * What a switch means (worker/lib/merchantNotify.ts): the notice is ALWAYS in
 * the store's notification centre; the switch decides whether it also reaches
 * the merchant's Telegram, WhatsApp or email. Three are forced on and say
 * why; a switch no notification reads yet says «قريبًا» instead of pretending
 * to work (no fake UI). A failed save puts the switch back to what the server
 * holds and says so.
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { merchantApi } from '../../../lib/merchant';
import { Card } from '../../ui/Card';
import { Switch } from '../../ui/Switch';
import { ErrorState } from '../../ui/AsyncStates';
import { CardSkeleton } from '../../ui/DashboardSkeletons';
import { useToast } from '../../ui/Toast';

type Loc = (ar: string, en: string, ckb?: string) => string;

function labels(loc: Loc): Array<[string, string, string]> {
  // [key, label, what it covers]. OWNER: Sorani to be written by hand for the
  // new lines; the four existing labels keep their hand-written Sorani.
  return [
    ['new_orders', loc('الطلبات', 'Orders', 'داواکاری'), loc('طلب جديد، طلب ألغي، طلب ينتظر تأكيدك، عرض قُبل', 'A new order, a cancelled one, one waiting for you, an accepted offer')],
    ['request_opportunities', loc('فرص طلبات العملاء', 'Customer request opportunities', 'دەرفەتی داواکاری'), loc('طلب طباعة يناسب طابعاتك', 'A print request that fits your printers')],
    ['new_messages', loc('رسائل جديدة', 'New messages', 'نامەی نوێ'), loc('زبون كتب لمتجرك', 'A customer wrote to your store')],
    ['new_reviews', loc('تقييمات جديدة', 'New reviews', 'هەڵسەنگاندنی نوێ'), loc('تقييم جديد لمتجرك', 'A new review of your store')],
    ['low_stock', loc('المخزون', 'Stock'), loc('منتج نزل إلى حد التنبيه', 'A product reached its alert level')],
    ['payouts', loc('المال', 'Money'), loc('مبلغ صار متاحًا، تحويل وصلك', 'Money that became available, a payout paid')],
    ['marketing', loc('كوبوناتك', 'Your coupons'), loc('كوبون ينتهي خلال ٣ أيام', 'A coupon ending within 3 days')],
    ['complaints', loc('الشكاوى والنزاعات', 'Complaints and disputes', 'سکاڵا و ناکۆکی'), loc('شكوى أو نزاع على طلب من متجرك', 'A complaint or dispute on one of your orders')],
    ['system_alerts', loc('وضع متجرك', 'Your store\'s standing'), loc('قرار من Levonis على متجرك أو حسابك', 'A Levonis decision on your store or account')],
    ['new_followers', loc('متابعون جدد', 'New followers', 'شوێنکەوتووی نوێ'), ''],
    ['subscription_expiry', loc('انتهاء الاشتراك', 'Subscription expiry', 'کۆتایی ئەندامێتی'), ''],
  ];
}

export default function MerchantNotificationPreferences() {
  const { loc } = useLanguage();
  const toast = useToast();
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [forced, setForced] = useState<string[]>([]);
  const [wired, setWired] = useState<string[] | null>(null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState<unknown>(null);

  const load = () => {
    setError(null);
    merchantApi
      .notifications()
      .then((d) => {
        setPrefs(d.preferences);
        setForced(d.forced);
        setWired(d.wired ?? null);
      })
      .catch(setError);
  };
  useEffect(load, []);

  if (error && !prefs) return <ErrorState error={error} onRetry={load} compact />;
  if (!prefs) return <CardSkeleton lines={6} />;

  const change = async (k: string, v: boolean) => {
    const before = !!prefs[k];
    setSaving(k);
    setPrefs({ ...prefs, [k]: v });
    try {
      const d = await merchantApi.setNotifications({ [k]: v });
      setPrefs(d.preferences);
    } catch {
      setPrefs((p) => (p ? { ...p, [k]: before } : p));
      toast.error(loc('تعذّر الحفظ — حاول مجددًا.', 'Could not save — try again.')); // OWNER: Sorani to be written by hand.
    } finally {
      setSaving('');
    }
  };

  // OWNER: Sorani to be written by hand (the card's title and description).
  return (
    <Card
      title={loc('ما يصلك خارج Levonis', 'What reaches you outside Levonis')}
      description={loc(
        'كل إشعار يبقى هنا في إشعارات المتجر دائمًا. هذه المفاتيح تحدد ما يُرسل أيضًا إلى تيليغرام أو واتساب أو بريدك.',
        'Every notice always stays here in your store notifications. These switches decide what is also sent to your Telegram, WhatsApp or email.'
      )}
    >
      <div className="divide-y divide-border-subtle">
        {labels(loc).map(([k, label, covers]) => {
          const isForced = forced.includes(k);
          const soon = wired !== null && !wired.includes(k);
          const description = soon
            ? loc('قريبًا — هذا الإشعار لم يُطلق بعد.', 'Coming soon — this notification is not live yet.')
            : isForced
              ? `${covers} · ${loc('لا يمكن إيقافه — يخص أموالك أو حسابك.', 'Cannot be turned off — it concerns your money or your account.', 'ناتوانرێت بکوژێنرێتەوە.')}`
              : covers;
          return (
            <div key={k} data-notification-key={k} data-soon={soon || undefined} className="py-1">
              <Switch
                label={label}
                description={description}
                checked={!soon && !!prefs[k]}
                disabled={soon || isForced}
                busy={saving === k}
                onChange={(v) => void change(k, v)}
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
}
