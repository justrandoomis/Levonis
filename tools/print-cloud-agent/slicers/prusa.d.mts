export function prusaArgs(p: {
  printerIni: string;
  printIni: string;
  filamentIni: string;
  settings: Record<string, unknown>;
  brimWidthMm: number;
  outPath: string;
  objectPaths: string[];
}): { args: string[]; overrides: Record<string, unknown> };
/** Null when the G-code is the whole job on one bed, else why not (see prusa.mjs). */
export function prusaPlateProblem(path: string, objects: number): Promise<{ code: 'OBJECTS_DO_NOT_FIT_ONE_PLATE' | 'PLATE_UNVERIFIABLE'; detail: string } | null>;
export const prusa: { label: string; layerMarkers: string[] };
