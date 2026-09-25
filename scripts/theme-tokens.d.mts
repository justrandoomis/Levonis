/** Types for scripts/theme-tokens.mjs — the theme generator (see its header). */
export declare const IVORY: string;
export declare const PAPER: string;
export declare const SEMANTIC: Record<string, [dark: string, light: string]>;
export declare const NEUTRAL_LIGHT: Record<number, string>;
export declare const TONES: Record<string, string>;
export declare const FIXED: Record<string, string>;
export declare const BEGIN: string;
export declare const END: string;
export declare function luminance(rgb: number[]): number;
export declare function contrast(a: number[], b: number[]): number;
export declare function rgbToOklch(rgb: number[]): [L: number, C: number, H: number];
export declare function parseColor(v: string): number[];
export declare function darkenToContrast(color: string, target?: number): string;
export declare function chromaticLight(palette: Record<string, string>, hue: string, shade: number): string;
export declare function usedPaletteKeys(srcDir?: string): string[];
export declare function buildBlock(): string;
export declare function report(): string;
export declare function currentBlock(): string | null;
