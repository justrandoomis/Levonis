/**
 * THE PULSE — Today's three-line health strip (merchant platform v2 §3.2):
 * whether the shop is open, whether its page is published, and (P4) how fast
 * it is for real customers. Each line is a DOOR to where it is changed, with
 * one dot for its tone and nothing else — the words carry the meaning.
 *
 * `Door` lives here because every Today surface needs the same thing: a link
 * that stays inside the workspace router when the address is a workspace
 * address, and becomes a plain anchor when the server sent a main-site path
 * (from a store's own subdomain that is another site — `ws.resolveLink`).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useWorkspace } from '../shell/context';

export function Door({ to, className, children, ...rest }: { to: string; className: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const ws = useWorkspace();
  const target = ws.resolveLink(to);
  return target.internal ? (
    <Link to={target.to} className={className} {...rest}>
      {children}
    </Link>
  ) : (
    <a href={target.to} className={className} {...rest}>
      {children}
    </a>
  );
}

export interface PulseLine {
  id: string;
  tone: 'success' | 'warning';
  text: string;
  to: string;
}

const DOT: Record<PulseLine['tone'], string> = { success: 'bg-success', warning: 'bg-warning' };

/**
 * `speed` is P4's line (the real-user speed grade, only with ≥ 50 samples):
 * typed now so the slot exists, rendered as nothing until the source does.
 */
export default function PulseRow({ title, lines, speed = null }: { title: string; lines: PulseLine[]; speed?: PulseLine | null }) {
  const all = speed ? [...lines, speed] : lines;
  if (all.length === 0) return null;
  return (
    <section aria-label={title} data-pulse>
      <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
        {all.map((l) => (
          <li key={l.id} data-pulse-line={l.id} data-tone={l.tone}>
            <Door
              to={l.to}
              className="flex min-h-12 items-center gap-3 px-4 text-[13.5px] text-text-primary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
            >
              <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[l.tone]}`} />
              <span className="min-w-0 flex-1 truncate">{l.text}</span>
              <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted rtl:-scale-x-100" />
            </Door>
          </li>
        ))}
      </ul>
    </section>
  );
}
