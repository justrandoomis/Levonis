declare module "occt-import-js" {
  interface OcctFactoryOptions {
    locateFile?: (path: string) => string;
  }

  interface OcctModule {
    ReadStepFile(data: Uint8Array, params: Record<string, unknown>): unknown;
    ReadIgesFile(data: Uint8Array, params: Record<string, unknown>): unknown;
    ReadBrepFile(data: Uint8Array, params: Record<string, unknown>): unknown;
  }

  export default function occtImportJs(options?: OcctFactoryOptions): Promise<OcctModule>;
}
