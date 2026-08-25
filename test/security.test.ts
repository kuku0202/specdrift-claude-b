import { beforeAll, describe, expect, it } from 'vitest';

import type { DiffResult } from '../src/index.js';

import { diffFixture, one } from './helpers.js';

describe('security requirement changes', () => {
  let result: DiffResult;
  beforeAll(async () => {
    result = await diffFixture('security');
  });

  it('treats a newly required scope as breaking', () => {
    const change = one(result, 'security.scopes.added', { path: '/scopes-widen' });
    expect(change.to).toBe('write');
    expect(change.severity).toBe('breaking');
  });

  it('treats a dropped scope requirement as additive', () => {
    const change = one(result, 'security.scopes.removed', { path: '/scopes-narrow' });
    expect(change.from).toBe('write');
    expect(change.severity).toBe('additive');
  });

  it('treats an extra scheme inside one alternative as breaking', () => {
    // Schemes within a single requirement object are ANDed together.
    const change = one(result, 'security.scheme.added', { path: '/scheme-added' });
    expect(change.to).toBe('mfa');
    expect(change.severity).toBe('breaking');
  });

  it('inherits document-level security when an operation declares none', () => {
    // /scheme-added declared no security in the old document; it inherited
    // `apiKey` from the document root, so only `mfa` is new.
    const changes = result.changes.filter((c) => c.path === '/scheme-added');
    expect(changes.map((c) => c.kind)).toEqual(['security.scheme.added']);
  });

  it('treats losing an authentication alternative as breaking', () => {
    const change = one(result, 'security.alternative.removed', {
      path: '/alternative-removed',
    });
    expect(change.from).toBe('oauth2');
    expect(change.severity).toBe('breaking');
  });

  it('treats withdrawing anonymous access as breaking', () => {
    const change = one(result, 'security.made.required', {
      path: '/anonymous-withdrawn',
    });
    expect(change.severity).toBe('breaking');
  });

  it('does not also report the empty alternative as a removed alternative', () => {
    const changes = result.changes.filter((c) => c.path === '/anonymous-withdrawn');
    expect(changes.map((c) => c.kind)).toEqual(['security.made.required']);
  });
});
