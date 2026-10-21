/**
 * «ما يراه الآخرون» (plan P1-06, docs/DECISIONS.md row 268;
 * `17.public-private-preview`): before anything is published or sent, what
 * becomes public, what only the merchants the request is meant for read,
 * what waits for the accepted merchant, and what stays private.
 *
 * On the page it is one plain line — «رقمك وعنوانك وميزانيتك لا تظهر للعموم
 * أبدًا» — with «اعرض التفاصيل» (design critique 19: counts mean nothing to a
 * customer); in the review it opens by itself. The rows are `audience.ts`,
 * read from the contract registries.
 */
import { useId, useState } from 'react';
import { ChevronDown, Eye } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { groupLabel, groupedRows } from './audience';
import type { EditorState } from './state';
import type { EditorStrings } from './strings';

export function AudiencePanel({ state, t, open: openInitially = false }: { state: EditorState; t: EditorStrings; open?: boolean }) {
  const [open, setOpen] = useState(openInitially);
  const id = useId();
  const direct = !!state.direct;
  const groups = groupedRows(state);
  return (
    <section className="lv-surface px-3 py-3" aria-labelledby={`${id}-t`} data-editor-audience={open ? 'open' : 'closed'}>
      <div className="flex items-start gap-2">
        <Eye aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-t`} className="text-[14px] font-bold text-text-primary">
            {t.panelTitle}
          </h3>
          <p className="mt-0.5 text-[12.5px] text-text-secondary">{t.panelLine}</p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1"
        aria-expanded={open}
        aria-controls={`${id}-p`}
        onClick={() => setOpen((v) => !v)}
        data-editor="audience-toggle"
      >
        <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
        {open ? t.panelClose : t.panelOpen}
      </Button>
      {open && (
        <div id={`${id}-p`} className="mt-2 space-y-3">
          <p className="text-[12.5px] text-text-muted">{direct ? t.panelIntroDirect : t.panelIntro}</p>
          {groups.map(({ group, rows }) => (
            <div key={group} data-audience-group={group}>
              <h4 className="text-[12.5px] font-semibold text-text-secondary">{t[groupLabel(group, direct)]}</h4>
              <ul className="mt-1 space-y-0.5">
                {rows.map((r) => (
                  <li key={r.key} className="flex gap-2 text-[13px] text-text-primary" data-audience-row={r.key}>
                    <span aria-hidden="true" className="text-text-muted">
                      •
                    </span>
                    <span>{t[r.label]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
