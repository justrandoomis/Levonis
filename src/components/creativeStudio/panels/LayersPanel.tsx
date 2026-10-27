/**
 * «الطبقات» — every layer, topmost first, by its ROLE in the ad (in the
 * reader’s language) and its name. Hide, lock and reorder are operations
 * (`set_visibility`, `set_lock`, `reorder_layer`), so they are undoable and
 * meet the same rules as everything else: the background stays at the
 * bottom, a locked layer refuses every change but being unlocked.
 *
 * A click on a row selects what a click on the canvas would (a chip's group),
 * except on a LOCKED row: that selects the layer itself, so its lock can be
 * seen and lifted — never its group, which would carry the locked layer along
 * in a move or a delete.
 */
import { ChevronDown, ChevronUp, Eye, EyeOff, Lock, Unlock } from 'lucide-react';
import { IconButton } from '../../ui/Button';
import type { Layer } from '../../../../packages/creativeDoc/src/schema';
import type { EditorApi } from '../editorApi';
import { selectableId } from '../editorModel';
import { ROLE_TEXT, S, fill } from '../strings';
import { useText } from '../shared';

function depthOf(layers: readonly Layer[], l: Layer): number {
  let d = 0;
  let p = l.parent;
  const seen = new Set<string>();
  while (p && !seen.has(p) && d < 6) {
    seen.add(p);
    d++;
    p = layers.find((x) => x.id === p)?.parent ?? null;
  }
  return d;
}

export default function LayersPanel({ api }: { api: EditorApi }) {
  const { w } = useText();
  const { doc, selection } = api;
  const rows = doc.layers.slice().reverse();
  return (
    <ul className="flex flex-col gap-1" aria-label={w(S.panelLayers)} data-layers-panel>
      {rows.map((l) => {
        const target = l.locked ? l.id : selectableId(doc, l.id);
        const sel = selection.includes(l.id) || selection.includes(selectableId(doc, l.id));
        const name = l.name && l.name !== l.id ? l.name : w(ROLE_TEXT[l.role]);
        const isBg = l.role === 'background';
        // What the layer SHOWS (its words), and its state — never an internal id.
        const detail = [l.type === 'text' ? l.text.slice(0, 48) : '', l.locked ? w(S.layerLocked) : '', !l.visible ? w(S.layerHidden) : ''].filter(Boolean).join(' · ');
        return (
          <li key={l.id} className={`flex items-center gap-1 rounded-lg ${sel ? 'bg-surface-raised' : ''}`} style={{ paddingInlineStart: depthOf(doc.layers, l) * 14 }} data-layer-row={l.id}>
            <button
              type="button"
              className="min-h-11 min-w-0 flex-1 rounded-lg px-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              aria-pressed={sel}
              onClick={() => !isBg && api.setSelection([target])}
            >
              <span className="block truncate text-sm text-text-primary">{w(ROLE_TEXT[l.role])}</span>
              {detail ? <span className="block truncate text-xs text-text-muted" dir="auto">{detail}</span> : null}
            </button>
            <IconButton
              label={fill(`${w(l.visible ? S.layerHide : S.layerShow)} — {n}`, { n: name })}
              icon={l.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              disabled={l.locked}
              onClick={() => api.apply([{ op: 'set_visibility', layer_id: l.id, visible: !l.visible }])}
            />
            <IconButton
              label={fill(`${w(l.locked ? S.layerUnlock : S.layerLock)} — {n}`, { n: name })}
              icon={l.locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
              disabled={isBg}
              onClick={() => api.apply([{ op: 'set_lock', layer_id: l.id, locked: !l.locked }])}
            />
            {sel && !isBg && l.parent === null ? (
              <>
                <IconButton label={fill(`${w(S.layerForward)} — {n}`, { n: name })} icon={<ChevronUp className="h-4 w-4" />} disabled={l.locked} onClick={() => api.apply([{ op: 'reorder_layer', layer_id: l.id, to: 'forward' }])} />
                <IconButton label={fill(`${w(S.layerBackward)} — {n}`, { n: name })} icon={<ChevronDown className="h-4 w-4" />} disabled={l.locked} onClick={() => api.apply([{ op: 'reorder_layer', layer_id: l.id, to: 'backward' }])} />
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
