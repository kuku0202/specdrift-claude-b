/**
 * specdrift - diff two OpenAPI 3.x specifications and classify what changed.
 *
 * The entry point most callers want is {@link diffSpecs}, which accepts file
 * paths or https URLs. {@link diffDocuments} does the same work on documents
 * that are already parsed.
 *
 * @example Fail a build on breaking changes
 * ```ts
 * import { diffSpecs, meetsThreshold } from '@yuesu4/specdrift-claude-b';
 *
 * const result = await diffSpecs('./v1.yaml', 'https://example.com/v2.yaml');
 * const broken = result.changes.filter((c) => meetsThreshold(c.severity, 'breaking'));
 * if (broken.length > 0) process.exitCode = 1;
 * ```
 *
 * @packageDocumentation
 */

import { diffDocuments } from './diff/index.js';
import { loadSpec, type LoadOptions } from './loader.js';
import type { DiffOptions, DiffResult } from './types.js';

export * from './types.js';

export {
  RULES,
  CHANGE_KINDS,
  isSeverity,
  maxSeverity,
  meetsThreshold,
  rationaleFor,
  severityFor,
  severityRank,
  type ChangeKind,
  type SeverityRule,
} from './severity.js';

export {
  isUrl,
  loadSpec,
  parseSpec,
  SpecLoadError,
  type LoadOptions,
  type LoadedSpec,
} from './loader.js';

export {
  cacheDir,
  cacheStats,
  clearCache,
  DEFAULT_TTL_MS,
  type CacheEntry,
  type CacheMeta,
  type EnvLike,
} from './cache.js';

export { RefResolver, pointer, pointerJoin } from './refs.js';

export {
  diffDocuments,
  diffSchema,
  diffSecurity,
  effectiveParameters,
  effectiveSecurity,
  flattenSchema,
  isSuccessStatus,
  normalizeType,
  sortChanges,
  DiffContext,
} from './diff/index.js';

export { renderText, type TextReportOptions } from './report/text.js';
export { renderJson } from './report/json.js';
export { renderRulesMarkdown, renderRulesText } from './report/rules.js';

export { VERSION } from './version.js';

/** Options for {@link diffSpecs}: everything the loader and the differ accept. */
export interface DiffSpecsOptions extends LoadOptions, DiffOptions {}

/**
 * Load two specifications and diff them.
 *
 * Each input may be a local file path or an `http(s)` URL. Remote documents are
 * fetched concurrently and cached on disk; pass `noCache` to bypass the cache.
 *
 * @param oldInput - Path or URL of the baseline specification.
 * @param newInput - Path or URL of the specification to compare.
 * @param options - Loader and diff options.
 * @returns The classified set of differences.
 * @throws {@link SpecLoadError} when either document cannot be read or parsed.
 */
export async function diffSpecs(
  oldInput: string,
  newInput: string,
  options: DiffSpecsOptions = {},
): Promise<DiffResult> {
  const [before, after] = await Promise.all([
    loadSpec(oldInput, options),
    loadSpec(newInput, options),
  ]);
  return diffDocuments(
    before.document,
    after.document,
    { old: before.source, new: after.source },
    options,
  );
}
