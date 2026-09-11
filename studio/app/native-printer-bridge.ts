export type LevoNativePlatform = "web" | "ios" | "android";

export interface LevoPrinterCapabilities {
  discovery: boolean;
  lanConnection: boolean;
  telemetry: boolean;
  rawGcodePrintJob: boolean;
  packagePrintJob: boolean;
  fileTransfer: boolean;
  startPrint: boolean;
}

export interface LevoNativeEnvironment {
  native: boolean;
  platform: LevoNativePlatform;
  bridgeVersion: string | null;
  capabilities: LevoPrinterCapabilities;
}

export interface LevoDiscoveredPrinter {
  id: string;
  name: string;
  model?: string;
  ip: string;
  serial?: string;
}

export interface LevoPrinterStatus {
  connected: boolean;
  printer?: LevoDiscoveredPrinter;
  state?: "idle" | "printing" | "paused" | "offline" | "error";
  progress?: number;
  nozzleTemperature?: number;
  bedTemperature?: number;
  error?: string;
  requiresTrust?: boolean;
  certificateFingerprint?: string;
  fileTransferFingerprint?: string;
  fileTransferVerified?: boolean;
  transportVerified?: boolean;
}

export interface LevoPrinterConnection {
  ip: string;
  accessCode: string;
  serial?: string;
  remember: boolean;
  trustedFingerprint?: string;
  trustedFileFingerprint?: string;
}

export interface LevoPrintJobMetadata {
  name: string;
  profileId: string;
  printerModel: string;
  plate: number;
  nozzleDiameter: number;
  projectBytes: number;
  gcodeBytes: number;
}

export interface LevoPrinterPlugin {
  getEnvironment(): Promise<LevoNativeEnvironment>;
  discoverPrinters(): Promise<{ printers: LevoDiscoveredPrinter[] }>;
  connect(options: LevoPrinterConnection): Promise<LevoPrinterStatus>;
  disconnect(): Promise<LevoPrinterStatus>;
  getStatus(): Promise<LevoPrinterStatus>;
  beginPrintJob(options: LevoPrintJobMetadata & { idempotencyKey: string }): Promise<{ transferId: string }>;
  writePrintJobChunk(options: {
    transferId: string;
    asset: "project" | "gcode";
    index: number;
    base64: string;
  }): Promise<{ accepted: boolean }>;
  commitPrintJob(options: {
    transferId: string;
    projectSha256: string;
    gcodeSha256: string;
  }): Promise<{ jobId: string; state: string }>;
  cancelPrintJob(options: { transferId: string }): Promise<void>;
}

export interface LevoUpdateStatus {
  currentVersionCode: number;
  currentVersionName: string;
  latestVersionCode: number;
  latestVersionName: string;
  sizeBytes: number;
  available: boolean;
}

export interface LevoUpdaterPlugin {
  checkForUpdate(): Promise<LevoUpdateStatus>;
  installUpdate(): Promise<{ installerOpened: boolean }>;
}

declare global {
  interface Window {
    Capacitor?: {
      getPlatform?: () => string;
      isNativePlatform?: () => boolean;
      Plugins?: { LevoPrinter?: LevoPrinterPlugin; LevoUpdater?: LevoUpdaterPlugin };
    };
  }
}

const NO_CAPABILITIES: LevoPrinterCapabilities = {
  discovery: false,
  lanConnection: false,
  telemetry: false,
  rawGcodePrintJob: false,
  packagePrintJob: false,
  fileTransfer: false,
  startPrint: false,
};

const CHUNK_BYTES = 192 * 1024;

export class LevoBridgeUnavailableError extends Error {
  constructor() {
    super("LEVO Printer Bridge is available only inside the signed LEVO mobile app.");
    this.name = "LevoBridgeUnavailableError";
  }
}

function nativePlugin() {
  return window.Capacitor?.Plugins?.LevoPrinter ?? null;
}

export async function detectNativePrinterEnvironment(): Promise<LevoNativeEnvironment> {
  const capacitor = window.Capacitor;
  const native = Boolean(capacitor?.isNativePlatform?.());
  const rawPlatform = capacitor?.getPlatform?.();
  const platform: LevoNativePlatform = rawPlatform === "ios" || rawPlatform === "android" ? rawPlatform : "web";
  const plugin = nativePlugin();
  if (!native || !plugin) return { native, platform, bridgeVersion: null, capabilities: NO_CAPABILITIES };

  try {
    const environment = await plugin.getEnvironment();
    return {
      native: true,
      platform,
      bridgeVersion: environment.bridgeVersion,
      capabilities: { ...NO_CAPABILITIES, ...environment.capabilities },
    };
  } catch {
    return { native: true, platform, bridgeVersion: null, capabilities: NO_CAPABILITIES };
  }
}

