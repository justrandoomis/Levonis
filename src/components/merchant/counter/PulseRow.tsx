/**
 * THE PULSE — Today's three-line health strip (merchant platform v2 §3.2):
 * whether the shop is open, whether its page is published, and (P4) how fast
 * it is for real customers. Each line is a DOOR to where it is changed, with
 * one dot for its tone and nothing else — the words carry the meaning.
 *
 * THE SPEED LINE (P4) is read from the attention's `speed` source, which the
 * server answers ONLY when the phone LCP p75 has been poor three days running
 * (worker/lib/storeSpeed.ts `speedAttention`): no source, no line — never a
 * guessed «جيدة». Its door is the builder's «السرعة» tab (`?tab=speed`).
 *
 * `Door` lives here because every Today surface needs the same thing: a link
 * that stays inside the workspace router when the address is a workspace
 * address, and becomes a plain anchor when the server sent a main-site path
 * (from a store's own subdomain that is another site — `ws.resolveLink`).
 */
import { useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useWorkspace, WorkspaceContext } from '../shell/context';
import type { Attention } from '../shell/attention';

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
 * The speed line's words, VERBATIM from src/components/merchant/storeDesign/
 * strings.ts (`SPEED_STRINGS.*.pulse.poor`; tests/workspaceUi.test.ts holds
 * the copy to the table). Copied, never imported: Today must not download the
 * builder's word table for one line.
 */
export const SPEED_PULSE_WORDS = {
  ar: 'سرعة الصفحة على الهاتف: ضعيفة',
  en: 'Page speed on phones: poor',
  ckb: 'خێرایی پەڕە لە مۆبایلدا: لاواز',
} as const;

/** The builder's «السرعة» tab: the server's link, asked to open on that tab (StoreDesignPanel reads `?tab=`). */
export function speedDoor(link: string): string {
  const hash = link.indexOf('#');
  const path = hash < 0 ? link : link.slice(0, hash);
  // A link that already names a tab is the server's own choice.
  if (/[?&]tab=/.test(path)) return link;
  return `${path}${path.includes('?') ? '&' : '?'}tab=speed${hash < 0 ? '' : link.slice(hash)}`;
}

/**
 * The Pulse's speed line from the attention read, or null when the source
 * did not answer — which, by the server's rule, is most of the time.
 */
export function speedPulseLine(speed: Attention['speed'] | null | undefined, lang: string): PulseLine | null {
  if (!speed || speed.grade !== 'poor' || typeof speed.link !== 'string' || !speed.link) return null;
  return { id: 'speed', tone: 'warning', text: SPEED_PULSE_WORDS[lang === 'en' || lang === 'ckb' ? lang : 'ar'], to: speedDoor(speed.link) };
}

/**
 * `speed` is P4's line: an explicit line wins; otherwise it is read from the
 * workspace's attention (`speed` source), and nothing renders without it.
 */
export default function PulseRow({ title, lines, speed = null }: { title: string; lines: PulseLine[]; speed?: PulseLine | null }) {
  const ws = useContext(WorkspaceContext);
  const { lang } = useLanguage();
  const speedLine = speed ?? speedPulseLine(ws?.attention.data?.speed, lang);
  const all = speedLine ? [...lines, speedLine] : lines;
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
