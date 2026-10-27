/**
 * «الخصائص» — exact values for the selection, in document pixels.
 *
 * Every field commits through an operation (move_layer, set_font_size,
 * scale_asset_uniform with ONE factor, resize_box, set_color from the brand
 * palette only, set_alignment, rotate_layer), so a typed number meets the
 * same refusals as a drag: below the readable floor, outside the palette, a
 * rotated product, a locked layer. A bound text (price, availability,
 * product name, a service claim) says why it cannot be typed into.
 */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Field, Input, Textarea } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { layerBox, type ImageLayer, type Layer, type TextAlign } from '../../../../packages/creativeDoc/src/schema';
import type { EditorApi } from '../editorApi';
import { lockedAround, topLevel } from '../editorModel';
import { ROLE_TEXT, S, fill } from '../strings';
import { useText } from '../shared';
import VariantImg from '../../ui/VariantImg';

/** A number field that commits on Enter or when it loses focus — never on every keystroke. */
function NumberField({ label, value, onCommit, step = 1, min, max, hint, disabled }: { label: string; value: number; onCommit: (n: number) => void; step?: number; min?: number; max?: number; hint?: string; disabled?: boolean }) {
  const shown = Math.round(value * 100) / 100;
  const [text, setText] = useState(String(shown));
  useEffect(() => setText(String(shown)), [shown]);
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    if (!Number.isFinite(n) || n === shown) {
      setText(String(shown));
      return;
    }
    onCommit(n);
  };
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        inputMode="decimal"
        ltr
        step={step}
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </Field>
  );
}

function Swatches({ api, layer, current }: { api: EditorApi; layer: Layer; current: string | null }) {
  const { w } = useText();
  const palette = api.data.brand.kit.colors.palette;
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-semibold text-text-secondary">{w(S.propColor)}</legend>
      <div className="flex flex-wrap gap-1">
        {palette.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={fill(w(S.propColorSwatch), { hex })}
            aria-pressed={current === hex}
            title={hex}
            onClick={() => api.apply([{ op: 'set_color', layer_id: layer.id, color: hex }])}
            className="h-11 w-11 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            style={{ background: hex, boxShadow: current === hex ? 'inset 0 0 0 3px #3b82f6' : 'inset 0 0 0 1px rgba(127,127,127,0.5)' }}
          />
        ))}
      </div>
    </fieldset>
  );
}

