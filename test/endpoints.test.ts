import { beforeAll, describe, expect, it } from 'vitest';

import type { DiffResult } from '../src/index.js';

import { diffFixture, kindsOf, one } from './helpers.js';

describe('endpoint and operation changes', () => {
  let result: DiffResult;
  beforeAll(async () => {
    result = await diffFixture('endpoints');
  });

  it('reports a removed path as breaking', () => {
    const change = one(result, 'endpoint.removed');
    expect(change.path).toBe('/legacy-widgets');
    expect(change.severity).toBe('breaking');
    expect(change.pointer).toBe('/paths/~1legacy-widgets');
  });

  it('reports an added path as additive', () => {
    const change = one(result, 'endpoint.added');
    expect(change.path).toBe('/gadgets');
    expect(change.severity).toBe('additive');
  });

  it('reports a removed method on a surviving path as breaking', () => {
    const change = one(result, 'operation.removed');
    expect(change.path).toBe('/widgets');
    expect(change.method).toBe('post');
    expect(change.severity).toBe('breaking');
  });

  it('reports an added method as additive', () => {
    const change = one(result, 'operation.added');
    expect(change.method).toBe('delete');
    expect(change.severity).toBe('additive');
  });

  it('does not descend into a path that was removed wholesale', () => {
    // One change for the path, not one per operation underneath it.
    expect(result.changes.filter((c) => c.path === '/legacy-widgets')).toHaveLength(1);
  });

  it('summarises the counts it reported', () => {
    expect(result.summary.total).toBe(result.changes.length);
    expect(result.summary.bySeverity.breaking).toBe(2);
    expect(result.summary.bySeverity.additive).toBe(2);
    expect(result.summary.highestSeverity).toBe('breaking');
  });

  it('emits no changes for identical documents', async () => {
    const identical = await diffFixture('identical');
    expect(kindsOf(identical)).toEqual([]);
    expect(identical.summary.highestSeverity).toBeNull();
  });

  it('sorts breaking changes ahead of additive ones', () => {
    const severities = result.changes.map((c) => c.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === 'breaking' ? -1 : 1)));
  });
});
