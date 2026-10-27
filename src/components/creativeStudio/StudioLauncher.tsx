/**
 * The admin sidebar’s «الاستوديو الإبداعي» tab. The sidebar’s entries are
 * TABS (DashboardLayout switches them through the unsaved-work guard and
 * keeps `?tab=` in the URL), so the entry opens this small panel rather than
 * navigating on select — the least surprising fit for how the sidebar works.
 * The studio itself is a full-screen route (/admin/creative-studio) because
 * the canvas needs the whole viewport. Its own words live here (three
 * languages, real Sorani — tests/creativeStudioUiSource.test.ts), so the
 * admin never downloads the studio’s string table to show one button.
 */
import { Link } from 'react-router-dom';
import { Palette } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export default function StudioLauncher() {
  const { loc, dir } = useLanguage();
  return (
    <section className="mx-auto flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border-subtle bg-surface p-5" dir={dir} data-studio-launcher>
      <Palette aria-hidden="true" className="h-6 w-6 text-text-secondary" />
      <h2 className="text-lg font-bold text-text-primary">{loc('استوديو Levonis الإبداعي', 'Levonis Creative Studio', 'ستۆدیۆی داهێنەرانەی Levonis')}</h2>
      <p className="text-sm leading-relaxed text-text-secondary">
        {loc('صمّم منشورات المتجر بطبقات قابلة للتعديل: صورة المنتج الأصلية دون تمديد، والسعر من بيانات المتجر، وClaude يقترح فقط.', 'Design the shop’s posts in editable layers: the original product picture never stretched, the price from store data, Claude only suggests.', 'پۆستەکانی فرۆشگا بە چینی دەستکاریکراو دیزاین بکە: وێنەی ڕەسەنی بەرهەم بەبێ کێشان، نرخ لە داتای فرۆشگاوە، Claude تەنها پێشنیار دەکات.')}
      </p>
      <Link to="/admin/creative-studio" className="lv-button lv-button-primary">
        {loc('افتح الاستوديو', 'Open the studio', 'ستۆدیۆکە بکەرەوە')}
      </Link>
      <p className="text-xs text-text-muted">{loc('يفتح في صفحة كاملة لأن المحرر يحتاج الشاشة كلها.', 'Opens full-screen: the editor needs the whole viewport.', 'لە پەڕەیەکی تەواودا دەکرێتەوە چونکە دەستکاریکەرەکە هەموو شاشەکەی پێویستە.')}</p>
    </section>
  );
}
