import { pointerJoin } from '../refs.js';
import type { SecurityRequirement } from '../types.js';

import type { DiffContext, Loc } from './context.js';

/** True when an alternative places no requirement at all (anonymous access). */
function isAnonymous(requirement: SecurityRequirement): boolean {
  return Object.keys(requirement).length === 0;
}

function schemeNames(requirement: SecurityRequirement): string[] {
  return Object.keys(requirement).sort();
}

/**
 * Pair up alternatives between the two lists by how many scheme names they
 * share.
 *
 * OpenAPI's `security` is an unordered list of alternatives, so there is no
 * identity to match on. Greedy best-overlap matching gives the reading a human
 * would take: `[{apiKey}]` becoming `[{apiKey, mfa}]` is one alternative that
 * gained a scheme, not one removed and one added.
 */
function pairAlternatives(
  before: SecurityRequirement[],
  after: SecurityRequirement[],
): {
  pairs: Array<[number, number]>;
  removed: number[];
  added: number[];
} {
  const candidates: Array<{ overlap: number; oldIndex: number; newIndex: number }> = [];
  before.forEach((oldReq, oldIndex) => {
    const oldNames = new Set(schemeNames(oldReq));
    after.forEach((newReq, newIndex) => {
      const overlap = schemeNames(newReq).filter((n) => oldNames.has(n)).length;
      if (overlap > 0) candidates.push({ overlap, oldIndex, newIndex });
    });
  });
  // Highest overlap first; ties broken by position so results are deterministic.
  candidates.sort(
    (a, b) =>
      b.overlap - a.overlap || a.oldIndex - b.oldIndex || a.newIndex - b.newIndex,
  );

  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const { oldIndex, newIndex } of candidates) {
    if (usedOld.has(oldIndex) || usedNew.has(newIndex)) continue;
    usedOld.add(oldIndex);
    usedNew.add(newIndex);
    pairs.push([oldIndex, newIndex]);
  }
  pairs.sort((a, b) => a[0] - b[0]);

  return {
    pairs,
    removed: before.map((_, i) => i).filter((i) => !usedOld.has(i)),
    added: after.map((_, i) => i).filter((i) => !usedNew.has(i)),
  };
}

/**
 * Compare the security requirements of an operation.
 *
 * The lists passed in must already be *effective* requirements: OpenAPI lets an
 * operation's `security` override the document-level default, and an absent
 * operation-level list means "inherit", not "none".
 */
export function diffSecurity(
  before: SecurityRequirement[],
  after: SecurityRequirement[],
  ctx: DiffContext,
  loc: Loc,
): void {
  const oldAnonymous = before.length === 0 || before.some(isAnonymous);
  const newAnonymous = after.length === 0 || after.some(isAnonymous);

  if (oldAnonymous !== newAnonymous) {
    ctx.add(
      newAnonymous ? 'security.made.optional' : 'security.made.required',
      loc,
      newAnonymous
        ? 'the operation may now be called without credentials'
        : 'the operation now requires credentials',
    );
  }

  const oldReal = before.filter((r) => !isAnonymous(r));
  const newReal = after.filter((r) => !isAnonymous(r));
  const { pairs, removed, added } = pairAlternatives(oldReal, newReal);

  for (const index of added) {
    const requirement = newReal[index];
    if (!requirement) continue;
    ctx.add(
      'security.alternative.added',
      { ...loc, pointer: pointerJoin(loc.pointer, 'security', index) },
      `a new way to authenticate: ${schemeNames(requirement).join(' + ')}`,
      { to: schemeNames(requirement).join(' + ') },
    );
  }
  for (const index of removed) {
    const requirement = oldReal[index];
    if (!requirement) continue;
    ctx.add(
      'security.alternative.removed',
      { ...loc, pointer: pointerJoin(loc.pointer, 'security', index) },
      `authenticating with ${schemeNames(requirement).join(' + ')} is no longer accepted`,
      { from: schemeNames(requirement).join(' + ') },
    );
  }

  for (const [oldIndex, newIndex] of pairs) {
    const oldReq = oldReal[oldIndex];
    const newReq = newReal[newIndex];
    if (!oldReq || !newReq) continue;
    const pairLoc: Loc = {
      ...loc,
      pointer: pointerJoin(loc.pointer, 'security', newIndex),
    };

    const oldNames = schemeNames(oldReq);
    const newNames = schemeNames(newReq);
    for (const name of newNames.filter((n) => !oldNames.includes(n))) {
      ctx.add(
        'security.scheme.added',
        { ...pairLoc, pointer: pointerJoin(pairLoc.pointer, name) },
        `scheme "${name}" must now also be satisfied`,
        { to: name },
      );
    }
    for (const name of oldNames.filter((n) => !newNames.includes(n))) {
      ctx.add(
        'security.scheme.removed',
        { ...pairLoc, pointer: pointerJoin(pairLoc.pointer, name) },
        `scheme "${name}" is no longer required`,
        { from: name },
      );
    }

    for (const name of newNames.filter((n) => oldNames.includes(n))) {
      const oldScopes = new Set(oldReq[name] ?? []);
      const newScopes = new Set(newReq[name] ?? []);
      const gained = [...newScopes].filter((s) => !oldScopes.has(s)).sort();
      const lost = [...oldScopes].filter((s) => !newScopes.has(s)).sort();
      const scopeLoc: Loc = {
        ...pairLoc,
        pointer: pointerJoin(pairLoc.pointer, name),
      };
      if (gained.length > 0) {
        ctx.add(
          'security.scopes.added',
          scopeLoc,
          `"${name}" now also requires scope ${gained.join(', ')}`,
          { to: gained.join(', ') },
        );
      }
      if (lost.length > 0) {
        ctx.add(
          'security.scopes.removed',
          scopeLoc,
          `"${name}" no longer requires scope ${lost.join(', ')}`,
          { from: lost.join(', ') },
        );
      }
    }
  }
}
