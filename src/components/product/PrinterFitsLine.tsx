import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';

/** A printer this part fits, as `GET /api/products/:slug` names it (0148). */
export interface FitPrinterRef {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ckb: string;
}

/**
 * «يناسب: A1 · A1 mini · A2L» — THE PRINTERS A PART FITS, under its title.
 *
 * The owner linked the part to these printers (worker/lib/printerFits.ts); a
 * buyer of a nozzle asks «will it fit mine?» before anything else, so the
 * answer sits with the product's other facts above the fold, each printer one
 * tap from its own page. Neutral chips, in the style of the brand chip beside
 * them — a fact, not a call to action. Only published printers are sent.
 */
export default function PrinterFitsLine({ printers }: { printers: readonly FitPrinterRef[] }) {
  const { lang, loc } = useLanguage();
  if (printers.length === 0) return null;
  const nameOf = (p: FitPrinterRef) =>
    lang === 'en' ? p.name || p.name_ar : lang === 'ckb' ? p.name_ckb || p.name_ar || p.name : p.name_ar || p.name;
  // OWNER: Sorani to be written by hand («يناسب»).
  return (
    <div data-product-fits className="mt-3 flex items-center gap-x-2 gap-y-1.5 flex-wrap">
      <span className="text-zinc-400 text-[12px] leading-normal">{loc('يناسب', 'Fits')}</span>
      {printers.map((p) => (
        <Link
          key={p.id}
          to={`/product/${encodeURIComponent(p.slug)}`}
          data-fit-printer={p.slug}
          className="border border-zinc-700 rounded-full px-2.5 py-1 text-[11px] leading-normal text-zinc-300 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <bdi>{nameOf(p)}</bdi>
        </Link>
      ))}
    </div>
  );
}
