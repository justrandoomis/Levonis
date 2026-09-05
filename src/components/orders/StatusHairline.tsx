/**
 * The order card's one signature: a hairline along its top edge, gold for
 * the fraction of the path the order has walked. Nothing else on the card
 * moves or glows — the line is the whole status story at a glance, and the
 * pill beside it names the same fact in words for anyone who needs them.
 *
 * It grows from the inline-start edge, so in Arabic it fills from the right
 * like the text it sits above. Decorative: the pill carries the meaning for
 * assistive tech.
 */
import type { OrderStageProgress } from '../../lib/api';

export default function StatusHairline({
  progress,
  cancelled = false,
}: {
  progress?: OrderStageProgress | null;
  cancelled?: boolean;
}) {
  const total = progress && progress.total > 0 ? progress.total : 0;
  const pct = cancelled ? 100 : total > 0 ? Math.min(100, Math.max(0, (progress!.index / total) * 100)) : 0;
  return (
    <div aria-hidden="true" data-status-hairline className="absolute inset-x-0 top-0 flex h-px bg-zinc-800/70">
      <span
        className={`block h-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${
          cancelled ? 'bg-red-500/45' : 'bg-[#BAA369]'
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
