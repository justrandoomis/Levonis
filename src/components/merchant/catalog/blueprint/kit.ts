/**
 * What every step of the builder is handed (./Builder.tsx) — types only, so a
 * step never imports the builder and the builder never re-renders a step it
 * does not show.
 */
import type { BlueprintSpec, ContentKind, EngineIssue } from '../../../../../packages/catalog/src/personalize/types';
import type { CatalogProductDetail } from '../catalogApi';
import type { BuilderState } from './api';
import type { BuilderLang, BuilderStrings } from './strings';
import type { StepId } from './model';

/** What the next tap on the model does. */
export type PickMode =
  | { place: ContentKind; role: 'name' | 'text' }
  | { move: string }
  | { anchor: string };

export interface Selection {
  part?: number;
  area?: string;
  slot?: string;
}

export interface Kit {
  t: BuilderStrings;
  lang: BuilderLang;
  spec: BlueprintSpec;
  /** Every edit goes through here; the builder saves the draft after a pause. */
  edit: (fn: (spec: BlueprintSpec) => BlueprintSpec) => void;
  st: BuilderState;
  adopt: (st: BuilderState) => void;
  product: CatalogProductDetail;
  /** Re-read the product (its option groups changed) — the editor re-reads it too. */
  reloadProduct: () => Promise<CatalogProductDetail | null>;
  /** The source the merchant chose: the model, or the product's photos. */
  kind: 'model' | 'photos' | null;
  setKind: (kind: 'model' | 'photos') => void;
  /** This step's problems (local and the server's), by path. */
  issues: EngineIssue[];
  sel: Selection;
  setSel: (sel: Selection) => void;
  pick: PickMode | null;
  setPick: (pick: PickMode | null) => void;
  /** The product editor has unsaved changes (a write to the product would lose them). */
  dirty: boolean;
  /** Part names by `${productId}|${variantId}` — the merchant's own words for a slot's options. */
  names: Record<string, string>;
  setNames: (add: Record<string, string>) => void;
  /** The refusal as a sentence in the merchant's language (loaded on the first refusal). */
  refuse: (e: unknown) => void;
  go: (step: StepId) => void;
  /** The model's size, mm (null: photo-only or no model yet). */
  dims: [number, number, number] | null;
}
