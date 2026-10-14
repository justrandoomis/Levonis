/**
 * HOW WIDE EACH KIND OF PICTURE IS DRAWN — the `sizes` half of the small
 * copies (the widths and the srcset builder are packages/contracts/src/imageSizing.ts).
 *
 * Kept apart from that module on purpose: `variantSrcSet` rides in the entry
 * chunk (ui/SafeImage paints on the first screen), and these presets and the
 * gallery's arithmetic are wanted only by the pages that draw them — one
 * module would have put all of it in every visitor's first download
 * (tests/bundleBudget.test.ts). Pure: no imports.
 */

/**
 * HOW WIDE A PICTURE IS DRAWN, PER KIND OF PLACE (CSS px, from the boxes
 * measured on the live pages). The browser takes the smallest rung that covers
 * `sizes × devicePixelRatio`, so a preset that tells the truth is the whole
 * saving; one that over-states merely costs bytes, one that under-states
 * costs sharpness.
 */
export const IMAGE_SIZES = {
  /** Colour chips, option chips. */
  thumb36: '36px',
  thumb40: '40px',
  thumb48: '48px',
  /** Gallery thumbs, cart / checkout / order lines. */
  thumb64: '64px',
  /** Listing rows, compare cards, search results. */
  thumb96: '96px',
  /** A face in the header (32), a comment (40), a profile chip. */
  avatar: '40px',
  /** A profile hero's face. */
  avatarLarge: '112px',
  /** A store's logo. */
  logo72: '72px',
  /** A product card in a grid (phone 164 of 390 CSS px; at DPR 2.5+ the 480 copy, as home/ProductCard.tsx's grid). */
  card: '(min-width: 1280px) 230px, (min-width: 1024px) 20vw, (min-width: 640px) 30vw, (min-resolution: 2.5dppx) 41vw, 45vw',
  /** The feed column's card: the phone's full width, 672 px on a desktop. Its cover is cropped to fill it — see `feedCoverSizes`. */
  feedCover: '(min-width: 1024px) 672px, (min-width: 640px) calc(100vw - 32px), 100vw',
  /** A category banner's photograph (`CropPhoto`): phone 192–222, desktop 449–495 CSS px. */
  cropBanner: '(min-width: 1024px) 500px, (min-width: 640px) 40vw, 230px',
  /** Full-bleed. */
  full: '100vw',
  /** Half a page on a wide screen, the whole width on a phone. */
  half: '(min-width: 768px) 50vw, 100vw',
} as const;
export type ImageSizesPreset = keyof typeof IMAGE_SIZES;

/**
 * Product.tsx's gallery image content width, shared with the document preload.
 * The gallery frame includes a 1px border and the image has 12px padding on
 * each side. Exclude those 26px: at a 412px viewport / DPR 1.75, declaring the
 * whole frame selects 1080w (665 device pixels), although 640w covers the
 * image content (619.5 device pixels). Keep the full content width for wide
 * photos; `productGallerySizes` narrows it for square and portrait ones.
 */
export const PRODUCT_GALLERY_SIZES = '(min-width: 1540px) 962px, (min-width: 1280px) calc(100vw - 578px), (min-width: 1024px) calc(100vw - 506px), (min-width: 640px) calc(100vw - 74px), calc(100vw - 58px)';

/** Product.tsx's gallery frame per breakpoint: `h-[min(78vw,340px)] sm:h-[420px] lg:h-[520px] xl:h-[560px]`. */
const GALLERY_FRAMES: ReadonlyArray<{ media: string; width: string; height: number }> = [
  { media: '(min-width: 1540px)', width: '962px', height: 560 },
  { media: '(min-width: 1280px)', width: 'calc(100vw - 578px)', height: 560 },
  { media: '(min-width: 1024px)', width: 'calc(100vw - 506px)', height: 520 },
  { media: '(min-width: 640px)', width: 'calc(100vw - 74px)', height: 420 },
];
/** The frame's 1px border and the picture's 12px padding, both sides. */
const GALLERY_INSET = 26;
const n2 = (value: number) => String(Math.round(value * 100) / 100);

