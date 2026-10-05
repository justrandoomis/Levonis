/**
 * Product.tsx's gallery image content width, shared with the document preload.
 * The gallery frame includes a 1px border and the image has 12px padding on
 * each side. Exclude those 26px: at a 412px viewport / DPR 1.75, declaring the
 * whole frame selects 1080w (665 device pixels), although 640w covers the
 * image content (619.5 device pixels). Keep the full content width for wide
 * photos; object-contain can make square/portrait pictures narrower still.
 */
export const PRODUCT_GALLERY_SIZES = '(min-width: 1540px) 962px, (min-width: 1280px) calc(100vw - 578px), (min-width: 1024px) calc(100vw - 506px), (min-width: 640px) calc(100vw - 74px), calc(100vw - 58px)';