export function isPrivatePrinterAddress(value: string) {
  const address = value.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,62}\.local$/.test(address)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function requirePlugin() {
  const plugin = nativePlugin();
  if (!plugin) throw new LevoBridgeUnavailableError();
  return plugin;
}

export async function discoverNativePrinters() {
  return (await requirePlugin().discoverPrinters()).printers;
}

export async function connectNativePrinter(options: LevoPrinterConnection) {
  if (!isPrivatePrinterAddress(options.ip)) throw new Error("Enter a private LAN address or a .local host name.");
  const accessCode = options.accessCode.trim();
  if (accessCode.length < 6 || accessCode.length > 32) throw new Error("The printer access code is invalid.");
  const serial = options.serial?.trim();
  if (!serial || !/^[a-z0-9_-]{6,64}$/i.test(serial)) throw new Error("Enter the printer serial number shown on its Device screen.");
  const first = await requirePlugin().connect({ ...options, ip: options.ip.trim(), accessCode, serial, remember: false });
  if (!first.requiresTrust || !first.certificateFingerprint) return first;
  const grouped = first.certificateFingerprint.match(/.{1,2}/g)?.join(":") ?? first.certificateFingerprint;
  const fileGrouped = first.fileTransferFingerprint?.match(/.{1,2}/g)?.join(":") ?? first.fileTransferFingerprint;
  const fingerprints = fileGrouped
    ? `MQTT 8883:\n${grouped}\n\nFTPS 990:\n${fileGrouped}`
    : `MQTT 8883:\n${grouped}\n\nFTPS 990: unavailable (status-only connection)`;
  const approved = window.confirm(`Verify this printer's encrypted LAN certificates:\n\n${fingerprints}\n\nOnly continue if the IP and serial match the printer in front of you.`);
  if (!approved) throw new Error("Printer certificate approval was cancelled.");
  return requirePlugin().connect({
    ...options,
    ip: options.ip.trim(),
    accessCode,
    serial,
    remember: false,
    trustedFingerprint: first.certificateFingerprint,
    trustedFileFingerprint: first.fileTransferFingerprint,
  });
}

export async function disconnectNativePrinter() {
  return requirePlugin().disconnect();
}

export async function getNativePrinterStatus() {
  return requirePlugin().getStatus();
}

export async function checkForNativeUpdate() {
  const updater = window.Capacitor?.Plugins?.LevoUpdater;
  if (!updater) return null;
  return updater.checkForUpdate();
}

export async function installNativeUpdate() {
  const updater = window.Capacitor?.Plugins?.LevoUpdater;
  if (!updater) throw new LevoBridgeUnavailableError();
  return updater.installUpdate();
}

export async function sha256Hex(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

async function sendAsset(
  plugin: LevoPrinterPlugin,
  transferId: string,
  asset: "project" | "gcode",
  file: Blob,
  completedBefore: number,
  totalBytes: number,
  onProgress?: (ratio: number) => void,
) {
  let index = 0;
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    const result = await plugin.writePrintJobChunk({ transferId, asset, index, base64: bytesToBase64(bytes) });
    if (!result.accepted) throw new Error(`The native bridge rejected ${asset} chunk ${index}.`);
    onProgress?.(Math.min(1, (completedBefore + offset + bytes.byteLength) / totalBytes));
    index += 1;
  }
}

export async function sendNativePrintJob(options: {
  project?: File;
  gcode: File;
  metadata: Omit<LevoPrintJobMetadata, "projectBytes" | "gcodeBytes">;
  onProgress?: (ratio: number) => void;
}) {
  const plugin = requirePlugin();
  const project = options.project ?? new File([], "levo-local-print.3mf", { type: "model/3mf" });
  const totalBytes = project.size + options.gcode.size;
  const idempotencyKey = crypto.randomUUID();
  const transfer = await plugin.beginPrintJob({
    ...options.metadata,
    idempotencyKey,
    projectBytes: project.size,
    gcodeBytes: options.gcode.size,
  });

  try {
    const [projectSha256, gcodeSha256] = await Promise.all([sha256Hex(project), sha256Hex(options.gcode)]);
    if (project.size) await sendAsset(plugin, transfer.transferId, "project", project, 0, totalBytes, options.onProgress);
    await sendAsset(plugin, transfer.transferId, "gcode", options.gcode, project.size, totalBytes, options.onProgress);
    const result = await plugin.commitPrintJob({ transferId: transfer.transferId, projectSha256, gcodeSha256 });
    options.onProgress?.(1);
    return result;
  } catch (error) {
    await plugin.cancelPrintJob({ transferId: transfer.transferId }).catch(() => undefined);
    throw error;
  }
}