/**
 * THE GALLERY DRAWS THE PICTURE, NOT THE FRAME. `object-contain` in a frame
 * of fixed height draws a square photo as wide as the frame is TALL: on a
 * 1280 px desktop the frame is 702 px wide and the photo 534 px, so the frame
 * width asked for the 1080 copy where 640 covers it. With the picture's
 * aspect (width / height, from the media JSON) each breakpoint takes the
 * smaller of the two. Without one it is `PRODUCT_GALLERY_SIZES` as before.
 */
export function productGallerySizes(aspect?: number | null): string {
  const a = Number(aspect);
  if (aspect === null || aspect === undefined || !Number.isFinite(a) || a <= 0) return PRODUCT_GALLERY_SIZES;
  const r = Math.min(5, Math.max(0.2, a));
  const parts = GALLERY_FRAMES.map((f) => `${f.media} min(${f.width}, ${n2((f.height - GALLERY_INSET) * r)}px)`);
  // The phone frame is min(78vw, 340px) tall.
  parts.push(`min(calc(100vw - 58px), ${n2((340 - GALLERY_INSET) * r)}px, calc(${n2(78 * r)}vw - ${n2(GALLERY_INSET * r)}px))`);
  return parts.join(', ');
}

/** One box a picture is cropped to fill, at one breakpoint: its CSS width and its width / height. */
export interface CoverBox {
  media?: string;
  width: string;
  aspect: number;
}

/**
 * A PICTURE CROPPED TO FILL ITS BOX IS DRAWN WIDER THAN THE BOX when it is
 * wider than the box: `object-cover` scales it to the box's HEIGHT, so a 16:9
 * photograph in a 4:3 card is drawn at 1.33 × the card's width, and a 2.4:1
 * one in a square tile at 2.4 ×. A `sizes` that names the box asks for a copy
 * that is then stretched — the verification of DECISIONS row 226 measured
 * 0.53–0.71 image pixels per screen pixel on such covers. This is the box's
 * `sizes` times that factor, per breakpoint (never below the box, at most 4 ×).
 * `imageAspect` comes from the media row; without one, `unknownAspect` (16:9,
 * the commonest wide photograph) is assumed.
 */
export function coverSizes(boxes: readonly CoverBox[], imageAspect?: number | null, unknownAspect = 16 / 9): string {
  const a = Number(imageAspect) > 0 ? Number(imageAspect) : unknownAspect;
  return boxes
    .map((box) => {
      const f = Math.min(4, Math.max(1, a / box.aspect));
      const m = /^(\d+(?:\.\d+)?)(px|vw)$/.exec(box.width);
      const width = f === 1 ? box.width : m ? `${n2(Number(m[1]) * f)}${m[2]}` : `calc(${box.width} * ${n2(f)})`;
      return box.media ? `${box.media} ${width}` : width;
    })
    .join(', ');
}

/** A feed card's cover (community/feed/PostCard.tsx): 4:3, or 4:5 for a portrait picture, cropped to fill the feed column. */
export function feedCoverSizes(cover: { width?: number | null; height?: number | null } | null | undefined): string {
  const aspect = mediaAspect(cover);
  const box = aspect !== null && aspect < 1 ? 0.8 : 4 / 3;
  return coverSizes(
    [
      { media: '(min-width: 1024px)', width: '672px', aspect: box },
      { media: '(min-width: 640px)', width: 'calc(100vw - 32px)', aspect: box },
      { width: '100vw', aspect: box },
    ],
    aspect
  );
}

/** The community hub's cover story (community/hub/CoverStory.tsx): 16:9 across a phone, 12:5 in the 1120 px column on a desktop. */
export function coverStorySizes(aspect: number | null): string {
  return coverSizes(
    [
      { media: '(min-width: 1024px)', width: 'min(1120px, calc(100vw - 32px))', aspect: 12 / 5 },
      { width: '100vw', aspect: 16 / 9 },
    ],
    aspect,
    1
  );
}

/** width / height of a media row, or null when either is unknown. */
export function mediaAspect(media: { width?: unknown; height?: unknown } | null | undefined): number | null {
  const w = Number(media?.width);
  const h = Number(media?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : null;
}
