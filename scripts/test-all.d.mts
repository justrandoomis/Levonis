import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
export interface TestOptions {
  suite: 'root' | 'workspaces' | 'studio' | null;
  shard: { index: number; total: number } | null;
  list: boolean;
}
export function parseTestArgs(argv: string[]): TestOptions;
export function discoverRootTests(root?: string): string[];
export function selectRootShard(files: string[], shard: TestOptions['shard']): string[];
export function runTestSuites(argv: string[], options?: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: SpawnSyncOptions) => Pick<SpawnSyncReturns<Buffer>, 'status'> & Partial<Pick<SpawnSyncReturns<Buffer>, 'signal' | 'error'>>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): number;
