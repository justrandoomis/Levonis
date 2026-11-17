/**
 * ONE GLYPH PER KIND OF POST (community UI plan C2.1; IMG_8485, IMG_8486):
 * the kind chips of the projects list and the gold kind badge of a feed
 * card draw the same mark for the same kind. Decoration: the word is always
 * written beside it.
 */
import { Box, FileText, Image, SquarePlay, StickyNote, type LucideIcon } from 'lucide-react';
import type { PostKind } from './api';

export const KIND_ICONS: Record<PostKind, LucideIcon> = {
  project: Box,
  post: StickyNote,
  tutorial: FileText,
  timelapse: SquarePlay,
  before_after: Image,
};

export function KindIcon({ kind, className = 'h-4 w-4' }: { kind: PostKind; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? Box;
  return <Icon aria-hidden="true" className={className} strokeWidth={1.75} />;
}
