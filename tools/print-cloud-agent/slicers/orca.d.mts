export function orcaProcessOverrides(settings: Record<string, unknown>): Record<string, string>;
export function orcaArgs(p: {
  machinePath: string;
  processPath: string;
  filamentPaths: string[];
  objects: Array<{ filament: number; path: string }>;
  outDir: string;
  outBase: string;
  output: 'gcode' | 'gcode.3mf';
  orient: boolean;
}): string[];
export const orca: { label: string; layerMarkers: string[] };
