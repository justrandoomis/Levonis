/**
 * «FDM»: a filament printer seen from the front, the gantry, the print head
 * and its nozzle over the bed (IMG_8469). The icon set has no such glyph (its
 * printer is a paper printer), so it is drawn here, in the stroke of the set.
 */
export default function FdmGlyph({ className = 'h-[18px] w-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M5 21V4h14v17" />
      <path d="M3 21h18" />
      <path d="M10 4v4h4V4" />
      <path d="M12 8v2.5" />
      <path d="M8 16h8" />
    </svg>
  );
}
