/** Types for scripts/clay-census.mjs — the read-only clay census (see its header). */
export type RatchetKey = 'legacy' | 'btn' | 'rawIn' | 'arbR';
export interface CensusCounts {
  legacy: number;
  btn: number;
  rawIn: number;
  arbR: number;
  arbS: number;
  blur: number;
  wrap: number;
  zinc: number;
}
export interface Finding {
  line: number;
  text: string;
}
export interface FileFindings {
  legacy: Finding[];
  btn: Finding[];
  rawIn: Finding[];
  arbR: Finding[];
  arbS: Finding[];
  blur: Finding[];
  wrap: Finding[];
  zinc: number;
}
export interface CensusRow {
  file: string;
  family: string;
  counts: CensusCounts;
  score: number;
  found: FileFindings;
}
export declare const RATCHET: Record<RatchetKey, string>;
export declare function familyOf(file: string): string;
export declare function isLegacyCard(s: string): boolean;
export declare function isAdHocButton(s: string): boolean;
export declare function scanSource(src: string): FileFindings;
export declare function sourceFiles(root?: string): string[];
export declare function census(root?: string): { rows: CensusRow[]; totals: CensusCounts };
export declare function nearestRadius(token: string): string | null;
export declare function buttonVariant(s: string): 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export declare function suggestions(row: CensusRow): string[];
