import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cacheStats, diffSpecs, loadSpec } from '../src/index.js';

/**
 * These tests really talk to the network. They are pinned to immutable tags on
 * raw.githubusercontent.com so the bytes fetched today are the bytes fetched a
 * year from now, and so a diff asserted here cannot drift.
 *
 * Set SPECDRIFT_SKIP_LIVE=1 to skip them when working offline.
 */
const OAI = 'https://raw.githubusercontent.com/OAI/OpenAPI-Specification/3.1.1/examples/v3.0';
const PETSTORE = `${OAI}/petstore.yaml`;
const PETSTORE_EXPANDED = `${OAI}/petstore-expanded.yaml`;

const GITHUB = 'https://raw.githubusercontent.com/github/rest-api-description';
const GITHUB_V1 = `${GITHUB}/v1.1.4/descriptions/api.github.com/api.github.com.json`;
const GITHUB_V2 = `${GITHUB}/v2.0.0/descriptions/api.github.com/api.github.com.json`;

const skip = process.env['SPECDRIFT_SKIP_LIVE'] === '1';

describe.skipIf(skip)('live fetch', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'specdrift-live-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fetches a YAML specification over https and parses it', async () => {
    const { document, source } = await loadSpec(PETSTORE, { cacheDir: dir });
    expect(source.kind).toBe('url');
    expect(source.fromCache).toBe(false);
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info?.title).toBe('Swagger Petstore');
    expect(Object.keys(document.paths ?? {})).toContain('/pets');
  });

  it('serves the second read of the same URL from the disk cache', async () => {
    // The previous test populated the cache; this one must not hit the network.
    const before = await cacheStats({ dir });
    const { source } = await loadSpec(PETSTORE, { cacheDir: dir });
    const after = await cacheStats({ dir });

    expect(source.fromCache).toBe(true);
    expect(after.entries).toBe(before.entries);
    expect(after.bytes).toBe(before.bytes);
  });

  it('re-downloads when --no-cache is in effect', async () => {
    const { source } = await loadSpec(PETSTORE, { cacheDir: dir, noCache: true });
    expect(source.fromCache).toBe(false);
  });

  it('diffs two real specifications fetched over the network', async () => {
    const result = await diffSpecs(PETSTORE, PETSTORE_EXPANDED, { cacheDir: dir });

    expect(result.source.old.kind).toBe('url');
    expect(result.source.new.kind).toBe('url');
    expect(result.summary.total).toBeGreaterThan(0);

    // petstore-expanded renames the path template `/pets/{petId}` to
    // `/pets/{id}` and renames both operationIds, which is exactly the kind of
    // quiet client-breaking edit specdrift exists to surface.
    const kinds = new Set(result.changes.map((c) => c.kind));
    expect(kinds.has('endpoint.removed')).toBe(true);
    expect(kinds.has('endpoint.added')).toBe(true);
    expect(kinds.has('operationId.changed')).toBe(true);
    expect(kinds.has('parameter.added.optional')).toBe(true);

    const renamed = result.changes.find((c) => c.kind === 'endpoint.removed');
    expect(renamed?.path).toBe('/pets/{petId}');
    expect(renamed?.severity).toBe('breaking');
    expect(result.changes.every((c) => typeof c.pointer === 'string')).toBe(true);
  });

  it(
    'diffs two released versions of the GitHub REST API description',
    { timeout: 180_000 },
    async () => {
      const result = await diffSpecs(GITHUB_V1, GITHUB_V2, { cacheDir: dir });

      // A 4 MB pair of real documents: the point is that it completes, finds a
      // lot, and classifies most of it as additive rather than breaking.
      expect(result.summary.total).toBeGreaterThan(1000);
      expect(result.summary.bySeverity.breaking).toBeGreaterThan(0);
      expect(result.summary.bySeverity.additive).toBeGreaterThan(
        result.summary.bySeverity.breaking,
      );

      // GitHub removed the OAuth Authorizations API between these two releases.
      const removed = result.changes.filter((c) => c.kind === 'endpoint.removed');
      expect(removed.map((c) => c.path)).toContain('/authorizations');
      expect(removed.every((c) => c.severity === 'breaking')).toBe(true);

      // Every change must carry enough context to act on.
      for (const change of result.changes) {
        expect(change.message.length).toBeGreaterThan(0);
        expect(change.pointer.startsWith('/paths/')).toBe(true);
      }
    },
  );
});
