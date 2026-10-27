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
import type { ChatSession } from './panels/ChatPanel';
import type { EditorData } from './editorData';
import type { FontState } from './fonts';
import type { ImageStore } from './media';
import type { StageView, Tool } from './stageView';

/** What a re-layout produced: this design re-laid (one undo step), or a NEW linked design (another size). */
export type RebuildOutcome = { kind: 'doc'; doc: CreativeDocument } | { kind: 'created'; id: string; version: number };

/** An applied AI answer: saved (and the server told), or why nothing was — never a success that saved nothing. */
export type AiApplyResult = { ok: true } | { ok: false; message: string };

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
   * in it (another variant or priority) is performed by the package’s own
   * re-layout; another size becomes a NEW linked design carrying the job.
   * A re-layout that is refused or changes nothing cancels the job and
   * says why; a save refused because the job was cancelled takes the
   * answer back off the screen.
   */
  applyAi(applied: Extract<ApplyResult, { ok: true }>, jobId: string): Promise<AiApplyResult>;
  /** A re-layout the package computes from the template (variant, priority, format, density); null when refused or a no-op (the reason is shown). */
  rebuildTo(change: RebuildRequest | { kind: 'density'; density: Density }): Promise<RebuildOutcome | null>;
  verification: Record<string, VerifyDto>;
  setVerification(v: Record<string, VerifyDto>): void;
  editText(id: string): void;
  openDocument(id: string): void;
  goSettings(): void;
  /** The conversation with Claude — kept by the editor, so a tab switch or a closed sheet never loses a request or its answer. */
  chat: ChatSession;
}
