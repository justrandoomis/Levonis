import type { Driver } from './common.mjs';

export interface SimulatorOptions {
  print_seconds?: number;
  prepare_seconds?: number;
  layers?: number;
  time_scale?: number;
  camera?: { available: boolean; resolution?: string };
  ams?: Array<{ slot: number; material: string; color_hex: string; remain_percent: number | null }> | null;
}

export interface Simulator extends Driver {
  uploads: Array<{ name: string; size: number; sha256: string }>;
  lights: boolean[];
  light(on: boolean): Promise<void>;
  /** The machine faults mid-print. */
  fail(code?: string, message?: string): void;
  /** The machine pauses itself (a filament runout). */
  pauseFromMachine(): void;
  setReachable(v: boolean): void;
  snapshot(): { phase: string; file: string | null; files: string[] };
}

export function createSimulator(options?: SimulatorOptions, deps?: { clock?: () => number }): Simulator;
