/**
 * THE COMMUNITY KIT IN A BROWSER — every primitive of
 * src/components/community/kit/ in every state, inside the community scope
 * (CommunitySurface), so the scope tokens and the clay can be photographed
 * and paired with the reference crops (community UI plan B1).
 *
 *   /tests/browser/community-kit.html?theme=dark|light&lang=ar|en|ckb
 *
 * A browser fixture, never an app route: it is served by the local dev server
 * only and is never part of the production bundle. Hover, pressed and focus
 * are forced by the shooting script (Chrome DevTools forcePseudoState) on the
 * elements marked `data-force`; disabled and busy are real props. Only
 * utilities that already exist in the app are used here: Tailwind scans this
 * folder too, and a fixture must not grow the store stylesheet.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Box, Download, Eye, FileText, Image as ImageIcon, Layers, Link2, Lightbulb, MapPin, MessageCircle, Plus, Save, Search as SearchIcon, Share2, Trash2, Users, Wrench } from 'lucide-react';
import { LanguageProvider, useLanguage } from '../../src/LanguageContext';
import CommunitySurface from '../../src/components/community/CommunitySurface';
import FilterChip from '../../src/components/community/FilterChip';
import { GoldButton, KitButton, KitIconButton, TextLink, type KitVariant } from '../../src/components/community/kit/buttons';
import { ChoiceTiles, FilterSelect, SegmentedTrack, Stepper, Toggle, UnderlineTabs } from '../../src/components/community/kit/controls';
import { CountedField, DropZone, SearchField, SelectButton } from '../../src/components/community/kit/fields';
import { ActionDock, KitAvatar, KitCard, ListRow, MediaAddTile, MediaTile, SectionCard, SectionHead, StatePill, StepProgress, type StateTone } from '../../src/components/community/kit/display';
import { Overlay, Sheet } from '../../src/components/ui/Overlay';
import ToasterGate from '../../src/components/ui/ToasterGate';
import { toast } from '../../src/lib/toastStore';
import { setThemePreference, useTheme } from '../../src/lib/theme';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const stored = (() => {
  try {
    return localStorage.getItem('levonis.theme.v1');
  } catch {
    return null;
  }
})();
const theme = (params.get('theme') ?? stored) === 'light' ? 'light' : 'dark';
const langParam = params.get('lang') ?? localStorage.getItem('levo_lang');
const lang = langParam === 'en' ? 'en' : langParam === 'ckb' ? 'ckb' : 'ar';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', theme);

/** A photograph stand-in: a soft backdrop and one printed object. */
function picture(tone: string, w = 800, h = 600): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><radialGradient id="g" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="#f1ede4"/><stop offset="1" stop-color="#c9c2b3"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><ellipse cx="${w / 2}" cy="${h * 0.8}" rx="${w * 0.3}" ry="16" fill="#000" opacity=".12"/><rect x="${w * 0.32}" y="${h * 0.3}" width="${w * 0.36}" height="${h * 0.45}" rx="18" fill="${tone}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type State = 'rest' | 'hover' | 'pressed' | 'focus' | 'disabled' | 'loading';
const STATES: State[] = ['rest', 'hover', 'pressed', 'focus', 'disabled', 'loading'];
const FORCE: Partial<Record<State, string>> = { hover: 'hover', pressed: 'active', focus: 'focus-visible' };

function useT() {
  const { lang: l } = useLanguage();
  return (ar: string, en: string, ckb: string) => (l === 'en' ? en : l === 'ckb' ? ckb : ar);
}

function StateName({ s }: { s: State }) {
  const t = useT();
  const words: Record<State, string> = {
    rest: t('عادي', 'Rest', 'ئاسایی'),
    hover: t('تمرير', 'Hover', 'هێنانەسەر'),
    pressed: t('ضغط', 'Pressed', 'داگیراو'),
    focus: t('تركيز', 'Focus', 'فۆکەس'),
    disabled: t('معطل', 'Disabled', 'ناچالاک'),
    loading: t('تحميل', 'Loading', 'بارکردن'),
  };
  return <span className="block text-[11px] text-text-muted">{words[s]}</span>;
}

