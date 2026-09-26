/**
 * A spec field whose value is a LIST drawn from fixed options — «مناسبة لـ»
 * (`use_cases`, worker/lib/templateFamilies.ts `multiple: true`).
 *
 * Stored as the options' own spelling, comma-separated and in the options'
 * order («Business, Products to sell»), which is exactly what the import sheet
 * accepts and writes (worker/lib/importCsv.ts checkSpecCell), so a TXT round
 * trip and a form save produce the same string. A stored item that is not an
 * option any more is kept, shown, and removable — never silently dropped.
 */
import * as T from '../theme';

export function readMulti(value: string): string[] {
  return value
    .split(/[,،;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function SpecMultiPick({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const picked = readMulti(value);
  const has = (o: string) => picked.some((p) => p.toLowerCase() === o.toLowerCase());
  const extra = picked.filter((p) => !options.some((o) => o.toLowerCase() === p.toLowerCase()));
  const write = (next: string[]) => {
    const known = options.filter((o) => next.some((n) => n.toLowerCase() === o.toLowerCase()));
    const unknown = next.filter((n) => !options.some((o) => o.toLowerCase() === n.toLowerCase()));
    onChange([...known, ...unknown].join(', '));
  };
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5" data-spec-multi={id}>
      {[...options, ...extra].map((o) => {
        const on = has(o);
        return (
          <button
            key={o}
            type="button"
            className={T.chip}
            aria-pressed={on}
            dir="ltr"
            onClick={() => write(on ? picked.filter((p) => p.toLowerCase() !== o.toLowerCase()) : [...picked, o])}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}
