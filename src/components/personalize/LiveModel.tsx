/**
 * THE LIVE MODEL ON THE STAGE — lazy, after the look card has painted (survey
 * §5.2 «Picking and loading»: the look card paints at once, the canvas
 * cross-fades in on `data-studio="ready"`). Mounts the viewer core through
 * ./live.ts, applies every configuration change as uniform writes, turns once
 * to welcome the customer (never under reduced motion; a touch or a change
 * stops it), and turns a tap into the region under the finger — triangle →
 * part → region — for the studio to open its editor.
 *
 * `data-spin` = the turntable. The reset-view button lives here: there is no
 * view to reset before the model is live.
 */
import { useEffect, useRef, useState } from 'react';
import * as Motion from 'motion/react-m';
import { RotateCcw } from 'lucide-react';
import type { DesignConfig, PaletteKey, PublicBlueprint } from '../../../packages/catalog/src/personalize/types';
import { useMotion } from '../../lib/motion';
import { MotionFeatures } from '../../lib/motionFeatures';
import { IconButton } from '../ui/Button';
import { mountLive, viewOf, type LiveScene } from './live';

export type LiveOff = 'gl' | 'dstream' | 'failed' | 'lost';

export interface LiveModelProps {
  pub: PublicBlueprint;
  made: DesignConfig;
  arts: Record<string, HTMLCanvasElement | null>;
  rgb: (key: PaletteKey) => readonly number[];
  /** The mesh: a URL (the public .lvm.gz, the builder's draft door) or the bytes. */
  source: { url: string } | { bytes: ArrayBuffer };
  ready: boolean;
  onReady: () => void;
  onOff: (why: LiveOff) => void;
  onPick: (regionId: string) => void;
  resetLabel: string;
}

/** The viewer's turntable turns 0.0004 rad a millisecond (src/lib/viewer/studio.ts): one turn, then rest. */
const ONE_TURN_MS = (2 * Math.PI) / 0.0004;

export default function LiveModel({ pub, made, arts, rgb, source, ready, onReady, onOff, onPick, resetLabel }: LiveModelProps) {
  const m = useMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<LiveScene | null>(null);
  const [spin, setSpin] = useState(false);
  const view = useRef({ pub, made, rgb, arts });
  view.current = { pub, made, rgb, arts };
  const calls = useRef({ onReady, onOff });
  calls.current = { onReady, onOff };
  const key = 'url' in source ? source.url : source.bytes;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const abort = new AbortController();
    const v = view.current;
    const partToRegion: number[] = [];
    v.pub.regions.forEach((r, i) => r.parts.forEach((p) => (partToRegion[p] = i)));
    mountLive(el, v.pub, typeof key === 'string' ? { url: key } : { bytes: key }, {
      reduced: m.reduced,
      partToRegion: Array.from(partToRegion, (x) => x ?? 0),
      colours: viewOf(v.pub, v.made, 0, v.rgb, {}).colours,
      signal: abort.signal,
      onReady: () => !abort.signal.aborted && calls.current.onReady(),
      onLost: () => {
        scene.current?.dispose();
        scene.current = null;
        calls.current.onOff('lost');
      },
    }).then(
      (s) => {
        if (abort.signal.aborted) return void (s && s !== 'unsupported' && s.dispose());
        if (s === 'unsupported' || !s) return void calls.current.onOff(s ? 'dstream' : 'failed');
        scene.current = s;
        const now = view.current;
        s.apply(viewOf(now.pub, now.made, s.parts, now.rgb, now.arts));
      },
      () => !abort.signal.aborted && calls.current.onOff('gl')
    );
    return () => {
      abort.abort();
      scene.current?.dispose();
      scene.current = null;
    };
  }, [key, m.reduced]);

  useEffect(() => {
    const s = scene.current;
    if (s) s.apply(viewOf(pub, made, s.parts, rgb, arts));
  }, [pub, made, rgb, arts, ready]);

  // One welcome turn once the model is ready; a touch or a change stops it.
  useEffect(() => {
    if (!ready || m.reduced) return;
    scene.current?.spin(true);
    setSpin(true);
    const stop = window.setTimeout(() => {
      scene.current?.spin(false);
      setSpin(false);
    }, ONE_TURN_MS);
    return () => window.clearTimeout(stop);
  }, [ready, m.reduced]);
  const first = useRef(made);
  useEffect(() => {
    if (made === first.current) return;
    scene.current?.spin(false);
    setSpin(false);
  }, [made]);

  const down = useRef<{ x: number; y: number; at: number } | null>(null);
  return (
    <div className="absolute inset-0" data-spin={spin ? 'on' : 'off'}>
      <MotionFeatures>
        <Motion.div className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: ready ? 1 : 0 }} transition={m.spring('ui')}>
          <canvas
            ref={canvas}
            className="block h-full w-full touch-none"
            onPointerDown={(e) => {
              down.current = { x: e.clientX, y: e.clientY, at: e.timeStamp };
              if (spin) {
                scene.current?.spin(false);
                setSpin(false);
              }
            }}
            onPointerUp={(e) => {
              const d = down.current;
              down.current = null;
              const s = scene.current;
              if (!d || !s || !canvas.current || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || e.timeStamp - d.at > 600) return;
              const box = canvas.current.getBoundingClientRect();
              const i = s.pick(e.clientX - box.left, e.clientY - box.top);
              const region = i === null ? undefined : pub.regions[i];
              if (region) onPick(region.id);
            }}
          />
        </Motion.div>
      </MotionFeatures>
      {ready && (
        <div className="absolute end-1 top-1">
          <IconButton label={resetLabel} icon={<RotateCcw className="h-4 w-4" />} onClick={() => scene.current?.reset()} />
        </div>
      )}
    </div>
  );
}
