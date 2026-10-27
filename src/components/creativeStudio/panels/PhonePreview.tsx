/**
 * «على الهاتف» — the design at feed size (≈360 px wide) and as one tile of a
 * three-column profile grid (a centre crop), drawn from the same export path
 * as the real file. Labelled as a simulation: no promise that every phone or
 * app crops or scales exactly so (spec §23).
 */
import { useCallback, useEffect, useRef } from 'react';
import { Button } from '../../ui/Button';
import type { EditorApi } from '../editorApi';
import { S, fill } from '../strings';
import { useText } from '../shared';

const FEED_WIDTH = 360;
const GRID_TILE = 118;

export default function PhonePreview({ api }: { api: EditorApi }) {
  const { w } = useText();
  const feed = useRef<HTMLCanvasElement>(null);
  const grid = useRef<HTMLCanvasElement>(null);
  const { doc } = api;

  const draw = useCallback(() => {
    const stage = api.stage();
    if (!stage || !feed.current || !grid.current) return;
    const W = doc.format.width;
    const H = doc.format.height;
    const src = stage.exportCanvas({ pixelRatio: (FEED_WIDTH * 2) / W });
    const f = feed.current;
    f.width = FEED_WIDTH * 2;
    f.height = Math.round((FEED_WIDTH * 2 * H) / W);
    f.style.width = `${FEED_WIDTH}px`;
    f.style.height = `${Math.round((FEED_WIDTH * H) / W)}px`;
    const fctx = f.getContext('2d');
    fctx?.drawImage(src, 0, 0, f.width, f.height);
    // The profile grid: three 3:4 tiles; the middle one is this design, centre-cropped. Neighbours are blank placeholders.
    const g = grid.current;
    const tileW = GRID_TILE * 2;
    const tileH = Math.round((tileW * 4) / 3);
    g.width = tileW * 3 + 8;
    g.height = tileH;
    g.style.width = `${(g.width / 2).toFixed(0)}px`;
    g.style.height = `${(tileH / 2).toFixed(0)}px`;
    const gctx = g.getContext('2d');
    if (!gctx) return;
    gctx.clearRect(0, 0, g.width, g.height);
    gctx.fillStyle = 'rgba(127,127,127,0.25)';
    gctx.fillRect(0, 0, tileW, tileH);
    gctx.fillRect(tileW * 2 + 8, 0, tileW, tileH);
    const ratio = 3 / 4;
    const cropW = Math.min(src.width, src.height * ratio);
    const cropH = cropW / ratio;
    const sx = (src.width - cropW) / 2;
    const sy = Math.max(0, (src.height - cropH) / 2);
    gctx.drawImage(src, sx, sy, cropW, Math.min(cropH, src.height), tileW + 4, 0, tileW, tileH);
  }, [api, doc]);

  useEffect(() => {
    const t = setTimeout(draw, 150);
    return () => clearTimeout(t);
  }, [draw]);

  return (
    <div className="flex flex-col gap-3" data-phone-preview>
      <p className="text-xs text-text-muted">{w(S.phoneSimulation)}</p>
      <figure className="flex flex-col gap-1">
        <figcaption className="text-sm text-text-secondary">{fill(w(S.phoneFeed), { w: FEED_WIDTH })}</figcaption>
        <canvas ref={feed} role="img" aria-label={fill(w(S.phoneFeed), { w: FEED_WIDTH })} className="max-w-full rounded-lg" />
      </figure>
      <figure className="flex flex-col gap-1">
        <figcaption className="text-sm text-text-secondary">{w(S.phoneGrid)}</figcaption>
        <canvas ref={grid} role="img" aria-label={w(S.phoneGrid)} className="max-w-full" />
      </figure>
      <Button size="sm" variant="ghost" onClick={draw}>{w(S.phoneRefresh)}</Button>
    </div>
  );
}
