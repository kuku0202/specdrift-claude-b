import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cacheStats,
  clearCache,
  diffSpecs,
  isUrl,
  loadSpec,
  parseSpec,
  SpecLoadError,
} from '../src/index.js';

import { fixture } from './helpers.js';

const MINIMAL = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Cached API', version: '1.0.0' },
  paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } },
});

describe('parsing', () => {
  it('accepts JSON and YAML spellings of the same document', async () => {
    const fromYaml = await loadSpec(fixture('formats', 'spec.yaml'));
    const fromJson = await loadSpec(fixture('formats', 'spec.json'));
    expect(fromJson.document).toEqual(fromYaml.document);
  });

  it('records title and version from the info object', async () => {
    const { source } = await loadSpec(fixture('formats', 'spec.yaml'));
    expect(source).toMatchObject({ kind: 'file', title: 'Format API', version: '1.0.0' });
  });

  it('rejects a Swagger 2.0 document with an actionable message', () => {
    expect(() => parseSpec('{"swagger":"2.0","info":{}}')).toThrow(/Swagger 2\.0/);
  });

  it('rejects a document with no openapi version', () => {
    expect(() => parseSpec('{"info":{}}')).toThrow(/missing the top-level "openapi"/);
  });

  it('rejects an OpenAPI 4 document rather than guessing', () => {
    expect(() => parseSpec('{"openapi":"4.0.0"}')).toThrow(/unsupported OpenAPI version/);
  });

  it('reports malformed JSON as a load error', () => {
    expect(() => parseSpec('{ not json')).toThrow(SpecLoadError);
  });

  it('reports a scalar document as a load error', () => {
    expect(() => parseSpec('just a string')).toThrow(/not an object/);
  });

  it('reports a missing file by path', async () => {
    await expect(loadSpec('/nonexistent/spec.yaml')).rejects.toThrow(/no such file/);
  });

  it('recognises URLs but not paths', () => {
    expect(isUrl('https://example.com/spec.json')).toBe(true);
    expect(isUrl('http://example.com/spec.json')).toBe(true);
    expect(isUrl('./spec.json')).toBe(false);
    expect(isUrl('/tmp/spec.json')).toBe(false);
  });
});

describe('fetching and caching', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'specdrift-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A fetch stand-in that counts calls and can be told how to respond. */
  function stubFetch(
    handler: (url: string, init: RequestInit) => Response,
  ): { impl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const impl = ((url: string, init: RequestInit = {}) => {
      calls.push(url);
      return Promise.resolve(handler(url, init));
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  function ok(body: string, headers: Record<string, string> = {}): Response {
    return new Response(body, { status: 200, headers });
  }

  it('fetches a URL and serves the next read from disk', async () => {
    const { impl, calls } = stubFetch(() => ok(MINIMAL, { etag: '"v1"' }));
    const url = 'https://example.test/spec.json';

    const first = await loadSpec(url, { fetchImpl: impl, cacheDir: dir });
    expect(first.source.fromCache).toBe(false);
    expect(calls).toHaveLength(1);

    const second = await loadSpec(url, { fetchImpl: impl, cacheDir: dir });
    expect(second.source.fromCache).toBe(true);
    expect(calls).toHaveLength(1); // no second request
    expect(second.document).toEqual(first.document);
  });

  it('bypasses the cache entirely when asked', async () => {
    const { impl, calls } = stubFetch(() => ok(MINIMAL));
    const url = 'https://example.test/nocache.json';

    await loadSpec(url, { fetchImpl: impl, cacheDir: dir });
    await loadSpec(url, { fetchImpl: impl, cacheDir: dir, noCache: true });
    expect(calls).toHaveLength(2);

    // noCache also declines to write, so the entry is still the first body only.
    const stats = await cacheStats({ dir });
    expect(stats.entries).toBe(1);
  });

  it('revalidates a stale entry and keeps the body on 304', async () => {
    const { impl, calls } = stubFetch((_url, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 });
      return ok(MINIMAL, { etag: '"v1"' });
    });
    const url = 'https://example.test/revalidate.json';

    await loadSpec(url, { fetchImpl: impl, cacheDir: dir });
    // ttlMs 0 forces every subsequent read to revalidate.
    const again = await loadSpec(url, { fetchImpl: impl, cacheDir: dir, ttlMs: 0 });

    expect(calls).toHaveLength(2);
    expect(again.source.fromCache).toBe(true);
    expect(again.document.info?.title).toBe('Cached API');
  });

  it('falls back to a stale body when the network is unavailable', async () => {
    let online = true;
    const { impl } = stubFetch(() => {
      if (!online) throw new Error('getaddrinfo ENOTFOUND');
      return ok(MINIMAL, { etag: '"v1"' });
    });
    const url = 'https://example.test/offline.json';

    await loadSpec(url, { fetchImpl: impl, cacheDir: dir });
    online = false;
    const offline = await loadSpec(url, { fetchImpl: impl, cacheDir: dir, ttlMs: 0 });
    expect(offline.source.fromCache).toBe(true);
  });

  it('fails loudly when the network is unavailable and nothing is cached', async () => {
    const { impl } = stubFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    await expect(
      loadSpec('https://example.test/never-seen.json', { fetchImpl: impl, cacheDir: dir }),
    ).rejects.toThrow(/fetch failed/);
  });

  it('surfaces an HTTP error status', async () => {
    const { impl } = stubFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(
      loadSpec('https://example.test/missing.json', { fetchImpl: impl, cacheDir: dir }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('clears the cache directory on request', async () => {
    const { impl } = stubFetch(() => ok(MINIMAL));
    await loadSpec('https://example.test/clearme.json', { fetchImpl: impl, cacheDir: dir });
    expect((await cacheStats({ dir })).entries).toBe(1);
    await clearCache({ dir });
    expect((await cacheStats({ dir })).entries).toBe(0);
  });

  it('caches the two sides of a diff independently', async () => {
    const bodies: Record<string, string> = {
      'https://example.test/one.json': MINIMAL,
      'https://example.test/two.json': MINIMAL.replace('/a', '/b'),
    };
    const { impl, calls } = stubFetch((url) => ok(bodies[url] as string));
    const result = await diffSpecs(
      'https://example.test/one.json',
      'https://example.test/two.json',
      { fetchImpl: impl, cacheDir: dir },
    );
    expect(calls).toHaveLength(2);
    expect(result.changes.map((c) => c.kind).sort()).toEqual([
      'endpoint.added',
      'endpoint.removed',
    ]);
    expect((await cacheStats({ dir })).entries).toBe(2);
  });

  it('mixes a local file and a remote URL in one diff', async () => {
    const local = join(dir, 'local.json');
    await writeFile(local, MINIMAL, 'utf8');
    const { impl } = stubFetch(() => ok(MINIMAL.replace('/a', '/b')));

    const result = await diffSpecs(local, 'https://example.test/remote.json', {
      fetchImpl: impl,
      cacheDir: dir,
    });
    expect(result.source.old.kind).toBe('file');
    expect(result.source.new.kind).toBe('url');
    expect(result.summary.bySeverity.breaking).toBe(1);
  });
});