function Panel({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <KitCard as="section" data-kit={id} aria-label={title}>
      <h2 className="mb-3 text-[15px] font-bold text-text-primary">{title}</h2>
      {children}
    </KitCard>
  );
}

function ButtonRow({ variant, label, icon }: { variant: KitVariant; label: string; icon?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-kit-row={variant}>
      {STATES.map((s) => (
        <div key={s} className="min-w-0">
          <StateName s={s} />
          <KitButton variant={variant} icon={icon} block data-force={FORCE[s]} disabled={s === 'disabled'} loading={s === 'loading'}>
            {label}
          </KitButton>
        </div>
      ))}
    </div>
  );
}

function Kit() {
  const t = useT();
  const [tab, setTab] = useState('community');
  const [quality, setQuality] = useState('standard');
  const [dims, setDims] = useState('measured');
  const [status, setStatus] = useState<string | null>(null);
  const [process, setProcess] = useState<string | null>('fdm');
  const [kind, setKind] = useState<string | null>('project');
  const [methods, setMethods] = useState<string[]>(['file']);
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [qty, setQty] = useState<number | null>(4);
  const [qtyMin, setQtyMin] = useState<number | null>(1);
  const [q, setQ] = useState('');
  const [q2, setQ2] = useState(t('مزهرية', 'Vase', 'گوڵدان'));
  const [title, setTitle] = useState(t('منظم مكتبي الجديد', 'My new desk organiser', 'ڕێکخەری مێزی نوێم'));
  const [empty, setEmpty] = useState('');
  const [story, setStory] = useState(t('صممت القطع لتناسب أدواتي وتبقى مرتبة.', 'I designed the parts to fit my tools and stay tidy.', 'پارچەکانم بۆ ئامرازەکانم دیزاین کرد بۆ ئەوەی ڕێکخراو بمێننەوە.'));
  const [near, setNear] = useState('x'.repeat(92));
  const [full, setFull] = useState('x'.repeat(100));
  const [catOn, setCatOn] = useState(true);

  const pills: [StateTone, string][] = [
    ['open', t('مفتوح', 'Open', 'کراوە')],
    ['waiting', t('بانتظار الاختيار', 'Awaiting your choice', 'چاوەڕوانی هەڵبژاردنی تۆیە')],
    ['progress', t('قيد التنفيذ', 'In progress', 'لە جێبەجێکردندایە')],
    ['done', t('مكتمل', 'Done', 'تەواوبوو')],
    ['cancelled', t('ملغى', 'Cancelled', 'هەڵوەشێنراوە')],
  ];

  return (
    <CommunitySurface className="min-h-screen px-4 pb-28 pt-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-[22px] font-black text-text-primary">{t('مجموعة المجتمع', 'Community kit', 'کۆمەڵەی کۆمەڵگە')}</h1>
          <span className="text-[13px] text-text-muted" dir="ltr">
            {theme} · {lang}
          </span>
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel id="buttons" title={t('الأزرار', 'Buttons', 'دوگمەکان')}>
            <div className="flex flex-col gap-3">
              <ButtonRow variant="gold" label={t('اطلب طباعة', 'Request a print', 'داوای چاپ بکە')} icon={<Box className="h-[18px] w-[18px]" />} />
              <ButtonRow variant="secondary" label={t('حفظ مسودة', 'Save draft', 'ڕەشنووس پاشەکەوت بکە')} icon={<Save className="h-[18px] w-[18px]" />} />
              <ButtonRow variant="ghost" label={t('التفاصيل', 'Details', 'وردەکاری')} />
              <ButtonRow variant="outline" label={t('استيراد', 'Import', 'هاوردە')} />
              <ButtonRow variant="danger" label={t('حذف', 'Delete', 'سڕینەوە')} icon={<Trash2 className="h-[18px] w-[18px]" />} />
              <div data-kit-row="cta">
                <StateName s="rest" />
                <GoldButton size="cta" block>
                  {t('التالي', 'Next', 'دواتر')}
                </GoldButton>
              </div>
              <div className="flex flex-wrap items-end gap-2" data-kit-row="compact">
                <KitButton variant="secondary" size="compact" icon={<Plus className="h-4 w-4" />}>
                  {t('متابعة', 'Follow', 'شوێنکەوتن')}
                </KitButton>
                <KitButton variant="gold" size="compact">
                  {t('طلب جديد', 'New request', 'داواکاری نوێ')}
                </KitButton>
              </div>
              <div className="flex flex-wrap items-end gap-3" data-kit-row="links">
                {(['rest', 'hover', 'focus'] as State[]).map((s) => (
                  <div key={s}>
                    <StateName s={s} />
                    <TextLink to="/requests" data-force={FORCE[s]}>
                      {t('عرض الطلب', 'View request', 'داواکارییەکە ببینە')}
                    </TextLink>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-2" data-kit-row="icons">
                {STATES.map((s) => (
                  <div key={s} className="flex flex-col items-center">
                    <StateName s={s} />
                    <KitIconButton label={t('مشاركة', 'Share', 'هاوبەشکردن')} icon={<Share2 className="h-[18px] w-[18px]" />} data-force={FORCE[s]} disabled={s === 'disabled'} loading={s === 'loading'} />
                  </div>
                ))}
                <KitIconButton shape="square" label={t('عرض', 'View', 'بینین')} icon={<Eye className="h-5 w-5" />} />
                <KitIconButton shape="square" tone="danger" label={t('حذف الملف', 'Delete the file', 'سڕینەوەی فایلەکە')} icon={<Trash2 className="h-5 w-5" />} />
                <KitIconButton tone="ghost" label={t('تنزيل', 'Download', 'داگرتن')} icon={<Download className="h-5 w-5" />} badge="dot" />
              </div>
            </div>
          </Panel>

          <Panel id="selection" title={t('التبويبات والاختيار', 'Tabs and selection', 'تابەکان و هەڵبژاردن')}>
            <div className="flex flex-col gap-4">
              <UnderlineTabs
                group="kit-tabs"
                label={t('الطلبات', 'Requests', 'داواکارییەکان')}
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'community', label: t('طلبات المجتمع', 'Community requests', 'داواکارییەکانی کۆمەڵگە') },
                  { id: 'mine', label: t('طلباتي', 'My requests', 'داواکارییەکانم') },
                ]}
              />
              <SegmentedTrack
                group="kit-quality"
                label={t('الجودة', 'Quality', 'کوالیتی')}
                value={quality}
                onChange={setQuality}
                items={[
                  { id: 'fast', label: t('سريعة', 'Fast', 'خێرا') },
                  { id: 'standard', label: t('قياسية', 'Standard', 'ستاندارد') },
                  { id: 'fine', label: t('دقيقة', 'Fine', 'ورد') },
                  { id: 'ultra', label: t('فائقة', 'Ultra', 'زۆر ورد'), disabled: true },
                ]}
              />
              <div className="max-w-xs">
                <SegmentedTrack
                  group="kit-dims"
                  label={t('الأبعاد', 'Size', 'قەبارە')}
                  value={dims}
                  onChange={setDims}
                  items={[
                    { id: 'measured', label: t('مقاسة', 'Measured', 'پێوراو') },
                    { id: 'rough', label: t('تقريبية', 'Approximate', 'نزیکەیی') },
                  ]}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2" data-kit-row="filters">
                <FilterSelect
                  label={t('الحالة', 'Status', 'دۆخ')}
                  icon={<span className="h-2 w-2 rounded-full bg-success" />}
                  value={status}
                  onChange={setStatus}
                  options={[
                    { id: 'open', label: t('مفتوح', 'Open', 'کراوە') },
                    { id: 'offers', label: t('يستقبل عروضًا', 'Receiving offers', 'وەرگرتنی ئۆفەر') },
                  ]}
                />
                <FilterSelect
                  label={t('طريقة الطباعة', 'Print method', 'شێوازی چاپ')}
                  icon={<Layers className="h-[18px] w-[18px]" />}
                  value={process}
                  onChange={setProcess}
                  options={[
                    { id: 'fdm', label: t('خيوط FDM', 'FDM filament', 'دەزووی FDM') },
                    { id: 'resin', label: t('ريزن', 'Resin', 'ڕێزن') },
                  ]}
                />
                <FilterChip on={false} shape="rect" icon={<MapPin className="h-[18px] w-[18px]" />} data-force="hover">
                  {t('المحافظة', 'Province', 'پارێزگا')}
                </FilterChip>
                <FilterChip on={false} shape="rect" data-force="focus-visible">
                  {t('تركيز', 'Focus', 'فۆکەس')}
                </FilterChip>
                <FilterChip on={false} shape="rect" disabled>
                  {t('معطل', 'Disabled', 'ناچالاک')}
                </FilterChip>
                <FilterChip on={catOn} aria-pressed={catOn} shape="rect" icon={<Box className="h-[18px] w-[18px]" />} onClick={() => setCatOn(!catOn)}>
                  {t('مشروع', 'Project', 'پڕۆژە')}
                </FilterChip>
                <FilterChip on={false} aria-pressed={false}>
                  {t('شرح', 'Tutorial', 'ڕوونکردنەوە')}
                </FilterChip>
                <FilterChip on aria-pressed>
                  {t('قبل وبعد', 'Before and after', 'پێش و دوای')}
                </FilterChip>
              </div>
              <div className="flex flex-wrap gap-2" data-kit-row="pills">
                {pills.map(([tone, word]) => (
                  <StatePill key={tone} tone={tone}>
                    {word}
                  </StatePill>
                ))}
              </div>
              <div className="flex flex-col gap-1" data-kit-row="toggles">
                <Toggle checked={on} onChange={setOn} label={t('السماح بتنزيل الملف', 'Allow downloading the file', 'ڕێگە بدە فایلەکە دابگیرێت')} />
                <Toggle checked={off} onChange={setOff} label={t('اعرض ميزانيتي للتجار', 'Show my budget to merchants', 'بودجەکەم بە بازرگانان نیشان بدە')} />
                <Toggle checked label={t('معطل', 'Disabled', 'ناچالاک')} disabled onChange={() => undefined} />
                <Toggle checked={false} label={t('قيد الحفظ', 'Saving', 'پاشەکەوت دەکرێت')} busy onChange={() => undefined} />
              </div>
            </div>
          </Panel>

          <Panel id="tiles" title={t('البطاقات والمربعات', 'Tiles', 'خانەکان')}>
            <div className="flex flex-col gap-3">
              <ChoiceTiles
                label={t('طريقة الطباعة', 'Print method', 'شێوازی چاپ')}
                columns={3}
                value={process}
                onChange={setProcess}
                items={[
                  { id: 'fdm', title: t('خيوط FDM', 'FDM filament', 'دەزووی FDM') },
                  { id: 'resin', title: t('ريزن', 'Resin', 'ڕێزن') },
                  { id: 'unsure', title: t('لست متأكدًا', 'Not sure', 'دڵنیا نیم') },
                ]}
              />
              <ChoiceTiles
                label={t('طريقة الطلب', 'How you ask', 'شێوازی داواکاری')}
                multiple
                value={methods}
                onChange={setMethods}
                items={[
                  { id: 'file', icon: <Box className="h-5 w-5" />, title: t('ملف مجسّم', '3D file', 'فایلی سێ ڕەهەندی'), subtitle: t('ملف ثلاثي الأبعاد جاهز', 'A ready 3D file', 'فایلێکی ئامادەی سێ ڕەهەندی') },
                  { id: 'link', icon: <Link2 className="h-5 w-5" />, title: t('رابط مجسّم', 'Model link', 'بەستەری مۆدێل'), subtitle: t('رابط من منصة خارجية', 'A link from another site', 'بەستەرێک لە ماڵپەڕێکی تر') },
                  { id: 'text', icon: <FileText className="h-5 w-5" />, title: t('وصف فقط', 'Description only', 'تەنها وەسف'), subtitle: t('اشرح الفكرة بالتفصيل', 'Explain the idea in detail', 'بیرۆکەکە بە وردی ڕوون بکەرەوە') },
                  { id: 'photos', icon: <ImageIcon className="h-5 w-5" />, title: t('صور مرجعية', 'Reference photos', 'وێنەی نموونە'), subtitle: t('صور أو رسومات توضيحية', 'Photos or sketches', 'وێنە یان ڕەشنووس'), disabled: true },
                ]}
              />
              <ChoiceTiles
                label={t('نوع المحتوى', 'Content type', 'جۆری ناوەڕۆک')}
                columns={3}
                value={kind}
                onChange={setKind}
                items={[
                  { id: 'project', icon: <Box className="h-5 w-5" />, title: t('مشروع', 'Project', 'پڕۆژە') },
                  { id: 'post', icon: <FileText className="h-5 w-5" />, title: t('منشور', 'Post', 'پۆست') },
                  { id: 'idea', icon: <Lightbulb className="h-5 w-5" />, title: t('فكرة', 'Idea', 'بیرۆکە') },
                ]}
              />
              <DropZone
                title={t('أضف ملفًا أو صورة', 'Add a file or a photo', 'فایل یان وێنەیەک زیاد بکە')}
                subtitle={t('اسحب وأفلت الملفات هنا أو اختر من الجهاز', 'Drop files here or choose from the device', 'فایلەکان لێرە دابنێ یان لە ئامێرەکە هەڵبژێرە')}
                formats={t('الصيغ المدعومة: STL · 3MF · STEP · OBJ · صور · PDF', 'Formats: STL · 3MF · STEP · OBJ · photos · PDF', 'فۆرماتەکان: STL · 3MF · STEP · OBJ · وێنە · PDF')}
                onFiles={() => undefined}
              />
              <div data-kit-row="drop-over">
                <DropZone title={t('أفلت هنا', 'Drop here', 'لێرە دایبنێ')} onFiles={() => undefined} />
              </div>
            </div>
          </Panel>

          <Panel id="fields" title={t('الحقول', 'Fields', 'خانەکان')}>
            <div className="flex flex-col gap-3">
              <SearchField label={t('بحث', 'Search', 'گەڕان')} placeholder={t('ابحث في الطلبات', 'Search requests', 'لە داواکارییەکان بگەڕێ')} value={q} onValueChange={setQ} />
              <SearchField label={t('بحث', 'Search', 'گەڕان')} value={q2} onValueChange={setQ2} />
              <div data-force-inside="focus-visible">
                <SearchField label={t('بحث', 'Search', 'گەڕان')} placeholder={t('تركيز', 'Focus', 'فۆکەس')} value="" onValueChange={() => undefined} />
              </div>
              <SearchField label={t('بحث', 'Search', 'گەڕان')} placeholder={t('ابحث عن مشروع، صانع أو متجر', 'Search projects, makers or stores', 'بگەڕێ بۆ پڕۆژە، دروستکەر یان فرۆشگا')} onOpen={() => undefined} />
              <CountedField label={t('عنوان المشروع', 'Project title', 'ناونیشانی پڕۆژە')} value={title} onValueChange={setTitle} max={140} />
              <CountedField label={t('رابط المتجر', 'Store link', 'بەستەری فرۆشگا')} optional value={empty} onValueChange={setEmpty} placeholder={t('أضف رابطًا', 'Add a link', 'بەستەرێک زیاد بکە')} hint={t('رابط متجرك أو منتجك', 'Your store or product link', 'بەستەری فرۆشگا یان بەرهەمەکەت')} />
              <CountedField label={t('حقل فيه خطأ', 'A field in error', 'خانەیەک بە هەڵەوە')} value="?" onValueChange={() => undefined} error={t('هذا العنوان قصير جدًا.', 'This title is too short.', 'ئەم ناونیشانە زۆر کورتە.')} />
              <CountedField label={t('معطل', 'Disabled', 'ناچالاک')} value={t('لا يمكن تعديله', 'Cannot be edited', 'ناتوانرێت دەستکاری بکرێت')} onValueChange={() => undefined} disabled />
              <CountedField label={t('احكِ قصة مشروعك', 'Tell the story', 'چیرۆکی پڕۆژەکەت بگێڕەوە')} multiline value={story} onValueChange={setStory} max={4000} />
              <CountedField label={t('قرب الحد', 'Near the limit', 'نزیک لە سنوور')} value={near} onValueChange={setNear} max={100} clearable={false} />
              <CountedField label={t('عند الحد', 'At the limit', 'لە سنووردا')} value={full} onValueChange={setFull} max={100} clearable={false} />
            </div>
          </Panel>

          <Panel id="selects" title={t('القوائم والعداد', 'Selects and stepper', 'لیست و ژمێرەر')}>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <SelectButton value="PETG" />
                <SelectButton value={t('أسود', 'Black', 'ڕەش')} swatch="#111111" />
                <SelectButton label={t('الخامة', 'Material', 'ماتریاڵ')} value="PLA Matte" icon={<Layers className="h-5 w-5" />} data-force="hover" />
                <SelectButton label={t('اللون', 'Colour', 'ڕەنگ')} value={t('أخضر', 'Green', 'سەوز')} swatch="#7f9f80" data-force="focus-visible" />
                <SelectButton placeholder={t('لست متأكدًا من الخامة', 'Not sure of the material', 'دڵنیا نیم لە ماتریاڵ')} />
                <SelectButton label={t('الطابعة', 'Printer', 'چاپکەر')} value="Bambu A1" disabled />
              </div>
              <Stepper aria-label={t('الكمية', 'Quantity', 'بڕ')} value={qty} onValueChange={(v) => setQty(v)} min={1} max={99} />
              <Stepper aria-label={t('الكمية', 'Quantity', 'بڕ')} value={qtyMin} onValueChange={(v) => setQtyMin(v)} min={1} max={99} />
              <StepProgress step={1} label={t('طلب طباعة', 'Print request', 'داواکاری چاپ')} caption={t('طلب طباعة · 1 من 4', 'Print request · 1 of 4', 'داواکاری چاپ · 1 لە 4')} />
              <StepProgress step={2} label={t('طلب طباعة', 'Print request', 'داواکاری چاپ')} caption={t('طلب طباعة · 2 من 4', 'Print request · 2 of 4', 'داواکاری چاپ · 2 لە 4')} />
              <StepProgress step={4} label={t('طلب طباعة', 'Print request', 'داواکاری چاپ')} caption={t('طلب طباعة · 4 من 4', 'Print request · 4 of 4', 'داواکاری چاپ · 4 لە 4')} />
            </div>
          </Panel>

          <Panel id="media" title={t('الصور والأشخاص', 'Media and people', 'وێنە و کەسەکان')}>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <MediaAddTile label={t('أضف صورة أو فيديو', 'Add a photo or video', 'وێنە یان ڤیدیۆ زیاد بکە')} onClick={() => undefined} />
                <MediaTile src={picture('#7f9f80')} alt={t('منظم مكتب', 'Desk organiser', 'ڕێکخەری مێز')} ratio="1 / 1" onRemove={() => undefined} draggable selected />
                <MediaTile src={picture('#b08d3c')} alt={t('مزهرية', 'Vase', 'گوڵدان')} ratio="1 / 1" onRemove={() => undefined} draggable />
              </div>
              <MediaTile src={picture('#4a6c7a', 800, 600)} alt={t('مصباح الفطر', 'Mushroom lamp', 'چرای قارچ')} index={1} count={3} />
              <div className="flex flex-wrap items-center gap-3" data-kit-row="avatars">
                {([24, 28, 40, 48, 64] as const).map((size) => (
                  <KitAvatar key={size} size={size} name={t('سارة حسن', 'Sara Hassan', 'سارا حەسەن')} />
                ))}
                <KitAvatar size={48} src={picture('#7a4a5a', 200, 200)} name="x" />
              </div>
            </div>
          </Panel>

          <Panel id="cards" title={t('البطاقات والصفوف', 'Cards and rows', 'کارت و ڕیزەکان')}>
            <div className="flex flex-col gap-3">
              <SectionHead title={t('طلبات الطباعة', 'Print requests', 'داواکارییەکانی چاپ')} to="/requests" />
              <KitCard>
                <p className="text-[15px] text-text-primary">{t('بطاقة', 'A card', 'کارتێک')}</p>
                <p className="text-[13px] text-text-secondary">{t('نص ثانوي', 'Secondary text', 'دەقی لاوەکی')}</p>
                <p className="text-[13px] text-text-muted">{t('نص خافت', 'Muted text', 'دەقی کاڵ')}</p>
              </KitCard>
              <KitCard raised>
                <p className="text-[15px] text-text-primary">{t('بطاقة مرفوعة', 'A raised card', 'کارتێکی بەرزکراوە')}</p>
                <TextLink to="/community/projects">{t('استكشف المشروع', 'Explore the project', 'پڕۆژەکە ببینە')}</TextLink>
              </KitCard>
              <SectionCard title={t('ملفات المجسم', 'Model files', 'فایلەکانی مۆدێل')} icon={<FileText className="h-5 w-5" />} optional trailing={<span className="text-[13px] text-text-muted" dir="ltr">2 / 10</span>}>
                <ListRow to="/community" label={t('صفحة المجتمع', 'Community home', 'پەڕەی کۆمەڵگە')} icon={<Users className="h-5 w-5" />} current />
                <ListRow to="/community/projects" label={t('المشاريع', 'Projects', 'پڕۆژەکان')} icon={<Lightbulb className="h-5 w-5" />} sublabel={t('ما يطبعه الصناع', 'What makers print', 'ئەوەی دروستکەران چاپی دەکەن')} />
                <ListRow to="/community/makers" label={t('الصنّاع', 'Makers', 'دروستکەران')} icon={<Wrench className="h-5 w-5" />} />
                <ListRow href="https://studio.example" label="Levo Studio" icon={<Box className="h-5 w-5" />} />
              </SectionCard>
              <div className="flex flex-wrap gap-2">
                <KitIconButton label={t('الرسائل', 'Messages', 'نامەکان')} icon={<MessageCircle className="h-5 w-5" />} badge={3} />
                <KitIconButton label={t('بحث', 'Search', 'گەڕان')} icon={<SearchIcon className="h-5 w-5" />} />
              </div>
            </div>
          </Panel>
          <Panel id="portals" title={t('النوافذ والإشعارات', 'Windows and notices', 'پەنجەرەکان و ئاگادارکردنەوەکان')}>
            <Portals />
          </Panel>
          <Panel id="dock" title={t('شريط الإجراء', 'Action bar', 'شریتی کردار')}>
            <div className="relative overflow-hidden rounded-lg">
              <ActionDock>
                <KitButton variant="secondary" className="flex-1">
                  {t('حفظ مسودة', 'Save draft', 'ڕەشنووس پاشەکەوت بکە')}
                </KitButton>
                <GoldButton size="cta" className="flex-[2]">
                  {t('انشر الطلب', 'Publish the request', 'داواکارییەکە بڵاو بکەرەوە')}
                </GoldButton>
              </ActionDock>
            </div>
          </Panel>
        </div>
      </div>
    </CommunitySurface>
  );
}

