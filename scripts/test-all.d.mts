import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
export interface TestOptions {
  suite: 'root' | 'workspaces' | 'studio' | null;
  shard: { index: number; total: number } | null;
  list: boolean;
}
export interface RootTimings {
  concurrency: number;
  files: Record<string, number>;
  missing?: boolean;
}
export interface RootShardPlan {
  files: string[];
  seconds: number;
  unmeasured: number;
}
export const ROOT_TIMINGS_FILE: string;
export function parseTestArgs(argv: string[]): TestOptions;
export function discoverRootTests(root?: string): string[];
export function readRootTimings(root?: string): RootTimings;
export function planRootShards(files: string[], total: number, timings?: RootTimings): RootShardPlan[];
export function selectRootShard(files: string[], shard: TestOptions['shard'], timings?: RootTimings): string[];
export function runTestSuites(argv: string[], options?: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: SpawnSyncOptions) => Pick<SpawnSyncReturns<Buffer>, 'status'> & Partial<Pick<SpawnSyncReturns<Buffer>, 'signal' | 'error'>>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): number;