export default function PropertiesPanel({ api }: { api: EditorApi }) {
  const { w } = useText();
  const { doc, selection } = api;
  const ids = topLevel(doc, selection);
  if (!ids.length) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted" data-properties-empty>{w(S.propNothing)}</p>
        <PostText api={api} />
      </div>
    );
  }
  if (ids.length > 1) {
    const names = ids.map((id) => doc.layers.find((l) => l.id === id)).filter((l): l is Layer => !!l).map((l) => w(ROLE_TEXT[l.role]));
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-primary">{fill(w(S.propMany), { n: ids.length })}</p>
        <p className="text-xs text-text-muted">{names.join('، ')}</p>
      </div>
    );
  }
  const layer = doc.layers.find((l) => l.id === ids[0]);
  if (!layer) return null;
  const box = layerBox(layer, doc.layers);
  // A lock on the layer, on its group or on anything inside it holds the whole selection.
  const locked = lockedAround(doc, layer.id);
  const name = layer.name && layer.name !== layer.id ? layer.name : w(ROLE_TEXT[layer.role]);
  return (
    <div className="flex flex-col gap-3" data-properties={layer.id}>
      <div>
        <p className="text-sm font-semibold text-text-primary">{w(ROLE_TEXT[layer.role])}</p>
        <p className="text-xs text-text-muted">{name}</p>
      </div>
      {locked ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text-secondary">{w(S.propLockedNote)}</p>
          {layer.locked && layer.role !== 'background' ? <Button size="sm" onClick={() => api.apply([{ op: 'set_lock', layer_id: layer.id, locked: false }])}>{w(S.layerUnlock)}</Button> : null}
        </div>
      ) : (
        <>
          {box ? (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label={w(S.propX)} value={box.x} onCommit={(x) => api.apply([{ op: 'move_layer', layer_id: layer.id, x, y: box.y }])} />
              <NumberField label={w(S.propY)} value={box.y} onCommit={(y) => api.apply([{ op: 'move_layer', layer_id: layer.id, x: box.x, y }])} />
            </div>
          ) : null}
          {layer.type === 'text' ? <TextProps api={api} layer={layer} /> : null}
          {layer.type === 'image' ? <ImageProps api={api} layer={layer} /> : null}
          {layer.type === 'shape' ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label={w(S.propW)} value={layer.width} min={1} onCommit={(v) => api.apply([{ op: 'resize_box', layer_id: layer.id, width: v, height: layer.height }])} />
                <NumberField label={w(S.propH)} value={layer.height} min={1} onCommit={(v) => api.apply([{ op: 'resize_box', layer_id: layer.id, width: layer.width, height: v }])} />
              </div>
              {layer.role !== 'product_shadow' ? <Swatches api={api} layer={layer} current={layer.fill} /> : null}
            </>
          ) : null}
          {layer.type !== 'group' && layer.role !== 'product' && layer.role !== 'background' ? (
            <NumberField label={w(S.propRotation)} value={layer.rotation} min={-360} max={360} onCommit={(r) => api.apply([{ op: 'rotate_layer', layer_id: layer.id, rotation: r }])} />
          ) : null}
          {layer.role !== 'background' ? (
            <Button size="sm" variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => { if (api.apply([{ op: 'delete_layer', layer_id: layer.id }])) api.setSelection([]); }}>
              {w(S.propDelete)}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The words that go WITH the picture, not in it (spec §20): the caption and
 * the alt text, committed when the field is left (`set_caption`,
 * `set_alt_text`) so they share undo and the save path with the design.
 */
export function PostText({ api }: { api: EditorApi }) {
  const { w } = useText();
  const [caption, setCaption] = useState(api.doc.caption);
  const [alt, setAlt] = useState(api.doc.alt_text);
  useEffect(() => setCaption(api.doc.caption), [api.doc.caption]);
  useEffect(() => setAlt(api.doc.alt_text), [api.doc.alt_text]);
  return (
    <section className="flex flex-col gap-2" data-post-text>
      <h3 className="text-sm font-semibold text-text-secondary">{w(S.postText)}</h3>
      <p className="text-xs text-text-muted">{w(S.postTextHint)}</p>
      <Field label={w(S.caption)}>
        <Textarea rows={4} value={caption} maxLength={2200} dir="auto" onChange={(e) => setCaption(e.target.value)} onBlur={() => caption !== api.doc.caption && api.apply([{ op: 'set_caption', value: caption }])} />
      </Field>
      <Field label={w(S.altText)}>
        <Input value={alt} maxLength={420} dir="auto" onChange={(e) => setAlt(e.target.value)} onBlur={() => alt !== api.doc.alt_text && api.apply([{ op: 'set_alt_text', value: alt }])} />
      </Field>
    </section>
  );
}

function TextProps({ api, layer }: { api: EditorApi; layer: Extract<Layer, { type: 'text' }> }) {
  const { w } = useText();
  const bound = layer.source.kind !== 'free';
  const source = layer.source.kind === 'product' ? w(S.propBoundProduct) : layer.source.kind === 'service' ? w(S.propBoundService) : w(S.propBoundSlide);
  const aligns: Array<{ id: TextAlign; label: string }> = [
    { id: 'start', label: w(S.alignStart) },
    { id: 'center', label: w(S.alignCenter) },
    { id: 'end', label: w(S.alignEnd) },
  ];
  return (
    <>
      {bound ? (
        <p className="rounded-lg border border-border-subtle bg-surface p-2 text-xs leading-relaxed text-text-secondary" data-bound-note>{fill(w(S.propBound), { source })}</p>
      ) : (
        <Button size="sm" onClick={() => api.editText(layer.id)}>{w(S.propEditText)}</Button>
      )}
      <NumberField
        label={w(S.propFontSize)}
        value={layer.font.size}
        min={layer.minSize}
        hint={fill(w(S.propMinSize), { n: layer.minSize })}
        onCommit={(size) => api.apply([{ op: 'set_font_size', layer_id: layer.id, size }])}
      />
      <Segmented
        label={w(S.propAlign)}
        group={`align-${layer.id}`}
        size="sm"
        value={layer.align}
        items={aligns}
        onChange={(id) => api.apply([{ op: 'set_alignment', layer_id: layer.id, align: id }])}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={w(S.propW)} value={layer.width} min={8} onCommit={(v) => api.apply([{ op: 'resize_box', layer_id: layer.id, width: v, height: layer.height }])} />
        <NumberField label={w(S.propH)} value={layer.height} min={8} onCommit={(v) => api.apply([{ op: 'resize_box', layer_id: layer.id, width: layer.width, height: v }])} />
      </div>
      <Swatches api={api} layer={layer} current={layer.color} />
    </>
  );
}

function ImageProps({ api, layer }: { api: EditorApi; layer: ImageLayer }) {
  const { w } = useText();
  const slot = layer.asset.slot ?? 'main';
  const pictures = layer.asset.kind === 'product' ? api.allowed.products[slot] ?? [] : [];
  return (
    <>
      <NumberField
        label={w(S.propScale)}
        value={layer.scale}
        step={0.01}
        min={0.01}
        hint={layer.role === 'product' ? w(S.propProductRatio) : undefined}
        onCommit={(scale) => scale > 0 && api.apply([{ op: 'scale_asset_uniform', layer_id: layer.id, factor: Math.min(20, Math.max(0.05, scale / layer.scale)), anchor: 'center' }])}
      />
      {pictures.length > 1 ? (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold text-text-secondary">{w(S.propReplacePicture)}</legend>
          <div className="grid grid-cols-3 gap-1">
            {pictures.map((p) => (
              <button
                key={p.url}
                type="button"
                aria-pressed={p.url === layer.asset.ref}
                aria-label={fill(w(S.newPictureSize), { w: p.width, h: p.height })}
                className="aspect-square overflow-hidden rounded-lg bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                style={{ boxShadow: p.url === layer.asset.ref ? 'inset 0 0 0 3px #3b82f6' : undefined }}
                onClick={() => api.apply([{ op: 'replace_asset', layer_id: layer.id, ref: p.url }])}
              >
                <VariantImg src={p.url} sizes="96px" naturalWidth={p.width} alt="" className="h-full w-full object-contain" />
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
    </>
  );
}
