/**
 * An edit that CREATES a conflict (text overflows, an essential leaves the
 * safe area, two things overlap) is not applied silently (spec §14). The
 * previous design stays on screen until the owner picks one of the real
 * options: the deterministic ones are computed by `resolveConflict`
 * (reduce the font to its floor, grow the box, shrink the product
 * uniformly), a re-layout by `rebuild`; the ones that need a person or
 * Claude say so. «Apply with the conflict» keeps the edit and leaves the
 * problem to the checks.
 */
import { Overlay } from '../ui/Overlay';
import { Button } from '../ui/Button';
import type { ConflictOption, LayoutConflict } from '../../../packages/creativeDoc/src/layout';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import { CONFLICT_TEXT, OPTION_TEXT, ROLE_TEXT, S } from './strings';
import { useText } from './shared';

export interface PendingConflict {
  candidate: CreativeDocument;
  conflicts: LayoutConflict[];
}

const AUTOMATIC: ReadonlySet<ConflictOption> = new Set(['reduce_font', 'grow_box', 'shrink_product', 'switch_density', 'switch_variant', 'revert']);

export default function ConflictsDialog({ pending, message, onOption, onKeep, onRevert }: {
  pending: PendingConflict | null;
  message: string;
  onOption(conflict: LayoutConflict, option: ConflictOption): void;
  onKeep(): void;
  onRevert(): void;
}) {
  const { w } = useText();
  return (
    <Overlay open={!!pending} onClose={onRevert} label={w(S.conflictsDialogTitle)} placement="center" testId="conflicts-dialog">
      {() => (
        <div className="flex max-w-lg flex-col gap-3 p-5">
          <h2 className="text-base font-bold text-text-primary">{w(S.conflictsDialogTitle)}</h2>
          <p className="text-sm text-text-secondary">{w(S.conflictsDialogBody)}</p>
          {pending!.conflicts.map((c, i) => (
            <section key={`${c.code}-${i}`} className="rounded-lg border border-border-subtle bg-surface p-3">
              <h3 className="text-sm font-semibold text-text-primary">{w(CONFLICT_TEXT[c.code])}</h3>
              <p className="mb-2 text-xs text-text-muted">{c.layer_ids.map((id) => {
                const l = pending!.candidate.layers.find((x) => x.id === id);
                return l ? w(ROLE_TEXT[l.role]) : id;
              }).join('، ')}</p>
              <div className="flex flex-wrap gap-2">
                {c.options.map((o) => AUTOMATIC.has(o) ? (
                  <Button key={o} size="sm" onClick={() => (o === 'revert' ? onRevert() : onOption(c, o))}>{w(OPTION_TEXT[o])}</Button>
                ) : (
                  <span key={o} className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs text-text-muted" title={w(S.conflictsOptionManual)}>
                    {w(OPTION_TEXT[o])} — {w(S.conflictsOptionManual)}
                  </span>
                ))}
              </div>
            </section>
          ))}
          {message ? <p className="text-sm text-warning" role="status">{message}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onRevert}>{w(OPTION_TEXT.revert)}</Button>
            <Button size="sm" variant="primary" onClick={onKeep}>{w(S.conflictsKeepAnyway)}</Button>
          </div>
        </div>
      )}
    </Overlay>
  );
}
