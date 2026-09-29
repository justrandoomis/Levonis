/**
 * «المشاريع» — the whole community's projects, in the same grid as
 * /community/projects (src/pages/community/Projects.tsx ProjectsGrid), with
 * the kind chips and the chosen tag in the URL (`?kind=`, `?tag=`) beside the
 * home's `?tab=` and `?q=`. A lazy tab: the grid's chunk is downloaded when
 * the tab is opened, not with the issue.
 */
import { useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { ProjectsGrid } from '../../../pages/community/Projects';
import { POST_KINDS, type PostKind } from '../projects/api';
import { useProjectStrings } from '../projects/strings';
import { useHubStrings } from './strings';

export default function ProjectsPanel({ q }: { q: string }) {
  const ps = useProjectStrings();
  const s = useHubStrings();
  const [params, setParams] = useSearchParams();
  const kindRaw = params.get('kind') ?? '';
  const kind = (POST_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as PostKind) : '';
  const tag = (params.get('tag') ?? '').trim().slice(0, 30);

  const setParam = (k: string, v: string) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (v) p.set(k, v);
      else p.delete(k);
      return p;
    });

  const clear = () =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete('kind');
      p.delete('tag');
      return p;
    });

  return (
    <div data-community-panel="projects" className="flex flex-col gap-4">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 hide-scrollbar" role="group" aria-label={s.kind}>
        <button type="button" className="lv-choice shrink-0 px-3" aria-pressed={kind === ''} onClick={() => setParam('kind', '')}>
          {s.all}
        </button>
        {POST_KINDS.map((k) => (
          <button key={k} type="button" className="lv-choice shrink-0 px-3" aria-pressed={kind === k} onClick={() => setParam('kind', kind === k ? '' : k)}>
            {ps.kinds[k]}
          </button>
        ))}
        {tag && (
          <button type="button" className="lv-choice shrink-0 gap-1 px-3" aria-pressed onClick={() => setParam('tag', '')} aria-label={`${s.tags}: ${tag}`}>
            #{tag}
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
        {(kind || tag) && (
          <button type="button" className="lv-button lv-button-ghost lv-button-sm shrink-0" onClick={clear}>
            {s.clearFilters}
          </button>
        )}
      </div>
      <ProjectsGrid filters={{ kind, tag, q }} />
    </div>
  );
}
