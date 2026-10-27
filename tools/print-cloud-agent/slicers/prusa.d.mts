export function prusaArgs(p: {
  printerIni: string;
  printIni: string;
  filamentIni: string;
  settings: Record<string, unknown>;
  brimWidthMm: number;
  outPath: string;
  objectPaths: string[];
}): { args: string[]; overrides: Record<string, unknown> };
export const prusa: { label: string; layerMarkers: string[] };
