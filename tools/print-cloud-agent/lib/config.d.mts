export class ConfigError extends Error {
  constructor(problems: string[]);
  problems: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface AgentConfig {
  cloud: { base_url: string; token: string; timeout_ms: number };
  state_dir: string;
  intervals: { telemetry_ms: number; commands_ms: number; printers_ms: number; slicing_ms: number; tick_ms: number };
  jobs: {
    start_mode: 'auto' | 'manual';
    bed_clear: 'operator' | 'assume_clear';
    command_max_age_ms: number;
    start_timeout_ms: number;
    max_start_attempts: number;
    prints_retention_days: number;
  };
  printers: Record<string, Record<string, any>>;
  slicer: Record<string, any> | null;
  log: { level: 'debug' | 'info' | 'warn' | 'error' };
  secrets: string[];
}

export function normalizeConfig(raw: unknown, opts?: { env?: Record<string, string | undefined>; baseDir?: string }): AgentConfig;
export function loadConfigFile(path: string, opts?: { env?: Record<string, string | undefined> }): AgentConfig;
