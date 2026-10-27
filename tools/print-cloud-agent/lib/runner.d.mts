import type { CloudClient } from './protocol.mjs';
import type { AgentState } from './state.mjs';
import type { Logger } from './log.mjs';
import type { Driver } from '../drivers/common.mjs';

export function bedFlagName(ref: string): string;
export function printProjection(input: unknown): string | null;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RunnerDeps {
  config: Record<string, any>;
  cloud: CloudClient;
  state: AgentState;
  log?: Logger;
  drivers?: Record<string, Driver>;
  driverDeps?: Record<string, unknown>;
  slicer?: { kind: string; label: string; slice: (p: any) => Promise<any> } | null;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export class Runner {
  constructor(deps: RunnerDeps);
  printers: Map<string, any>;
  jobs: Map<string, any>;
  disabled: { telemetry: boolean; job_control: boolean; slicer: boolean };
  fatal: unknown;
  start(): Promise<void>;
  run(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  settle(): Promise<void>;
  tick(): Promise<void>;
  refreshPrinters(): Promise<Array<Record<string, any>>>;
  flushEvents(): Promise<void>;
  pollCommands(): Promise<void>;
  slicingTick(): Promise<void>;
}
