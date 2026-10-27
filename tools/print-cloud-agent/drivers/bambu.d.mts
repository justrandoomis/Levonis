import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Driver, PrinterStatus } from './common.mjs';

export function hmsCode(entry: { attr?: number; code?: number }): string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function amsTrays(report: any): NonNullable<PrinterStatus['ams']> | null;
export function amsMapping(
  variants: Array<{ variant_id: string; material?: string | null; color_hex?: string | null }>,
  trays: NonNullable<PrinterStatus['ams']>,
  tolerance?: number
): { mapping: number[]; missing?: undefined } | { missing: Array<{ variant_id: string; material?: string | null; color_hex?: string | null }>; mapping?: undefined };

export interface BambuOptions {
  host: string;
  serial: string;
  access_code: string;
  tls: { mode: 'pin' | 'ca' | 'insecure'; fingerprint256?: string; ca_file?: string; servername?: string };
  mqtt_port?: number;
  ftps_port?: number;
  chamber_sensor?: boolean;
  camera_stream_id?: string;
  use_ams?: boolean;
  color_tolerance?: number;
  timelapse?: boolean;
  bed_levelling?: boolean;
  flow_cali?: boolean;
  vibration_cali?: boolean;
  layer_inspect?: boolean;
  plate_param?: string;
  project_url_prefix?: string;
  gcode_path_prefix?: string;
}

export interface BambuDriver extends Driver {
  light(on: boolean): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debugReport(): { report: any; lastReportAt: number };
}

export function createBambu(
  options: BambuOptions,
  deps?: {
    log?: unknown;
    clock?: () => number;
    connectMqtt?: () => Promise<Duplex>;
    ftpsConnect?: (p: { host: string; port: number; purpose: 'control' | 'data'; timeoutMs: number }) => Promise<Socket>;
    ftpsSecure?: (socket: Socket, p: { purpose: 'control' | 'data'; session?: Buffer }) => Promise<Socket>;
    reconnectMs?: number;
  }
): BambuDriver;
