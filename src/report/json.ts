import type { DiffResult } from '../types.js';

/**
 * Render a diff as JSON.
 *
 * The shape is stable and deliberately free of timestamps or absolute paths
 * beyond the inputs the caller supplied, so two runs over the same pair of
 * documents produce byte-identical output. That makes the report safe to commit
 * as a fixture or compare in CI.
 */
export function renderJson(result: DiffResult, indent = 2): string {
  return `${JSON.stringify(result, null, indent)}\n`;
}
