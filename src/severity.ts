import type { Direction, Severity } from './types.js';
import { SEVERITY_ORDER } from './types.js';

/**
 * A severity ruling, plus the reasoning behind it.
 *
 * Where a ruling is a plain {@link Severity} the change breaks (or doesn't)
 * regardless of which side of the contract it lands on. Where it is split by
 * {@link Direction}, the two sides genuinely disagree — see the README.
 */
export interface SeverityRule {
  severity: Severity | { request: Severity; response: Severity };
  /** Why this ruling, phrased from the perspective of an existing consumer. */
  rationale: string;
}

/**
 * The complete severity taxonomy.
 *
 * This table *is* the specification of specdrift's judgement. The README's
 * taxonomy section is generated from it (`npm run docs:rules`) and a test
 * asserts the two agree, so the documentation cannot drift from the code.
 */
export const RULES = {
  // ---------------------------------------------------------------- endpoints
  'endpoint.added': {
    severity: 'additive',
    rationale: 'New surface area. No existing call changes behaviour.',
  },
  'endpoint.removed': {
    severity: 'breaking',
    rationale: 'Every existing call to the path now fails.',
  },
  'operation.added': {
    severity: 'additive',
    rationale: 'A new method on an existing path leaves other methods untouched.',
  },
  'operation.removed': {
    severity: 'breaking',
    rationale: 'Callers using this method now receive 404 or 405.',
  },
  'operation.deprecated': {
    severity: 'informational',
    rationale:
      'Deprecation announces a future removal; it does not itself change behaviour.',
  },
  'operationId.changed': {
    severity: 'warning',
    rationale:
      'operationId names the generated method in most client generators, so renaming it renames a public method in every regenerated SDK.',
  },

  // --------------------------------------------------------------- parameters
  'parameter.added.required': {
    severity: 'breaking',
    rationale: 'Existing requests omit the parameter and will be rejected.',
  },
  'parameter.added.optional': {
    severity: 'additive',
    rationale: 'Requests that ignore the new parameter are still valid.',
  },
  'parameter.removed': {
    severity: 'warning',
    rationale:
      'The server may reject the now-undeclared parameter, or silently ignore it — and silently dropping a caller-supplied value is the more dangerous of the two.',
  },
  'parameter.required.added': {
    severity: 'breaking',
    rationale: 'Requests that previously omitted the parameter are now invalid.',
  },
  'parameter.required.removed': {
    severity: 'additive',
    rationale: 'The server accepts strictly more requests than before.',
  },
  'parameter.deprecated': {
    severity: 'informational',
    rationale: 'An announcement about a future removal, not a behaviour change.',
  },

  // ------------------------------------------------------------- request body
  'requestBody.added.required': {
    severity: 'breaking',
    rationale: 'Existing requests send no body and will be rejected.',
  },
  'requestBody.added.optional': {
    severity: 'additive',
    rationale: 'Requests without a body remain valid.',
  },
  'requestBody.removed': {
    severity: 'warning',
    rationale:
      'The body a caller still sends is now undeclared: it may be rejected, or accepted and ignored.',
  },
  'requestBody.required.added': {
    severity: 'breaking',
    rationale: 'A body that was optional is now mandatory.',
  },
  'requestBody.required.removed': {
    severity: 'additive',
    rationale: 'The server accepts strictly more requests than before.',
  },
  'requestBody.mediaType.added': {
    severity: 'additive',
    rationale: 'An additional way to encode the same request.',
  },
  'requestBody.mediaType.removed': {
    severity: 'breaking',
    rationale:
      'Callers sending this Content-Type now receive 415 Unsupported Media Type.',
  },

  // ----------------------------------------------------------------- responses
  'response.success.added': {
    severity: 'warning',
    rationale:
      'Clients that test for an exact success code (status === 200) rather than a range will not recognise the new one.',
  },
  'response.error.added': {
    severity: 'additive',
    rationale:
      'A newly documented failure mode. Generic error handling already covers it.',
  },
  'response.success.removed': {
    severity: 'breaking',
    rationale: 'The success status the client was written against is no longer returned.',
  },
  'response.error.removed': {
    severity: 'warning',
    rationale:
      'The error contract narrowed: handling for this code is now dead, and the underlying condition may surface as a different code.',
  },
  'response.mediaType.added': {
    severity: 'additive',
    rationale: 'An additional representation the client may opt into.',
  },
  'response.mediaType.removed': {
    severity: 'breaking',
    rationale: 'Clients requesting this Content-Type can no longer be served.',
  },
  'response.header.added': {
    severity: 'additive',
    rationale: 'Clients ignore headers they do not read.',
  },
  'response.header.removed': {
    severity: 'breaking',
    rationale: 'A header the client may depend on is no longer sent.',
  },

  // ------------------------------------------------------------------ schemas
  'schema.property.added': {
    severity: 'additive',
    rationale:
      'On a request the server accepts more; on a response clients ignore fields they do not read.',
  },
  'schema.property.added.required': {
    severity: { request: 'breaking', response: 'additive' },
    rationale:
      'A new mandatory input invalidates every existing request body. In a response it is simply one more guaranteed field.',
  },
  'schema.property.removed': {
    severity: { request: 'warning', response: 'breaking' },
    rationale:
      'A request property may be rejected as unknown or silently dropped; a response property the client reads is simply gone.',
  },
  'schema.type.changed': {
    severity: 'breaking',
    rationale:
      'A value of the old type is not a value of the new one, in either direction.',
  },
  'schema.format.changed': {
    severity: 'warning',
    rationale:
      'format narrows a type without changing it (int32 to int64, date to date-time). Whether it breaks depends on the parser at the other end, so specdrift cannot prove it safe.',
  },
  'schema.required.added': {
    severity: { request: 'breaking', response: 'additive' },
    rationale:
      'A newly required field invalidates existing request bodies, but strengthens a response guarantee.',
  },
  'schema.required.removed': {
    severity: { request: 'additive', response: 'breaking' },
    rationale:
      'Dropping a requirement widens what a request may look like, but withdraws a guarantee the client relied on when reading a response.',
  },
  'schema.enum.value.added': {
    severity: { request: 'additive', response: 'warning' },
    rationale:
      'The server accepts one more input value; but a client parsing a response into a closed type (an enum, a sealed class, an exhaustive switch) will fail on a value it has never seen.',
  },
  'schema.enum.value.removed': {
    severity: { request: 'breaking', response: 'additive' },
    rationale:
      'A value callers are sending is no longer accepted. In a response, one fewer case to handle.',
  },
  'schema.nullable.added': {
    severity: { request: 'additive', response: 'breaking' },
    rationale:
      'Accepting null widens the input. Returning null where the client never expected one is the classic null-dereference break.',
  },
  'schema.nullable.removed': {
    severity: { request: 'breaking', response: 'additive' },
    rationale: 'Callers sending null are now rejected; readers get a stronger guarantee.',
  },
  'schema.additionalProperties.restricted': {
    severity: { request: 'breaking', response: 'additive' },
    rationale: 'Extra members a caller was sending are now rejected.',
  },
  'schema.additionalProperties.allowed': {
    severity: { request: 'additive', response: 'informational' },
    rationale:
      'The server tolerates more input. On a response it only means undeclared members may appear, which clients already ignore.',
  },
  'schema.constraint.tightened': {
    severity: { request: 'breaking', response: 'warning' },
    rationale:
      'Values a caller was sending now fall outside the accepted range. On a response, a narrower range is safe for most clients but changes what is documented.',
  },
  'schema.constraint.relaxed': {
    severity: { request: 'additive', response: 'warning' },
    rationale:
      'The server accepts more. On a response, values may now exceed the size the client allocated for them.',
  },
  'schema.composition.changed': {
    severity: 'warning',
    rationale:
      'allOf/oneOf/anyOf was restructured. Compatibility depends on the branches, which specdrift reports rather than attempts to prove.',
  },

  // ----------------------------------------------------------------- security
  'security.alternative.added': {
    severity: 'additive',
    rationale:
      'OpenAPI security is a list of alternatives; one more alternative is one more way to authenticate.',
  },
  'security.alternative.removed': {
    severity: 'breaking',
    rationale: 'Callers authenticating this way are locked out.',
  },
  'security.scheme.added': {
    severity: 'breaking',
    rationale:
      'Schemes within one alternative are combined with AND, so an extra scheme is an extra credential every caller must now present.',
  },
  'security.scheme.removed': {
    severity: 'additive',
    rationale: 'One fewer credential is required.',
  },
  'security.scopes.added': {
    severity: 'breaking',
    rationale: 'Tokens issued without the new scope are rejected.',
  },
  'security.scopes.removed': {
    severity: 'additive',
    rationale: 'The operation demands less of the token than before.',
  },
  'security.made.required': {
    severity: 'breaking',
    rationale: 'Anonymous access was withdrawn.',
  },
  'security.made.optional': {
    severity: 'additive',
    rationale: 'The operation may now be called without credentials.',
  },
} as const satisfies Record<string, SeverityRule>;