/**
 * The portals of the scope (src/components/community/scopePortals.ts): a sheet
 * opened from inside, a confirmation opened from that sheet, and a toast. The
 * shell below (outside the scope) opens a window of its own, switches the
 * theme and takes the community page away.
 */
function Portals() {
  const t = useT();
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap gap-2" data-kit-row="portals">
      <KitButton data-kit-open="sheet" onClick={() => setSheet(true)}>
        {t('افتح نافذة', 'Open a sheet', 'پەنجەرەیەک بکەرەوە')}
      </KitButton>
      <KitButton data-kit-open="toast" onClick={() => toast.success(t('حُفظ المشروع', 'Project saved', 'پڕۆژەکە پاشەکەوت کرا'), { duration: Infinity })}>
        {t('أظهر إشعارًا', 'Show a notice', 'ئاگادارییەک پیشان بدە')}
      </KitButton>
      <Sheet open={sheet} onClose={() => setSheet(false)} label={t('نافذة من صفحة المجتمع', 'A sheet from the community page', 'پەنجەرەیەک لە پەڕەی کۆمەڵگەوە')} testId="kit-sheet">
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[15px] text-text-primary">{t('نافذة من صفحة المجتمع', 'A sheet from the community page', 'پەنجەرەیەک لە پەڕەی کۆمەڵگەوە')}</p>
          <KitButton data-kit-open="confirm" onClick={() => setConfirm(true)}>
            {t('تأكيد', 'Confirm', 'دڵنیاکردنەوە')}
          </KitButton>
        </div>
      </Sheet>
      <Overlay open={confirm} onClose={() => setConfirm(false)} alert label={t('هل تريد المتابعة؟', 'Continue?', 'بەردەوام دەبیت؟')} testId="kit-confirm">
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[15px] text-text-primary">{t('هل تريد المتابعة؟', 'Continue?', 'بەردەوام دەبیت؟')}</p>
          <KitButton data-kit-close="confirm" onClick={() => setConfirm(false)}>
            {t('إغلاق', 'Close', 'داخستن')}
          </KitButton>
        </div>
      </Overlay>
    </div>
  );
}

