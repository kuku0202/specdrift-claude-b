import { beforeAll, describe, expect, it } from 'vitest';

import type { DiffResult } from '../src/index.js';

import { diffFixture, one } from './helpers.js';

describe('response and response schema changes', () => {
  let result: DiffResult;
  beforeAll(async () => {
    result = await diffFixture('responses');
  });

  it('treats a removed error status as a warning', () => {
    const change = one(result, 'response.error.removed');
    expect(change.message).toContain('404');
    expect(change.severity).toBe('warning');
  });

  it('treats a new error status as additive', () => {
    const change = one(result, 'response.error.added');
    expect(change.message).toContain('429');
    expect(change.severity).toBe('additive');
  });

  it('treats a new success status as a warning, since clients test exact codes', () => {
    const change = one(result, 'response.success.added');
    expect(change.message).toContain('201');
    expect(change.severity).toBe('warning');
  });

  it('treats a removed response media type as breaking', () => {
    const change = one(result, 'response.mediaType.removed');
    expect(change.message).toContain('text/csv');
    expect(change.severity).toBe('breaking');
  });

  it('treats a removed response header as breaking and an added one as additive', () => {
    expect(one(result, 'response.header.removed').severity).toBe('breaking');
    expect(one(result, 'response.header.added').severity).toBe('additive');
  });

  it('treats a removed response property as breaking', () => {
    const change = one(result, 'schema.property.removed');
    expect(change.message).toContain('"name"');
    expect(change.direction).toBe('response');
    expect(change.severity).toBe('breaking');
  });

  it('treats a new response property as additive', () => {
    const change = one(result, 'schema.property.added');
    expect(change.message).toContain('"slug"');
    expect(change.severity).toBe('additive');
  });

  it('inverts the requiredness rules for responses', () => {
    // ownerId became required: a *stronger* guarantee to the reader.
    const stronger = one(result, 'schema.required.added');
    expect(stronger.message).toContain('"ownerId"');
    expect(stronger.severity).toBe('additive');

    // `name` disappeared entirely, so its requiredness went with it; the
    // remaining requirement change is the one that matters.
    expect(stronger.direction).toBe('response');
  });

  it('treats a response value becoming nullable as breaking', () => {
    const change = one(result, 'schema.nullable.added');
    expect(change.pointer).toContain('/properties/id');
    expect(change.severity).toBe('breaking');
  });

  it('treats a widened response enum as a warning', () => {
    const change = one(result, 'schema.enum.value.added');
    expect(change.message).toContain('pending');
    expect(change.severity).toBe('warning');
  });

  it('records the status code in the pointer', () => {
    expect(one(result, 'response.error.added').pointer).toBe(
      '/paths/~1widgets~1{id}/get/responses/429',
    );
  });
});
