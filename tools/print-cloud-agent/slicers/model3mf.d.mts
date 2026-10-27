/** Refuse a 3MF's printer-command carriers, remove the slicer config saved in it (see model3mf.mjs). */
export function screen3mf(bytes: Buffer): { ok: true; bytes: Buffer; removed: string[] } | { ok: false; error_code: 'UNSUPPORTED_MODEL_CONTENT'; detail: string };
