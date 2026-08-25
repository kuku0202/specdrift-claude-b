import { RefResolver } from '../refs.js';
import { severityFor, type ChangeKind } from '../severity.js';
import type {
  Change,
  ChangeArea,
  Direction,
  HttpMethod,
  OpenApiDocument,
} from '../types.js';

import { createEqualityChecker } from './equal.js';

/** Where in the document a change was found. */
export interface Loc {
  /** JSON Pointer to the changed member. */
  pointer: string;
  path?: string;
  method?: HttpMethod;
  operationId?: string;
  direction?: Direction;
}

/** Optional before/after values recorded on a change. */
export interface ChangeValues {
  from?: string | undefined;
  to?: string | undefined;
}

const AREA_BY_PREFIX: ReadonlyArray<[string, ChangeArea]> = [
  ['endpoint.', 'endpoint'],
  ['operation.', 'endpoint'],
  ['operationId.', 'endpoint'],
  ['parameter.', 'parameter'],
  ['requestBody.', 'requestBody'],
  ['response.', 'response'],
  ['schema.', 'schema'],
  ['security.', 'security'],
];

function areaFor(kind: ChangeKind): ChangeArea {
  for (const [prefix, area] of AREA_BY_PREFIX) {
    if (kind.startsWith(prefix)) return area;
  }
  /* c8 ignore next -- every kind in RULES matches a prefix; guarded by a test */
  return 'endpoint';
}

/**
 * Shared state for one diff run: the two documents, their `$ref` resolvers,
 * the equality fast path, and the accumulating list of changes.
 */
export class DiffContext {
  readonly oldRefs: RefResolver;
  readonly newRefs: RefResolver;
  readonly maxDepth: number;
  readonly changes: Change[] = [];
  /** Structural equality across the two documents, following `$ref`s. */
  readonly equal: (a: unknown, b: unknown) => boolean;

  constructor(
    readonly oldDocument: OpenApiDocument,
    readonly newDocument: OpenApiDocument,
    options: { maxDepth?: number } = {},
  ) {
    this.oldRefs = new RefResolver(oldDocument);
    this.newRefs = new RefResolver(newDocument);
    this.maxDepth = options.maxDepth ?? 24;
    this.equal = createEqualityChecker(this.oldRefs, this.newRefs);
  }

  /** Record a change, resolving its severity from the taxonomy. */
  add(kind: ChangeKind, loc: Loc, message: string, values: ChangeValues = {}): void {
    this.changes.push({
      kind,
      severity: severityFor(kind, loc.direction),
      area: areaFor(kind),
      message,
      pointer: loc.pointer,
      ...(loc.direction === undefined ? {} : { direction: loc.direction }),
      ...(loc.path === undefined ? {} : { path: loc.path }),
      ...(loc.method === undefined ? {} : { method: loc.method }),
      ...(loc.operationId === undefined ? {} : { operationId: loc.operationId }),
      ...(values.from === undefined ? {} : { from: values.from }),
      ...(values.to === undefined ? {} : { to: values.to }),
    });
  }
}

/** Human-readable label for an operation, used in messages. */
export function label(loc: Loc): string {
  if (loc.method && loc.path) return `${loc.method.toUpperCase()} ${loc.path}`;
  return loc.path ?? '(document)';
}
