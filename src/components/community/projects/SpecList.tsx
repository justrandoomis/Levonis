/**
 * THE FACTS OF A PRINT — printer, material, colour, time, size, settings —
 * as a definition list: the term in the quiet column, the value beside it,
 * a link where the value is a catalogue product. Only the facts the maker
 * gave are rows; an empty list renders nothing.
 */
import { Link } from 'react-router-dom';
import type { Post } from './api';
import { dimensionsLabel, printTimeLabel, useProjectStrings } from './strings';
import { useLanguage } from '../../../LanguageContext';
import { productName } from '../../../lib/productText';

export default function SpecList({ post: p }: { post: Post }) {
  const s = useProjectStrings();
  const { lang } = useLanguage();
  const rows: Array<{ k: string; v: React.ReactNode }> = [];
  const printer = p.printer.product ? productName(p.printer.product, lang) : p.printer.name;
  const material = p.material.product ? productName(p.material.product, lang) : p.material.name;
  if (printer) rows.push({ k: s.printer, v: p.printer.product ? <SpecLink to={p.printer.product.url}>{printer}</SpecLink> : printer });
  if (material) rows.push({ k: s.material, v: p.material.product ? <SpecLink to={p.material.product.url}>{material}</SpecLink> : material });
  if (p.color) rows.push({ k: s.color, v: p.color });
  if (p.print_time_minutes) rows.push({ k: s.printTime, v: <span className="tabular-nums">{printTimeLabel(p.print_time_minutes, s)}</span> });
  const size = dimensionsLabel(p.dimensions, s);
  if (size) rows.push({ k: s.size, v: <span dir="ltr" className="tabular-nums">{size}</span> });
  const st = p.print_settings;
  const settings: string[] = [];
  if (typeof st.layer_height_mm === 'number') settings.push(`${s.layerHeight} ${st.layer_height_mm} ${s.mm}`);
  if (typeof st.infill_percent === 'number') settings.push(`${s.infill} ${st.infill_percent}%`);
  if (typeof st.nozzle_mm === 'number') settings.push(`${s.nozzle} ${st.nozzle_mm} ${s.mm}`);
  if (typeof st.supports === 'boolean') settings.push(st.supports ? s.withSupports : s.noSupports);
  if (settings.length) {
    rows.push({
      k: s.settings,
      v: (
        <span className="flex flex-wrap gap-1.5">
          {settings.map((x) => (
            <span key={x} className="rounded-full bg-surface px-2 py-0.5 text-[12px] tabular-nums text-text-secondary">
              {x}
            </span>
          ))}
        </span>
      ),
    });
  }
  if (rows.length === 0) return null;
  return (
    <dl data-project-specs className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13.5px]">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="text-text-muted">{r.k}</dt>
          <dd dir="auto" className="min-w-0 text-start text-text-primary">
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SpecLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="font-medium text-text-primary underline decoration-border-subtle underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded">
      {children}
    </Link>
  );
}
