/**
 * What the editor hands its panels. One object, so a panel can only change
 * the document the way the editor does — through `apply` (applyOps as a
 * person) or `replaceDocument` (a re-layout the package computed, or an AI
 * answer the owner confirmed).
 */
import type { DocumentDto, ProviderStatusDto, VerifyDto } from '../../../packages/creativeDoc/src/api';
import type { AllowedAssets, ApplyResult, RebuildRequest } from '../../../packages/creativeDoc/src/ops';
import type { CreativeDocument, Density } from '../../../packages/creativeDoc/src/schema';
import type { TextMeasurer } from '../../../packages/creativeDoc/src/text';
import type { SaveState } from './autosave';
import type { EditorData } from './editorData';
import type { FontState } from './fonts';
import type { ImageStore } from './media';
import type { StageView, Tool } from './stageView';

export interface EditorApi {
  docId: string;
  meta: DocumentDto;
  doc: CreativeDocument;
  version: number;
  saveState: SaveState;
  selection: string[];
  setSelection(ids: string[]): void;
  /** Operations as a person; false when refused (the reason is shown). */
  apply(ops: unknown[]): boolean;
  /** A whole new document (a re-layout, an accepted AI answer): one undo step. */
  replaceDocument(doc: CreativeDocument): void;
  data: EditorData;
  allowed: AllowedAssets;
  measure: TextMeasurer;
  fonts: FontState;
  images: ImageStore;
  provider: ProviderStatusDto | null;
  stage(): StageView | null;
  tool: Tool;
  setTool(tool: Tool): void;
  /** Saves now; resolves when the server has the document on screen (or the save failed). */
  flush(): Promise<void>;
  /** What is on screen NOW (a panel’s closure may be older after an await). */
  current(): { doc: CreativeDocument; version: number; saveState: SaveState };
  /**
   * Commits an AI answer the owner confirmed and saves it as an `ai` version
   * with its job id, then tells the server it was applied. A rebuild request
   * in it (another variant, priority or size) is performed by the package’s
   * own re-layout. Resolves false when nothing was saved.
   */
  applyAi(applied: Extract<ApplyResult, { ok: true }>, jobId: string): Promise<boolean>;
  /** A re-layout the package computes from the template (variant, priority, format, density). */
  rebuildTo(change: RebuildRequest | { kind: 'density'; density: Density }): Promise<void>;
  verification: Record<string, VerifyDto>;
  setVerification(v: Record<string, VerifyDto>): void;
  editText(id: string): void;
  openDocument(id: string): void;
  goSettings(): void;
}
