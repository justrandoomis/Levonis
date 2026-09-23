/**
 * A PICTURE OR A CLIP INSIDE A SUPPORT BUBBLE, shown whole.
 *
 * Both consoles drew an image as `object-cover` in a 300px box with nothing to
 * tap, so the evidence photograph a dispute turns on — a serial number, the
 * corner of a cracked part — was CROPPED to fit and could not be opened any
 * larger. `object-contain` shows the whole frame, and the frame is a link to
 * the full file, the same thing the order chat's bubbles already do
 * (src/components/adminOrders/OrderChatPanel.tsx).
 *
 * `preload="metadata"`: a thread with six clips must not start downloading six
 * clips because it was opened. The player fetches what it needs, in ranges
 * (worker/routes/uploads.ts answers `Range` with 206), when it is played.
 */
export default function MessageMedia({
  kind,
  url,
  openLabel,
  className = '',
}: {
  kind?: string | null;
  url?: string | null;
  openLabel: string;
  className?: string;
}) {
  if (!url) return null;
  if (kind === 'video') {
    return <video src={url} controls playsInline preload="metadata" className={`mb-1 max-h-[300px] w-full rounded-lg bg-black ${className}`} />;
  }
  if (kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={openLabel} title={openLabel} className={`mb-1 block ${className}`}>
        <img referrerPolicy="no-referrer" src={url} alt="" className="max-h-[300px] w-full rounded-lg bg-black/30 object-contain" />
      </a>
    );
  }
  return null;
}
