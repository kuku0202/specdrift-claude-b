import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { readCache, touchCache, writeCache, type CacheMeta } from './cache.js';
import type { OpenApiDocument, SpecSource } from './types.js';

/** Raised when a specification cannot be read or parsed. */
export class SpecLoadError extends Error {
  readonly input: string;
  constructor(input: string, message: string, options?: { cause?: unknown }) {
    super(`${input}: ${message}`, options as ErrorOptions);
    this.name = 'SpecLoadError';
    this.input = input;
  }
}

export interface LoadOptions {
  /** Bypass the on-disk cache entirely (neither read nor write). */
  noCache?: boolean;
  /** Override the cache directory. Mainly for tests. */
  cacheDir?: string;
  /** Serve cached documents younger than this without revalidating. */
  ttlMs?: number;
  /** Request timeout in milliseconds. @defaultValue 30000 */
  timeoutMs?: number;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface LoadedSpec {
  document: OpenApiDocument;
  source: SpecSource;
}

const URL_PATTERN = /^https?:\/\//i;

/** True when the input should be treated as a URL rather than a file path. */
export function isUrl(input: string): boolean {
  return URL_PATTERN.test(input);
}

/**
 * Parse a specification from text, accepting JSON or YAML.
 *
 * JSON is attempted first because every JSON document is also valid YAML, and
 * `JSON.parse` is an order of magnitude faster on the multi-megabyte documents
 * real APIs publish.
 */
export function parseSpec(text: string, input = '<inline>'): OpenApiDocument {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      return asDocument(JSON.parse(text), input);
    } catch (cause) {
      throw new SpecLoadError(input, `invalid JSON (${describe(cause)})`, { cause });
    }
  }
  try {
    return asDocument(parseYaml(text), input);
  } catch (cause) {
    throw new SpecLoadError(input, `invalid YAML (${describe(cause)})`, { cause });
  }
}

function asDocument(value: unknown, input: string): OpenApiDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecLoadError(input, 'document is not an object');
  }
  const doc = value as OpenApiDocument;
  if (typeof doc.openapi !== 'string') {
    if (typeof doc.swagger === 'string') {
      throw new SpecLoadError(
        input,
        `this is a Swagger ${doc.swagger} document. specdrift supports OpenAPI 3.x; convert it first`,
      );
    }
    throw new SpecLoadError(input, 'missing the top-level "openapi" version string');
  }
  if (!doc.openapi.startsWith('3.')) {
    throw new SpecLoadError(input, `unsupported OpenAPI version ${doc.openapi}`);
  }
  return doc;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Load a specification from a local path or an http(s) URL.
 *
 * Fetched documents are cached on disk. A cached document younger than the TTL
 * is used as-is; an older one is revalidated with `If-None-Match` /
 * `If-Modified-Since` so an unchanged spec costs one 304 instead of a redownload.
 */
export async function loadSpec(
  input: string,
  options: LoadOptions = {},
): Promise<LoadedSpec> {
  const { text, source } = isUrl(input)
    ? await loadFromUrl(input, options)
    : await loadFromFile(input);
  const document = parseSpec(text, input);
  const info = document.info ?? {};
  return {
    document,
    source: {
      ...source,
      ...(typeof info.title === 'string' ? { title: info.title } : {}),
      ...(typeof info.version === 'string' ? { version: info.version } : {}),
    },
  };
}

async function loadFromFile(
  input: string,
): Promise<{ text: string; source: SpecSource }> {
  try {
    const text = await readFile(resolvePath(input), 'utf8');
    return { text, source: { input, kind: 'file' } };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SpecLoadError(input, 'no such file', { cause });
    if (code === 'EISDIR') throw new SpecLoadError(input, 'is a directory', { cause });
    throw new SpecLoadError(input, `cannot read file (${describe(cause)})`, { cause });
  }
}

async function loadFromUrl(
  input: string,
  options: LoadOptions,
): Promise<{ text: string; source: SpecSource }> {
  const doFetch = options.fetchImpl ?? fetch;
  const cacheOptions = options.cacheDir === undefined ? {} : { dir: options.cacheDir };

  const cached = options.noCache
    ? null
    : await readCache(input, {
        ...cacheOptions,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      });

  if (cached && !cached.stale) {
    return { text: cached.body, source: { input, kind: 'url', fromCache: true } };
  }

  const headers: Record<string, string> = {
    accept: 'application/json, application/yaml, text/yaml;q=0.9, */*;q=0.5',
    'user-agent': 'specdrift',
  };
  // A stale entry is worth revalidating rather than refetching outright.
  if (cached?.meta.etag) headers['if-none-match'] = cached.meta.etag;
  if (cached?.meta.lastModified) headers['if-modified-since'] = cached.meta.lastModified;

  let response: Response;
  try {
    response = await doFetch(input, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (cause) {
    // A stale cache beats a hard failure when the network is unavailable.
    if (cached) {
      return { text: cached.body, source: { input, kind: 'url', fromCache: true } };
    }
    const reason =
      cause instanceof Error && cause.name === 'TimeoutError'
        ? 'request timed out'
        : describe(cause);
    throw new SpecLoadError(input, `fetch failed (${reason})`, { cause });
  }

  if (response.status === 304 && cached) {
    await touchCache(cached.meta, cacheOptions);
    return { text: cached.body, source: { input, kind: 'url', fromCache: true } };
  }

  if (!response.ok) {
    throw new SpecLoadError(input, `HTTP ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  if (!options.noCache) {
    const meta: CacheMeta = {
      url: input,
      fetchedAt: Date.now(),
      ...header(response, 'etag', 'etag'),
      ...header(response, 'last-modified', 'lastModified'),
      ...header(response, 'content-type', 'contentType'),
    };
    await writeCache(meta, text, cacheOptions);
  }
  return { text, source: { input, kind: 'url', fromCache: false } };
}

function header<K extends string>(
  response: Response,
  name: string,
  key: K,
): Record<K, string> | Record<string, never> {
  const value = response.headers.get(name);
  return value === null ? {} : ({ [key]: value } as Record<K, string>);
}
