/**
 * Small pieces the catalogue screens share: the progressive-disclosure
 * section, the state chip, and the server-error → field-message mapping.
 */
import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { StatusChip } from '../../ui/Badge';
import { ApiError } from '../../../lib/api';
import type { CatalogProduct } from './catalogApi';
import { catalogRefusalText, fieldErrorText, stateTone, type CatalogStrings, type Loc } from './strings';

/**
 * A section that opens on demand — the editor shows the basics and keeps the
 * rest one tap away. `summary` says what is inside while it is closed, so a
 * merchant can see «3 variants» without opening it.
 */
export function Disclosure({
  title,
  summary,
  defaultOpen = false,
  forceOpen = false,
  children,
  testId,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Opened from outside — a field inside it has an error. */
  forceOpen?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const shown = open || forceOpen;
  return (
    <section className="rounded-2xl border border-border-subtle bg-surface-raised/40" data-disclosure={testId}>
      <h3>
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={id}
          onClick={() => setOpen(!shown)}
          className="flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold rounded-2xl"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-text-primary">{title}</span>
            {summary && !shown && <span className="mt-0.5 block truncate text-[12px] text-text-muted">{summary}</span>}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-text-muted motion-safe:transition-transform ${shown ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </h3>
      {shown && (
        <div id={id} className="space-y-4 px-4 pb-4">
          {children}
        </div>
      )}
    </section>
  );
}

export function StateChip({ p, s }: { p: Pick<CatalogProduct, 'state' | 'moderation' | 'sold_out' | 'track_stock' | 'price_required'>; s: CatalogStrings }) {
  const admin = !!p.moderation?.hidden_by_admin;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusChip tone={stateTone(p.state, admin)}>{admin ? s.hiddenByAdmin : s.state(p.state)}</StatusChip>
      {p.state === 'published' && !admin && p.sold_out && <StatusChip tone="warning">{s.soldOut}</StatusChip>}
      {p.state === 'published' && !admin && p.price_required && <StatusChip tone="danger">{s.priceRequired}</StatusChip>}
    </span>
  );
}

/**
 * A refusal, split: field messages by path (PRODUCT_INVALID lists every
 * wrong field) and one sentence for the rest.
 */
export function readRefusal(e: unknown, loc: Loc, fallback: string): { fields: Record<string, string>; message: string } {
  if (!(e instanceof ApiError)) return { fields: {}, message: fallback };
  const list = (e.details as { errors?: Array<{ path: string; code: string }> } | undefined)?.errors;
  if (e.code === 'PRODUCT_INVALID' && Array.isArray(list)) {
    const fields: Record<string, string> = {};
    for (const x of list) if (!fields[x.path]) fields[x.path] = fieldErrorText(x.code, loc);
    return { fields, message: '' };
  }
  if (e.code === 'STOCK_REQUIRED') return { fields: { stock: fieldErrorText('STOCK_REQUIRED', loc) }, message: '' };
  if (e.code === 'MEDIA_NOT_OWNED') return { fields: { media: fieldErrorText('MEDIA_NOT_OWNED', loc) }, message: '' };
  return { fields: {}, message: catalogRefusalText(e.code, loc, e.message || fallback) };
}
