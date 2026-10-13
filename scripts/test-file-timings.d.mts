export const FILE_SECONDS_PREFIX: string;
export function fileSecondsFromEvent(event: unknown, cwd?: string): { file: string; seconds: number } | null;
export default function testFileTimings(source: AsyncIterable<unknown>): AsyncGenerator<string>;
