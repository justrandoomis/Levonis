export function parseFileSeconds(text: string, into?: Map<string, number>): Map<string, number>;
export function mergeTimings(previous: Record<string, number>, measured: Map<string, number>, currentFiles: string[]): Record<string, number>;
export function main(argv: string[], options?: { root?: string; log?: (message: string) => void; error?: (message: string) => void }): number;