/** The fixture as a page in the shell: the scope, then a shell bar outside it, and the shell toast stack. */
function Shell() {
  const t = useT();
  const { theme: shown } = useTheme();
  const [page, setPage] = useState(true);
  const [shellWindow, setShellWindow] = useState(false);
  return (
    <>
      {page && <Kit />}
      <div data-kit-shell className="flex flex-wrap gap-2 p-4">
        <button type="button" data-kit-shell="window" className="lv-button lv-button-secondary" onClick={() => setShellWindow(true)}>
          {t('نافذة من خارج المجتمع', 'A window from outside the community', 'پەنجەرەیەک لە دەرەوەی کۆمەڵگە')}
        </button>
        <button type="button" data-kit-shell="theme" className="lv-button lv-button-secondary" onClick={() => setThemePreference(shown === 'dark' ? 'light' : 'dark', null)}>
          {t('تبديل المظهر', 'Switch the theme', 'گۆڕینی ڕووکار')}
        </button>
        <button type="button" data-kit-shell="page" className="lv-button lv-button-secondary" onClick={() => setPage((v) => !v)}>
          {page ? t('إخفاء صفحة المجتمع', 'Hide the community page', 'شاردنەوەی پەڕەی کۆمەڵگە') : t('إظهار صفحة المجتمع', 'Show the community page', 'پیشاندانی پەڕەی کۆمەڵگە')}
        </button>
      </div>
      <Overlay open={shellWindow} onClose={() => setShellWindow(false)} label={t('نافذة من خارج المجتمع', 'A window from outside the community', 'پەنجەرەیەک لە دەرەوەی کۆمەڵگە')} testId="kit-shell-window">
        <div className="p-4">
          <button type="button" data-kit-close="shell" className="lv-button lv-button-secondary" onClick={() => setShellWindow(false)}>
            {t('إغلاق', 'Close', 'داخستن')}
          </button>
        </div>
      </Overlay>
      <ToasterGate />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <LanguageProvider>
      <Shell />
    </LanguageProvider>
  </MemoryRouter>
);
