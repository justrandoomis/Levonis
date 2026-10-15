#!/usr/bin/env node
/**
 * Opens a file sealed by workflow 60 (scripts/bambu-import/seal.mjs). Runs in
 * the agent's sandbox ONLY: it needs the one-time private key, which never
 * leaves that machine.
 *
 *   node scripts/bambu-import/unseal.mjs --key <private key file> <in.sealed> <out>
 *
 * Refused, with the reason and exit 1: a file that is not sealed, a version
 * this tool does not read, a file sealed to another key, and any altered or
 * damaged byte (AES-GCM authenticates the header and the ciphertext). The
 * output is written with mode 0600 and never over an existing file. Nothing
 * of the plaintext is printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { unsealBuffer } from './seal.mjs';

const USAGE = 'usage: node scripts/bambu-import/unseal.mjs --key <private key file> <in.sealed> <out>';

export function main(argv, { error = console.error } = {}) {
  if (argv.length !== 4 || argv[0] !== '--key') {
    error(USAGE);
    return 2;
  }
  const [, keyFile, input, output] = argv;
  try {
    const plaintext = unsealBuffer(readFileSync(keyFile), readFileSync(input));
    writeFileSync(output, plaintext, { mode: 0o600, flag: 'wx' });
    error(`unseal: ${output} (${plaintext.length} bytes)`);
    plaintext.fill(0);
    return 0;
  } catch (failure) {
    error(`unseal: refused — ${failure instanceof Error ? failure.message : String(failure)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
