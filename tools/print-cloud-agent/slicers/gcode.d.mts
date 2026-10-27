export interface GcodeMeta {
  generator: { name: string; version: string } | null;
  total_seconds: number | null;
  model_seconds: number | null;
  normal_seconds: number | null;
  layers_declared: number | null;
  layer_changes: number;
  grams: number[] | null;
  mm: number[] | null;
  wipe_tower_grams: number | null;
  tool_changes: number;
  tools_seen: number[];
  lines: number;
}

export interface SliceInfo {
  prediction_seconds: number | null;
  weight_grams: number | null;
  filaments: Array<{ id: number; type: string | null; color: string | null; used_g: number | null; used_m: number | null }>;
  warnings: string[];
  client_version: string | null;
}

export function parseDuration(text: unknown): number | null;
export function gcodeScanner(): { meta: GcodeMeta; line(raw: string): void };
export function scanGcodeText(text: string): GcodeMeta;
export function scanGcodeFile(path: string): Promise<GcodeMeta>;
export function parseSliceInfo(xml: string): SliceInfo;
export function readPrintFileBytes(bytes: Buffer): { meta: GcodeMeta | null; sliceInfo: SliceInfo | null; plate: string | null; format: 'gcode' | 'gcode.3mf' };

export interface ProtocolEstimate {
  duration_seconds: number;
  layer_count?: number;
  color_changes?: number;
  materials: Array<{ variant_id: string; model_grams: number }>;
  slicer_name: string;
  slicer_version: string;
  printer_profile: string;
  compatible: boolean;
  warnings: string[];
  generated_config: Record<string, unknown>;
}

export function buildEstimate(p: {
  meta: GcodeMeta | null;
  sliceInfo: SliceInfo | null;
  slots: Array<{ variant_id: string }>;
  slicerLabel: string;
  printerProfile: string;
  generatedConfig?: Record<string, unknown>;
}): { ok: true; estimate: ProtocolEstimate } | { ok: false; error_code: string; detail: string };
