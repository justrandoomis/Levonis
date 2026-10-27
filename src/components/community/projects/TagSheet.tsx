/**
 * «وسوم» — the tag picker of the projects list (community UI plan C2.1). A
 * lazy chunk, fetched the first time the chip is pressed: the trending tags
 * (the five-minute memo of /api/community/trending, shared with the search
 * overlay) narrowed by what is typed, plus «استخدم #…» for a tag of the
 * viewer's own. Picking one closes the sheet; the Sheet hands focus back to
 * the chip.
 */
import { useEffect, useState } from 'react';
import { Hash } from 'lucide-react';
import { Sheet } from '../../ui/Sheet';
import { SearchField } from '../kit/fields';
import { searchApi, type TrendingTag } from '../search/api';
import { useProjectStrings } from './strings';

/** A tag as the server stores it: no «#», trimmed, at most 30 characters. */
export const cleanTag = (raw: string) => raw.replace(/^#+/, '').trim().slice(0, 30);

const ROW =
  'flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-start text-[15px] text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

export default function TagSheet({ open, current, onPick, onClose }: { open: boolean; current: string; onPick: (tag: string) => void; onClose: () => void }) {
  const s = useProjectStrings();
  const [tags, setTags] = useState<TrendingTag[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    setQ('');
    let alive = true;
    searchApi
      .trending()
      .then((t) => alive && setTags(t.tags))
      .catch(() => alive && setTags([]));
    return () => {
      alive = false;
    };
  }, [open]);

  const typed = cleanTag(q);
  const needle = typed.toLowerCase();
  const shown = (tags ?? []).filter((t) => !needle || t.tag.toLowerCase().includes(needle));
  const exact = shown.some((t) => t.tag.toLowerCase() === needle);
  const pick = (tag: string) => {
    onPick(tag);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={s.tags}
      detents={['medium', 'large']}
      dragHandle
      testId="projects-tag-sheet"
      header={
        <div className="flex flex-col gap-3 px-4 pb-2 pt-1">
          <h2 className="text-[17px] font-bold text-text-primary">{s.tags}</h2>
          <SearchField
            label={s.searchTags}
            placeholder={s.searchTags}
            value={q}
            onValueChange={setQ}
            maxLength={31}
            enterKeyHint="done"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed) {
                e.preventDefault();
                pick(typed);
              }
            }}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-1 px-2 pb-4" data-projects-tags>
        {typed && !exact && (
          <button type="button" className={ROW} onClick={() => pick(typed)} data-projects-tag-typed>
            <Hash aria-hidden="true" className="h-4 w-4 shrink-0 text-gold" />
            <bdi>{s.useTag(typed)}</bdi>
          </button>
        )}
        {tags && !needle && shown.length > 0 && <h3 className="px-3 pt-2 text-[13px] font-bold text-text-secondary">{s.trendingTags}</h3>}
        {shown.map((t) => (
          <button key={t.tag} type="button" className={ROW} aria-pressed={t.tag === current} onClick={() => pick(t.tag)} data-projects-tag={t.tag}>
            <Hash aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            <bdi className="min-w-0 flex-1 truncate">{t.tag}</bdi>
            <span className="text-[12px] tabular-nums text-text-muted">{t.count}</span>
          </button>
        ))}
        {tags && shown.length === 0 && !typed && <p className="px-3 py-4 text-[14px] text-text-muted">{s.noTags}</p>}
        {!tags && <div className="h-24" aria-hidden="true" />}
      </div>
    </Sheet>
  );
}
