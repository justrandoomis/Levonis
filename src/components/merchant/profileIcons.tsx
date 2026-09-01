/**
 * The icon vocabulary of the storefront profile widgets — the ONE mapping
 * from stored icon NAMES to components, shared by the public profile and the
 * dashboard editor so the merchant picks from exactly what will render.
 *
 * Mirrors WIDGET_ICONS in worker/routes/merchant.ts (the server refuses names
 * outside the set). An unknown name still renders — as the plain link icon —
 * because a stale value must never blank a merchant's row.
 */

import {
  Link as LinkIcon, Globe, Instagram, Facebook, Youtube, Music2, Send, MessageCircle,
  Phone, MapPin, Clock, Package, Truck, Shield, Star, Printer, Layers, Hammer, Zap, Award,
} from 'lucide-react';

export const WIDGET_ICONS: Array<{ id: string; ar: string; en: string; Icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'link', ar: 'رابط', en: 'Link', Icon: LinkIcon },
  { id: 'globe', ar: 'موقع ويب', en: 'Website', Icon: Globe },
  { id: 'instagram', ar: 'إنستغرام', en: 'Instagram', Icon: Instagram },
  { id: 'facebook', ar: 'فيسبوك', en: 'Facebook', Icon: Facebook },
  { id: 'youtube', ar: 'يوتيوب', en: 'YouTube', Icon: Youtube },
  { id: 'tiktok', ar: 'تيك توك', en: 'TikTok', Icon: Music2 },
  { id: 'telegram', ar: 'تيليغرام', en: 'Telegram', Icon: Send },
  { id: 'whatsapp', ar: 'واتساب', en: 'WhatsApp', Icon: MessageCircle },
  { id: 'phone', ar: 'هاتف', en: 'Phone', Icon: Phone },
  { id: 'map-pin', ar: 'الموقع', en: 'Location', Icon: MapPin },
  { id: 'clock', ar: 'الوقت', en: 'Time', Icon: Clock },
  { id: 'package', ar: 'تجهيز', en: 'Packing', Icon: Package },
  { id: 'truck', ar: 'شحن', en: 'Shipping', Icon: Truck },
  { id: 'shield', ar: 'ضمان', en: 'Warranty', Icon: Shield },
  { id: 'star', ar: 'تميّز', en: 'Featured', Icon: Star },
  { id: 'printer', ar: 'طابعة', en: 'Printer', Icon: Printer },
  { id: 'layers', ar: 'خامات', en: 'Materials', Icon: Layers },
  { id: 'hammer', ar: 'ورشة', en: 'Workshop', Icon: Hammer },
  { id: 'zap', ar: 'سرعة', en: 'Fast', Icon: Zap },
  { id: 'award', ar: 'جودة', en: 'Quality', Icon: Award },
];

export function WidgetIcon({ name, className }: { name: string; className?: string }) {
  const found = WIDGET_ICONS.find((i) => i.id === name);
  const Cmp = found?.Icon ?? LinkIcon;
  return <Cmp className={className} />;
}
