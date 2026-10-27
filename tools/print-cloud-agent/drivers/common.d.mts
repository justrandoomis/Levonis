export type PrinterState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'cancelled' | 'error' | 'offline';
export const PRINTER_STATES: PrinterState[];

/** What the machine said, normalised; a field it did not report is null. */
export interface PrinterStatus {
  state: PrinterState;
  file: string | null;
  progress_permille: number | null;
  layer: number | null;
  total_layers: number | null;
  remaining_seconds: number | null;
  elapsed_seconds: number | null;
  nozzle_c: number | null;
  bed_c: number | null;
  chamber_c: number | null;
  errors: Array<{ code: string; message: string }>;
  ams: Array<{ slot: number; material: string; color_hex: string | null; remain_percent: number | null }> | null;
  camera: { available: boolean; resolution?: string };
}

export interface PrintFile {
  name: string;
  path?: string;
  bytes?: Buffer | Uint8Array;
}

/** The interface every printer driver implements. */
export interface Driver {
  kind: string;
  capabilities: { light: boolean; ams: boolean };
  connect?(): Promise<void>;
  status(): Promise<PrinterStatus>;
  upload(file: PrintFile): Promise<{ name: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  start(p: { name: string; job?: any }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  light?(on: boolean): Promise<void>;
  close(): Promise<void>;
}

export type DriverErrorCode = 'UNREACHABLE' | 'REFUSED' | 'UNSUPPORTED' | 'BAD_STATE' | 'PROTOCOL';
export class DriverError extends Error {
  constructor(code: DriverErrorCode, message: string, extra?: { status?: number; cause?: unknown });
  code: DriverErrorCode;
  status?: number;
}

export function emptyStatus(state: PrinterState): PrinterStatus;
export function num(v: unknown): number | null;
export function int(v: unknown): number | null;
export function fileBytes(file: PrintFile): Promise<Buffer>;
export function httpCall(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: { method?: string; headers?: Record<string, string>; body?: any; timeoutMs?: number; okStatuses?: number[] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }>;
export function multipartFile(field: string, name: string, bytes: Buffer | Uint8Array, fields?: Record<string, string>): FormData;
export function safePrintName(name: string): string;
