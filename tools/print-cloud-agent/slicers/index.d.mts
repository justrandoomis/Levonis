import type { ProtocolEstimate } from './gcode.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const SLICERS: Record<'orca' | 'bambu-studio' | 'prusa', { label: string; layerMarkers: string[] }>;

export type SliceFailure = { ok: false; error_code: string; detail: string };

export interface SlicePlan {
  jobId: string;
  settings: Record<string, any>;
  orientation: 'auto' | 'as_uploaded';
  objects: Array<{ file_id: string; filament: number }>;
  slots: Array<{ variant_id: string; sku: string; material: string | null; color_hex: string; profile: string | null }>;
  machine: { machine: string | null; process: string | null; nozzle_um?: number; pause_gcode?: string };
  pauseLayers: number[];
}

export function planSlice(input: Record<string, any>, cfg: Record<string, any>): { ok: true; plan: SlicePlan } | SliceFailure;

export interface CliResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  tail: string;
}
export function runCli(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<CliResult>;

export function insertPauses(path: string, layers: number[], pauseGcode: string, markers?: string[]): Promise<{ layers: number; inserted: number; ok: boolean }>;

export interface Slicer {
  kind: string;
  label: string;
  slice(p: { input: Record<string, any>; files: Map<string, string>; workDir: string }): Promise<
    { ok: true; printFile: string; format: 'gcode' | 'gcode.3mf'; estimate: ProtocolEstimate; sha256: string } | SliceFailure
  >;
}

export function createSlicer(cfg: Record<string, any>, deps?: { log?: unknown; run?: typeof runCli }): Slicer;
