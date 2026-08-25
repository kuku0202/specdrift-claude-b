import { readFileSync } from 'node:fs';

/**
 * specdrift's own version, read from the package manifest.
 *
 * Resolved at import time from disk rather than inlined at build time, so a
 * published build and a source checkout always report the same number.
 */
function readVersion(): string {
  try {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const { version } = JSON.parse(manifest) as { version?: string };
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = readVersion();
