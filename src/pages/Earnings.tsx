import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import MyEarnings from '../components/financePeople/MyEarnings';

/** Personal earnings are available to linked accounts without granting admin access. */
export default function Earnings() {
  const { dir, loc } = useLanguage();
  return <main dir={dir} className="mx-auto w-full max-w-5xl px-3 py-5 pb-28 sm:px-6">
    <Link to="/profile" className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
      <ArrowRight size={18} className={dir === 'ltr' ? 'rotate-180' : ''} />
      {loc('حسابي', 'My account')}
    </Link>
    <MyEarnings />
  </main>;
}
