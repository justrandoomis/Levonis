/**
 * A design drawn small, through the SAME renderer and export path as the
 * editor (an off-screen StageView), after its fonts and pictures loaded — so
 * the three proposed compositions and a version comparison show what the
 * file will be, not an approximation of it.
 */
import { useEffect, useRef, useState } from 'react';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import { ensureFonts } from './fonts';
import { canvasMeasurer, ImageStore } from './media';
import { StageView } from './stageView';
import { S, fill } from './strings';
import { useText } from './shared';

const shared = new ImageStore();

export async function renderDocument(doc: CreativeDocument, width: number, images: ImageStore = shared): Promise<{ canvas: HTMLCanvasElement; failedFonts: string[] }> {
  const fonts = await ensureFonts(doc);
  await Promise.all(doc.layers.map((l) => (l.type === 'image' ? images.load(l.asset) : Promise.resolve(true))));
  const measure = canvasMeasurer();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:16px;height:16px;overflow:hidden;';
  document.body.appendChild(host);
  const noop = () => {};
  const sv = new StageView(host, { onSelect: noop, onCommitOps: noop, onEditText: noop, onAnnotate: noop, onViewChange: noop }, { measure: () => measure, image: (r) => images.get(r) });
  try {
    sv.render(doc, []);
    return { canvas: sv.exportCanvas({ pixelRatio: width / doc.format.width }), failedFonts: fonts.failed };
  } finally {
    sv.destroy();
    host.remove();
  }
}

export default function DocThumb({ doc, width, label }: { doc: CreativeDocument; width: number; label: string }) {
  const { w } = useText();
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [failedFonts, setFailedFonts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    setState('loading');
    renderDocument(doc, width * 2).then(
      ({ canvas, failedFonts: ff }) => {
        if (!alive || !ref.current) return;
        const c = ref.current;
        c.width = canvas.width;
        c.height = canvas.height;
        c.getContext('2d')?.drawImage(canvas, 0, 0);
        setFailedFonts(ff);
        setState('ready');
      },
      () => alive && setState('failed'),
    );
    return () => { alive = false; };
  }, [doc, width]);
  const height = Math.round((width * doc.format.height) / doc.format.width);
  return (
    <div className="flex flex-col gap-1">
      <canvas ref={ref} role="img" aria-label={label} style={{ width, height, maxWidth: '100%', borderRadius: 8, background: 'rgba(127,127,127,0.12)' }} data-doc-thumb={state} />
      {state === 'loading' ? <span className="text-xs text-text-muted">{w(S.loading)}</span> : null}
      {state === 'failed' ? <span className="text-xs text-danger">{w(S.editorLoadFailed)}</span> : null}
      {failedFonts.map((f) => <span key={f} className="text-xs text-danger">{fill(w(S.fontFailed), { name: f })}</span>)}
    </div>
  );
}