/** Every change identifier specdrift can emit. */
export type ChangeKind = keyof typeof RULES;

/** All change kinds, sorted for stable output. */
export const CHANGE_KINDS = Object.keys(RULES).sort() as ChangeKind[];

/**
 * Resolve the severity of a change kind.
 *
 * @param kind - The change identifier.
 * @param direction - Request or response side. Required for direction-split
 * rules; ignored otherwise.
 */
export function severityFor(kind: ChangeKind, direction?: Direction): Severity {
  const { severity } = RULES[kind] as SeverityRule;
  if (typeof severity === 'string') return severity;
  if (!direction) {
    // A direction-split rule reached without a direction: fall back to the
    // more severe of the two rather than under-reporting.
    return maxSeverity([severity.request, severity.response]) ?? 'breaking';
  }
  return severity[direction];
}

/** The documented reasoning for a change kind. */
export function rationaleFor(kind: ChangeKind): string {
  return (RULES[kind] as SeverityRule).rationale;
}

/** Rank of a severity: 0 is most severe. */
export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** The most severe of the given severities, or `null` when none are given. */
export function maxSeverity(severities: readonly Severity[]): Severity | null {
  let best: Severity | null = null;
  for (const s of severities) {
    if (best === null || severityRank(s) < severityRank(best)) best = s;
  }
  return best;
}

/**
 * True when `severity` is at least as severe as `threshold` — i.e. when a
 * change at that severity should trip `--fail-on <threshold>`.
 */
export function meetsThreshold(severity: Severity, threshold: Severity): boolean {
  return severityRank(severity) <= severityRank(threshold);
}

/** Type guard for strings that name a severity. */
export function isSeverity(value: string): value is Severity {
  return (SEVERITY_ORDER as readonly string[]).includes(value);
}
