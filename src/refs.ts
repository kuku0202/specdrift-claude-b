import type { OpenApiDocument } from './types.js';

/** Decode one JSON Pointer token (RFC 6901). */
export function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Encode one JSON Pointer token (RFC 6901). */
export function encodeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Build a JSON Pointer from already-decoded path segments. */
export function pointer(...segments: (string | number)[]): string {
  return segments.length === 0
    ? ''
    : `/${segments.map((s) => encodeToken(String(s))).join('/')}`;
}

/** Append segments to an existing JSON Pointer. */
export function pointerJoin(base: string, ...segments: (string | number)[]): string {
  return base + pointer(...segments);
}

/**
 * Resolves internal `$ref`s against a single document.
 *
 * External references (anything not starting with `#/`) are left alone: they
 * would require fetching further documents, and the bundled specifications
 * published by real APIs use internal references throughout. An unresolvable
 * reference is returned as-is so the diff degrades to comparing the reference
 * strings rather than failing.
 */
export class RefResolver {
  readonly #document: OpenApiDocument;
  readonly #cache = new Map<string, unknown>();

  constructor(document: OpenApiDocument) {
    this.#document = document;
  }

  /** True when `node` is a reference object. */
  static isRef(node: unknown): node is { $ref: string } {
    return (
      typeof node === 'object' &&
      node !== null &&
      typeof (node as { $ref?: unknown }).$ref === 'string'
    );
  }

  /**
   * Follow `$ref` chains until a concrete node is reached.
   *
   * @returns The resolved node, and the pointer it was reached through when a
   * reference was followed. A reference that cannot be resolved yields the
   * original node.
   */
  resolve<T>(node: T): { value: T; ref?: string } {
    if (!RefResolver.isRef(node)) return { value: node };

    let current: unknown = node;
    let ref: string | undefined;
    const seen = new Set<string>();

    while (RefResolver.isRef(current)) {
      const target = current.$ref;
      // A $ref chain that loops back on itself would spin forever.
      if (seen.has(target)) break;
      seen.add(target);
      const resolved = this.#lookup(target);
      if (resolved === undefined) break;
      ref = target;
      current = resolved;
    }

    return ref === undefined ? { value: node } : { value: current as T, ref };
  }

  #lookup(ref: string): unknown {
    if (this.#cache.has(ref)) return this.#cache.get(ref);
    if (!ref.startsWith('#/')) return undefined;

    let node: unknown = this.#document;
    for (const raw of ref.slice(2).split('/')) {
      if (node === null || typeof node !== 'object') return undefined;
      const key = decodeToken(raw);
      node = (node as Record<string, unknown>)[key];
      if (node === undefined) return undefined;
    }
    this.#cache.set(ref, node);
    return node;
  }
}
