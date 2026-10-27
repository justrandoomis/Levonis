/**
 * «الأصول» — only what may go into this design: the bound product/variant’s
 * own same-origin pictures (a swap stays inside them, `replace_asset`), the
 * approved studio assets, and the brand kit’s background presets — reused
 * exactly as stored (`apply_background_preset`), never regenerated.
 */
import { Type } from 'lucide-react';
import { Button } from '../../ui/Button';
import VariantImg from '../../ui/VariantImg';
import { safeBox, type ImageLayer } from '../../../../packages/creativeDoc/src/schema';
import { scaledType } from '../../../../packages/creativeDoc/src/brand';
import type { EditorApi } from '../editorApi';
import { freshId, newTextLayer } from '../editorModel';
import { assetFileUrl } from '../client';
import { ASSET_KIND_TEXT, S, fill } from '../strings';
import { useText } from '../shared';

export default function AssetsPanel({ api }: { api: EditorApi }) {
  const { w } = useText();
  const { doc, selection } = api;
  const selected = selection.length === 1 ? doc.layers.find((l) => l.id === selection[0]) : undefined;
  const selectedProduct = selected && selected.type === 'image' && selected.asset.kind === 'product' ? selected : null;
  const kit = api.data.brand.kit;
  const approved = api.data.assets.filter((a) => a.review === 'approved' && a.kind !== 'logo' && a.kind !== 'reference_liked' && a.kind !== 'reference_rejected' && a.width && a.height);

  const addAsset = (id: string, width: number, height: number, kind: string) => {
    const safe = safeBox(doc);
    const scale = Math.min((safe.width * 0.4) / width, (safe.height * 0.4) / height);
    const layer: ImageLayer = {
      id: freshId(kind === 'icon' ? 'icon' : 'element', new Set(doc.layers.map((l) => l.id))), name: kind, role: kind === 'icon' ? 'icon' : 'decor', parent: null,
      x: Math.round(safe.x + (safe.width - width * scale) / 2), y: Math.round(safe.y + (safe.height - height * scale) / 2), rotation: 0, opacity: 1, visible: true, locked: false,
      type: 'image', asset: { kind: 'asset', ref: id }, natural: { width, height }, crop: null, scale, fit: 'whole',
    };
    if (api.apply([{ op: 'add_layer', layer }])) api.setSelection([layer.id]);
  };

  const addText = () => {
    const style = scaledType(kit, 'body', doc.format.width);
    const layer = newTextLayer(doc, w(S.newTextDefault), { family: style.family, weight: style.weight, size: style.size, minSize: style.min, color: kit.colors.text });
    if (api.apply([{ op: 'add_layer', layer }])) {
      api.setSelection([layer.id]);
      api.editText(layer.id);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-assets-panel>
      <Button size="sm" icon={<Type className="h-4 w-4" />} onClick={addText}>{w(S.addText)}</Button>
      {doc.products.map((b) => {
        const pics = api.allowed.products[b.slot] ?? [];
        return (
          <section key={b.slot}>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">{w(S.assetsProductPictures)}</h3>
            {!selectedProduct ? <p className="mb-2 text-xs text-text-muted">{w(S.assetsSelectProductFirst)}</p> : null}
            <div className="grid grid-cols-3 gap-1.5">
              {pics.map((p) => (
                <button
                  key={p.url}
                  type="button"
                  disabled={!selectedProduct || (selectedProduct.asset.slot ?? 'main') !== b.slot}
                  aria-pressed={selectedProduct?.asset.ref === p.url}
                  aria-label={fill(w(S.newPictureSize), { w: p.width, h: p.height })}
                  className="aspect-square overflow-hidden rounded-lg bg-surface disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  style={{ boxShadow: selectedProduct?.asset.ref === p.url ? 'inset 0 0 0 3px #3b82f6' : undefined }}
                  onClick={() => selectedProduct && api.apply([{ op: 'replace_asset', layer_id: selectedProduct.id, ref: p.url }])}
                >
                  <VariantImg src={p.url} sizes="110px" naturalWidth={p.width} alt="" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          </section>
        );
      })}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{w(S.assetsBackgrounds)}</h3>
        <div className="flex flex-col gap-1.5">
          {kit.backgrounds.map((bg) => (
            <button
              key={bg.id}
              type="button"
              className="flex min-h-11 items-center gap-2 rounded-lg border border-border-subtle px-2 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => api.apply([{ op: 'apply_background_preset', preset_id: bg.id }])}
            >
              <span aria-hidden="true" className="h-7 w-7 shrink-0 overflow-hidden rounded" style={{ background: bg.color }}>
                {bg.kind === 'asset' && bg.asset_id ? <VariantImg src={assetFileUrl(bg.asset_id)} sizes="28px" alt="" className="h-full w-full object-cover" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{bg.label}</span>
              <span className="text-xs text-text-muted">{w(S.assetsUseBackground)}</span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{w(S.assetsApproved)}</h3>
        {approved.length === 0 ? (
          <p className="text-xs text-text-muted">{w(S.assetsNone)}</p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {approved.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-label={`${w(S.assetsAdd)}: ${a.label || w(ASSET_KIND_TEXT[a.kind])}`}
                className="aspect-square overflow-hidden rounded-lg bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                onClick={() => addAsset(a.id, a.width as number, a.height as number, a.kind)}
              >
                <VariantImg src={a.url} sizes="110px" alt="" className="h-full w-full object-contain" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
