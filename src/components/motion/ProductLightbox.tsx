import React, { useLayoutEffect, useRef } from 'react';
import { usePresence } from 'motion/react';
import { X } from 'lucide-react';
import { Overlay } from '../ui/Overlay';
import { IconButton } from '../ui/Button';
import DissolveImage from './DissolveImage';
import GallerySurface from './GallerySurface';
import { take } from './ProductTransition';
import { usePrefersReducedMotion } from '../../lib/motion';
import { cssTimeMs } from '../../lib/motionTime';

type Props = {
  open: boolean;
  onClose: () => void;
  hero: React.RefObject<HTMLDivElement | null>;
  trigger: React.RefObject<HTMLElement | null>;
  label: string;
  closeLabel: string;
  src?: string;
  alt: string;
  preview?: string;
  count: number;
  direction: 'rtl' | 'ltr';
  onStep: (step: number, animate?: boolean) => void;
  animate: boolean;
  spatial: boolean;
};

/** Animate the painted photo between its actual rectangles, not the zoom button. */
function Photo({ hero, spatial, ...props }: Props) {
  const [present, remove] = usePresence();
  const reduced = usePrefersReducedMotion();
  const canvas = useRef<HTMLDivElement>(null);
  const flight = useRef<Animation | null>(null);
  const origin = useRef<ReturnType<typeof take>>(undefined);

  useLayoutEffect(() => {
    const source = hero.current;
    if (!source) return;
    origin.current = take(source);
    const photo = source.querySelector<HTMLElement>('.u349');
    const visibility = photo?.style.visibility ?? '';
    if (photo) photo.style.visibility = 'hidden';
    return () => {
      flight.current?.cancel();
      if (photo) photo.style.visibility = visibility;
    };
  }, [hero]);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // Read the presentation value BEFORE cancelling: closing mid-entry reverses
    // from the on-screen position, with no jump to the fully enlarged photo.
    const current = flight.current ? getComputedStyle(el).transform : 'none';
    flight.current?.cancel();
    const source = (hero.current ? take(hero.current) : undefined) ?? origin.current;
    const target = take(el, source);
    const end = () => { if (present) { flight.current?.cancel(); flight.current = null; } else remove?.(); };
    if (!spatial || !el.animate || !source || !target) { end(); return; }
    const scale = source.plane.width / target.plane.width;
    const transform = `translate(${source.plane.x - target.rect.x - (target.plane.x - target.rect.x) * scale}px,${source.plane.y - target.rect.y - (target.plane.y - target.rect.y) * scale}px) scale(${scale})`;
    const css = getComputedStyle(document.documentElement);
    const gentle = reduced;
    const frames = gentle
      ? [{ opacity: present ? 0 : 1 }, { opacity: present ? 1 : 0 }]
      : [{ transform: present ? transform : current }, { transform: present ? 'none' : transform }];
    flight.current = el.animate(frames, {
      duration: cssTimeMs(css.getPropertyValue(gentle ? '--duration-quick' : '--duration-ui'), gentle ? 150 : 250),
      easing: gentle ? 'linear' : css.getPropertyValue('--ease-drawer').trim() || 'cubic-bezier(.32,.72,0,1)',
      fill: 'both',
    });
    flight.current.onfinish = end;
    const resize = () => end();
    window.addEventListener('resize', resize, { once: true });
    return () => window.removeEventListener('resize', resize);
  }, [present, reduced, spatial, hero, remove]);

  return <GallerySurface count={props.count} direction={props.direction} onStep={props.onStep} tabIndex={0} role="group" aria-label={props.label} data-lightbox className="relative h-[min(82dvh,900px)] w-[min(calc(100vw-2rem),1200px)]">
    <div ref={canvas} data-photo-zoom className="w-full h-full" style={{ transformOrigin: '0 0' }}>
      <DissolveImage animate={props.animate} src={props.src} placeholderSrc={props.preview} alt={props.alt} fit="contain" eager className="w-full h-full" bgClassName="bg-transparent" imgClassName="p-3" />
    </div>
    <span className="absolute top-4 end-4 z-10">
      <IconButton variant="secondary" onClick={props.onClose} label={props.closeLabel} icon={<X aria-hidden="true" className="w-5 h-5" />} />
    </span>
  </GallerySurface>;
}

/** The existing modal keeps focus, Escape, backdrop dismissal and scroll locking. */
export default function ProductLightbox(props: Props) {
  return <Overlay open={props.open} onClose={props.onClose} label={props.label} anchor={props.trigger} solid z={200} testId="product-lightbox" className="product-photo-overlay"
    panelClassName="max-w-full max-h-[calc(100dvh-2rem)] !shadow-none"
    panelMotion={{ initial: false, animate: { opacity: 1, transform: 'none' }, exit: { opacity: 1, transform: 'none' }, transition: { duration: 0 } }}>
    <Photo {...props} />
  </Overlay>;
}
