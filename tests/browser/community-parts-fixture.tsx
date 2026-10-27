/**
 * THE SHARED COMMUNITY PARTS IN A BROWSER (community UI plan B2): the section
 * page header, the request card in its four variants, the follow button and
 * the like and save marks, in every state, inside the community scope, so they
 * can be photographed in both themes and paired with the references
 * (IMG_8476 and IMG_8469 headers, IMG_8487 and IMG_8483 request rows).
 *
 *   /tests/browser/community-parts.html?theme=dark|light&lang=ar|en|ckb[&part=header|rows|list|aside|owner|follow|marks]
 *
 * `part` shows one block alone, so a first-screen shot pairs with its reference.
 * A browser fixture, never an app route. Only utilities that already exist in
 * the app are used: Tailwind scans this folder too, and a fixture must not
 * grow the store stylesheet. The sections menu itself is photographed on the
 * real section pages (/community/stores), where its door lives.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Bookmark, Heart } from 'lucide-react';
import { LanguageProvider, useLanguage } from '../../src/LanguageContext';
import { AuthProvider } from '../../src/AuthContext';
import CommunitySurface from '../../src/components/community/CommunitySurface';
import SectionPageHeader, { SectionsButton } from '../../src/components/community/kit/SectionPageHeader';
import FollowButton from '../../src/components/community/kit/FollowButton';
import RequestListCard, { type OwnerRequestCard, type PublicRequestCard } from '../../src/components/community/requests/RequestListCard';
import CountToggle from '../../src/components/community/social/CountToggle';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const langParam = params.get('lang');
const lang = langParam === 'en' ? 'en' : langParam === 'ckb' ? 'ckb' : 'ar';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', theme);

const part = params.get('part');
const shows = (name: string) => !part || part === name;

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const BRACKET: PublicRequestCard = { id: 'rq_bracket', title: 'حامل تثبيت للحائط', quantity: 4, material: 'PETG', governorate: 'baghdad', state: 'receiving_offers', offer_count: 3, file_count: 2, deadline: soon(9) };
const ARCH: PublicRequestCard = { id: 'rq_arch', title: 'مجسّم معماري', quantity: 1, material: 'PLA', governorate: 'erbil', state: 'open', offer_count: 2, file_count: 3, deadline: null };
const GEARS: PublicRequestCard = { id: 'rq_gears', title: 'قطع صغيرة دقيقة', quantity: 2, material: 'Standard Resin', governorate: 'basra', state: 'open', offer_count: 0, file_count: 1, deadline: null, summary: { parts_count: 2, pieces_per_set: 5 } };
const WORDS: PublicRequestCard = { id: 'rq_words', title: 'مزهرية بتصميم خاص', quantity: 1, material: '', governorate: 'baghdad', state: 'open', offer_count: 1, file_count: 0, deadline: soon(20) };
const MINE: OwnerRequestCard = { ...BRACKET, id: 'rq_mine', budget_iqd: 45000, budget_visible: false, estimate_low_iqd: 38000, estimate_high_iqd: 52000 };
const MINE_SHOWN: OwnerRequestCard = { ...GEARS, id: 'rq_mine2', state: 'in_progress', budget_iqd: 30000, budget_visible: true, accepted_merchant: 'ورشة بغداد' };

function Parts() {
  const { loc } = useLanguage();
  const never = () => new Promise<{ on: boolean; count: number }>(() => {});
  return (
    <CommunitySurface className="min-h-screen w-full pb-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4" data-parts>
        {shows('header') && (
          <section data-part="header">
            <SectionPageHeader title={loc('المتاجر', 'Stores', 'فرۆشگاکان')} trailing={<SectionsButton />} />
            <SectionPageHeader title={loc('الصنّاع', 'Makers', 'دروستکەران')} kicker />
          </section>
        )}

        {shows('rows') && (
          <section data-part="rows" className="flex flex-col gap-3 pt-4">
            <RequestListCard variant="row" request={BRACKET} />
            <RequestListCard variant="row" request={ARCH} />
            <RequestListCard variant="row" request={GEARS} />
          </section>
        )}

        {shows('list') && (
          <section data-part="list" className="grid grid-cols-1 gap-3 pt-4 md:grid-cols-2">
            <RequestListCard variant="list" request={BRACKET} />
            <RequestListCard variant="list" request={ARCH} />
            <RequestListCard variant="list" request={GEARS} />
            <RequestListCard variant="list" request={WORDS} />
          </section>
        )}

        {shows('aside') && (
          <section data-part="aside" className="cm-card flex max-w-[360px] flex-col gap-1 rounded-xl p-3 shadow-sm">
            <RequestListCard variant="aside" request={BRACKET} />
            <RequestListCard variant="aside" request={ARCH} />
          </section>
        )}

        {shows('owner') && (
          <section data-part="owner" className="grid grid-cols-1 gap-3 pt-4 md:grid-cols-2">
            <RequestListCard variant="owner" request={MINE} onRepeat={() => {}} />
            <RequestListCard variant="owner" request={MINE_SHOWN} chips={[loc('تحتاج مراجعة فنية', 'Needs a technical review', 'پێویستی بە پێداچوونەوەی تەکنیکی هەیە')]} onRepeat={() => {}} />
          </section>
        )}

        {shows('follow') && (
          <section data-part="follow" className="cm-card flex flex-wrap items-center gap-3 rounded-xl p-3 shadow-sm">
            <FollowButton following={false} onToggle={() => {}} size="sm" />
            <FollowButton following={false} onToggle={() => {}} size="sm" tone="gold" />
            <FollowButton following onToggle={() => {}} size="sm" />
            <FollowButton following={false} onToggle={() => {}} />
            <FollowButton following={false} onToggle={() => {}} tone="gold" />
            <FollowButton following onToggle={() => {}} />
            <FollowButton following={false} busy onToggle={() => {}} />
          </section>
        )}

        {shows('marks') && (
          <section data-part="marks" className="cm-card flex flex-wrap items-center gap-3 rounded-xl p-3 shadow-sm">
            {[false, true].map((on) => (
              <CountToggle key={`like-${on}`} on={on} count={24} tone="like" labelOn="unlike" labelOff="like" countLabel={(n) => `${n}`} icon={(_, cls) => <Heart className={cls} />} toggle={never} failText="" data-social="like" />
            ))}
            {[false, true].map((on) => (
              <CountToggle key={`save-${on}`} on={on} count={0} labelOn="unsave" labelOff="save" countLabel={(n) => `${n}`} icon={(_, cls) => <Bookmark className={cls} />} toggle={never} failText="" data-social="save" />
            ))}
          </section>
        )}
      </div>
    </CommunitySurface>
  );
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <LanguageProvider>
      <AuthProvider>
        <Parts />
      </AuthProvider>
    </LanguageProvider>
  </MemoryRouter>
);
