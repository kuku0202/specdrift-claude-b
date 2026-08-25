/**
 * Core types for specdrift's public API.
 *
 * The OpenAPI types here are deliberately loose: specdrift is a *differ*, not a
 * validator. It reads the parts of a document it understands and ignores the
 * rest, so that a spec with vendor extensions or a not-yet-supported keyword
 * still produces a useful report instead of an error.
 */

/** HTTP methods that OpenAPI treats as operations on a Path Item Object. */
export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * How severely a change affects an existing, conforming consumer of the API.
 * Ordered most to least severe; see `SEVERITY_ORDER`.
 */
export type Severity = 'breaking' | 'warning' | 'additive' | 'informational';

/** Severities from most to least severe. */
export const SEVERITY_ORDER = [
  'breaking',
  'warning',
  'additive',
  'informational',
] as const satisfies readonly Severity[];

/**
 * Which side of the request/response contract a change sits on.
 *
 * This matters because the two sides break in opposite directions: narrowing
 * what a server *accepts* breaks callers, while narrowing what a server
 * *returns* breaks readers. See the taxonomy section of the README.
 */
export type Direction = 'request' | 'response';

/** Broad area of the document a change was found in. */
export type ChangeArea =
  | 'endpoint'
  | 'parameter'
  | 'requestBody'
  | 'response'
  | 'schema'
  | 'security';

/** A single detected difference between two specifications. */
export interface Change {
  /** Stable machine-readable identifier, e.g. `parameter.required.added`. */
  kind: string;
  severity: Severity;
  area: ChangeArea;
  /** Request/response side, when the change has one. */
  direction?: Direction;
  /** Templated path the change belongs to, e.g. `/pets/{petId}`. */
  path?: string;
  /** HTTP method, when the change is scoped to a single operation. */
  method?: HttpMethod;
  /** `operationId` of the affected operation, when the document declares one. */
  operationId?: string;
  /** Human-readable one-line description of the change. */
  message: string;
  /**
   * JSON Pointer (RFC 6901) to the changed member, rooted at the document it
   * best describes: the old document for removals, the new one otherwise.
   */
  pointer: string;
  /** Previous value, for changes that replace one value with another. */
  from?: string;
  /** New value, for changes that replace one value with another. */
  to?: string;
}

/** Count of changes at each severity. */
export type SeverityCounts = Record<Severity, number>;

/** The result of diffing two specifications. */
export interface DiffResult {
  /**
   * Version of the JSON report shape. Bumped only for a breaking change to the
   * structure, so consumers can pin against it.
   */
  formatVersion: 1;
  /** Version of specdrift that produced the report. */
  specdriftVersion: string;
  source: {
    old: SpecSource;
    new: SpecSource;
  };
  summary: {
    total: number;
    bySeverity: SeverityCounts;
    /** Highest severity present, or `null` when there are no changes at all. */
    highestSeverity: Severity | null;
  };
  changes: Change[];
}

/** Where a specification was read from, and how. */
export interface SpecSource {
  /** The argument as the user supplied it. */
  input: string;
  kind: 'file' | 'url';
  /** API title and version from the document's `info` object, when present. */
  title?: string;
  version?: string;
  /** True when a fetched document was served from the on-disk cache. */
  fromCache?: boolean;
}

/** Options accepted by {@link diffSpecs}. */
export interface DiffOptions {
  /**
   * Maximum depth to follow nested schemas before stopping. Guards against
   * pathological nesting; recursive `$ref` cycles are detected separately and
   * are not affected by this limit.
   *
   * @defaultValue 24
   */
  maxDepth?: number;
}

/** A parsed OpenAPI document. Loosely typed on purpose — see module docs. */
export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem | undefined>;
  components?: Record<string, unknown>;
  security?: SecurityRequirement[];
  [key: string]: unknown;
}

export interface PathItem {
  $ref?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  [method: string]: unknown;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, Response | undefined>;
  security?: SecurityRequirement[];
  [key: string]: unknown;
}

export interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: Schema;
  content?: Record<string, MediaType | undefined>;
  [key: string]: unknown;
}

export interface RequestBody {
  $ref?: string;
  required?: boolean;
  content?: Record<string, MediaType | undefined>;
  [key: string]: unknown;
}

export interface Response {
  $ref?: string;
  description?: string;
  headers?: Record<string, Parameter | undefined>;
  content?: Record<string, MediaType | undefined>;
  [key: string]: unknown;
}

export interface MediaType {
  schema?: Schema;
  [key: string]: unknown;
}

export interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, Schema | undefined>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  [key: string]: unknown;
}

/** One alternative in an OpenAPI `security` list: scheme name -> scopes. */
export type SecurityRequirement = Record<string, string[]>;
