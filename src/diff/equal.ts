import { RefResolver } from '../refs.js';

/**
 * Structural equality across two documents, following `$ref`s.
 *
 * Most subtrees of two versions of a real specification are identical. Proving
 * that cheaply - and memoising the answer per `$ref` pair - is what keeps a
 * multi-megabyte diff fast: the detailed comparison then only runs on the parts
 * that actually differ.
 *
 * Recursive schemas (a `team` whose `parent` is a `team`) are handled
 * coinductively: a pair already on the stack is *assumed* equal so the walk
 * terminates. A result that depended on such an assumption is not memoised,
 * since the assumption may not survive a sibling branch.
 */
export function createEqualityChecker(
  oldRefs: RefResolver,
  newRefs: RefResolver,
): (a: unknown, b: unknown) => boolean {
  const memo = new Map<string, boolean>();
  const stack = new Set<string>();
  /** Depth at which the innermost cycle assumption was used, if any. */
  let assumptionDepth = Number.POSITIVE_INFINITY;
  let depth = 0;

  function eq(a: unknown, b: unknown): boolean {
    const aRef = RefResolver.isRef(a) ? a.$ref : undefined;
    const bRef = RefResolver.isRef(b) ? b.$ref : undefined;

    if (aRef !== undefined && bRef !== undefined) {
      const key = `${aRef} ${bRef}`;
      if (stack.has(key)) {
        assumptionDepth = Math.min(assumptionDepth, depth);
        return true;
      }
      const cached = memo.get(key);
      if (cached !== undefined) return cached;

      stack.add(key);
      depth += 1;
      const outerAssumption = assumptionDepth;
      assumptionDepth = Number.POSITIVE_INFINITY;

      const result = eq(oldRefs.resolve(a).value, newRefs.resolve(b).value);

      const usedAssumption = assumptionDepth <= depth;
      depth -= 1;
      stack.delete(key);
      // Propagate the assumption upward so enclosing frames also skip memoising.
      assumptionDepth = Math.min(outerAssumption, assumptionDepth);

      if (!usedAssumption) memo.set(key, result);
      return result;
    }

    if (aRef !== undefined) return eq(oldRefs.resolve(a).value, b);
    if (bRef !== undefined) return eq(a, newRefs.resolve(b).value);

    return plainEqual(a, b, eq);
  }

  return (a, b) => eq(a, b);
}

function plainEqual(
  a: unknown,
  b: unknown,
  recurse: (x: unknown, y: unknown) => boolean,
): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => recurse(item, b[index]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bObj, key)) return false;
    if (!recurse(aObj[key], bObj[key])) return false;
  }
  return true;
}
