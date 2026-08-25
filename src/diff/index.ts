import { pointerJoin } from '../refs.js';
import { maxSeverity, severityRank } from '../severity.js';
import {
  HTTP_METHODS,
  type Change,
  type DiffOptions,
  type DiffResult,
  type HttpMethod,
  type OpenApiDocument,
  type Operation,
  type PathItem,
  type Severity,
  type SeverityCounts,
  type SpecSource,
} from '../types.js';
import { VERSION } from '../version.js';

import { DiffContext, type Loc } from './context.js';
import { diffOperation } from './operation.js';

export { DiffContext } from './context.js';
export { diffSchema, flattenSchema, normalizeType } from './schema.js';
export { diffSecurity } from './security.js';
export { effectiveParameters, effectiveSecurity, isSuccessStatus } from './operation.js';

function operationsOf(pathItem: PathItem | undefined): Map<HttpMethod, Operation> {
  const result = new Map<HttpMethod, Operation>();
  if (!pathItem) return result;
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (operation !== null && typeof operation === 'object') {
      result.set(method, operation as Operation);
    }
  }
  return result;
}

/**
 * Compare two parsed OpenAPI documents.
 *
 * The two documents are walked in lockstep: paths, then methods, then each
 * operation's parameters, request body, responses and security. Changes are
 * returned sorted by severity and then by location, so the output is stable
 * across runs and safe to commit or snapshot.
 *
 * @param oldDocument - The baseline specification.
 * @param newDocument - The specification to compare against the baseline.
 * @param sources - Provenance recorded in the report.
 * @param options - Tuning knobs; see {@link DiffOptions}.
 */
export function diffDocuments(
  oldDocument: OpenApiDocument,
  newDocument: OpenApiDocument,
  sources: { old: SpecSource; new: SpecSource },
  options: DiffOptions = {},
): DiffResult {
  const ctx = new DiffContext(oldDocument, newDocument, options);

  const oldPaths = oldDocument.paths ?? {};
  const newPaths = newDocument.paths ?? {};
  const allPaths = new Set([...Object.keys(oldPaths), ...Object.keys(newPaths)]);

  for (const path of [...allPaths].sort()) {
    const inOld = Object.hasOwn(oldPaths, path);
    const inNew = Object.hasOwn(newPaths, path);
    const pointer = pointerJoin('/paths', path);

    if (!inOld && inNew) {
      ctx.add('endpoint.added', { pointer, path }, `path ${path} added`);
      continue;
    }
    if (inOld && !inNew) {
      ctx.add('endpoint.removed', { pointer, path }, `path ${path} removed`);
      continue;
    }

    // A Path Item may itself be a $ref in OpenAPI 3.1.
    const oldItem = ctx.oldRefs.resolve(oldPaths[path]).value;
    const newItem = ctx.newRefs.resolve(newPaths[path]).value;
    const oldOperations = operationsOf(oldItem);
    const newOperations = operationsOf(newItem);
    const methods = new Set([...oldOperations.keys(), ...newOperations.keys()]);

    for (const method of HTTP_METHODS.filter((m) => methods.has(m))) {
      const oldOperation = oldOperations.get(method);
      const newOperation = newOperations.get(method);
      const operationId =
        newOperation?.operationId ?? oldOperation?.operationId ?? undefined;
      const loc: Loc = {
        pointer: pointerJoin(pointer, method),
        path,
        method,
        ...(typeof operationId === 'string' ? { operationId } : {}),
      };

      if (!oldOperation && newOperation) {
        ctx.add('operation.added', loc, `${method.toUpperCase()} ${path} added`);
        continue;
      }
      if (oldOperation && !newOperation) {
        ctx.add('operation.removed', loc, `${method.toUpperCase()} ${path} removed`);
        continue;
      }
      if (!oldOperation || !newOperation) continue;

      diffOperation(oldItem, newItem, oldOperation, newOperation, ctx, loc);
    }
  }

  const changes = sortChanges(ctx.changes);
  return {
    formatVersion: 1,
    specdriftVersion: VERSION,
    source: sources,
    summary: summarise(changes),
    changes,
  };
}

/** Sort changes most-severe first, then by location, for stable output. */
export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    const byPath = (a.path ?? '').localeCompare(b.path ?? '');
    if (byPath !== 0) return byPath;
    const byMethod = (a.method ?? '').localeCompare(b.method ?? '');
    if (byMethod !== 0) return byMethod;
    const byPointer = a.pointer.localeCompare(b.pointer);
    if (byPointer !== 0) return byPointer;
    return a.kind.localeCompare(b.kind);
  });
}

function summarise(changes: Change[]): DiffResult['summary'] {
  const bySeverity: SeverityCounts = {
    breaking: 0,
    warning: 0,
    additive: 0,
    informational: 0,
  };
  for (const change of changes) bySeverity[change.severity] += 1;
  const highest: Severity | null = maxSeverity(changes.map((c) => c.severity));
  return { total: changes.length, bySeverity, highestSeverity: highest };
}
