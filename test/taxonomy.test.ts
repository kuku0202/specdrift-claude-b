import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHANGE_KINDS,
  RULES,
  maxSeverity,
  meetsThreshold,
  rationaleFor,
  renderJson,
  renderRulesMarkdown,
  renderRulesText,
  renderText,
  SEVERITY_ORDER,
  severityFor,
  severityRank,
  isSeverity,
  type ChangeKind,
} from '../src/index.js';

import { diffFixture } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the severity taxonomy', () => {
  it('gives every change kind a severity and a rationale', () => {
    expect(CHANGE_KINDS.length).toBeGreaterThan(30);
    for (const kind of CHANGE_KINDS) {
      expect(rationaleFor(kind).length).toBeGreaterThan(20);
      for (const direction of ['request', 'response'] as const) {
        expect(SEVERITY_ORDER).toContain(severityFor(kind, direction));
      }
    }
  });

  it('resolves a direction-split rule to the worse side when no direction is given', () => {
    // `schema.property.removed` is warning on a request, breaking on a response.
    expect(severityFor('schema.property.removed', 'request')).toBe('warning');
    expect(severityFor('schema.property.removed', 'response')).toBe('breaking');
    expect(severityFor('schema.property.removed')).toBe('breaking');
  });

  it('assigns every kind to a documented section of the table', () => {
    const markdown = renderRulesMarkdown();
    for (const kind of CHANGE_KINDS) {
      expect(markdown).toContain(`\`${kind}\``);
    }
  });

  it('keeps the README taxonomy table in step with the code', async () => {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    const start = readme.indexOf('<!-- BEGIN GENERATED TAXONOMY -->');
    const end = readme.indexOf('<!-- END GENERATED TAXONOMY -->');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const embedded = readme
      .slice(start + '<!-- BEGIN GENERATED TAXONOMY -->'.length, end)
      .trim();
    expect(embedded).toBe(renderRulesMarkdown());
  });

  it('orders severities from most to least severe', () => {
    expect(SEVERITY_ORDER).toEqual(['breaking', 'warning', 'additive', 'informational']);
    expect(severityRank('breaking')).toBeLessThan(severityRank('warning'));
    expect(severityRank('additive')).toBeLessThan(severityRank('informational'));
  });

  it('treats a threshold as "this severity or worse"', () => {
    expect(meetsThreshold('breaking', 'warning')).toBe(true);
    expect(meetsThreshold('warning', 'warning')).toBe(true);
    expect(meetsThreshold('additive', 'warning')).toBe(false);
    expect(meetsThreshold('additive', 'informational')).toBe(true);
  });

  it('picks the worst of a set of severities', () => {
    expect(maxSeverity(['additive', 'breaking', 'warning'])).toBe('breaking');
    expect(maxSeverity(['informational', 'additive'])).toBe('additive');
    expect(maxSeverity([])).toBeNull();
  });

  it('recognises exactly the four severity names', () => {
    for (const name of SEVERITY_ORDER) expect(isSeverity(name)).toBe(true);
    expect(isSeverity('catastrophic')).toBe(false);
    expect(isSeverity('none')).toBe(false);
  });

  it('never rules a request-narrowing change as merely additive', () => {
    // Guards the core invariant: anything that narrows what a server accepts
    // must be at least a warning on the request side.
    const narrowing: ChangeKind[] = [
      'parameter.added.required',
      'parameter.required.added',
      'requestBody.required.added',
      'schema.property.added.required',
      'schema.required.added',
      'schema.enum.value.removed',
      'schema.nullable.removed',
      'schema.additionalProperties.restricted',
      'schema.constraint.tightened',
    ];
    for (const kind of narrowing) {
      expect(meetsThreshold(severityFor(kind, 'request'), 'warning')).toBe(true);
    }
  });

  it('never rules a response-narrowing change as merely additive', () => {
    const narrowing: ChangeKind[] = [
      'schema.property.removed',
      'schema.required.removed',
      'schema.nullable.added',
      'response.success.removed',
      'response.mediaType.removed',
      'response.header.removed',
    ];
    for (const kind of narrowing) {
      expect(meetsThreshold(severityFor(kind, 'response'), 'warning')).toBe(true);
    }
  });

  it('rules every security tightening as breaking', () => {
    const tightening: ChangeKind[] = [
      'security.alternative.removed',
      'security.scheme.added',
      'security.scopes.added',
      'security.made.required',
    ];
    for (const kind of tightening) {
      expect(severityFor(kind)).toBe('breaking');
    }
  });

  it('renders the text taxonomy with a line per kind', () => {
    const text = renderRulesText();
    for (const kind of CHANGE_KINDS) expect(text).toContain(kind);
  });

  it('exposes rules keyed by change kind', () => {
    expect(Object.keys(RULES).sort()).toEqual([...CHANGE_KINDS].sort());
  });
});

describe('reporting', () => {
  it('renders plain text without escape codes when colour is off', async () => {
    const result = await diffFixture('responses');
    const text = renderText(result, { color: false });
    expect(text).not.toContain('[');
    expect(text).toContain('BREAKING (4)');
    expect(text).toContain('11 changes');
  });

  it('renders colour when asked', async () => {
    const result = await diffFixture('responses');
    expect(renderText(result, { color: true })).toContain('[');
  });

  it('groups changes under one heading per operation', async () => {
    const result = await diffFixture('responses');
    const text = renderText(result, { color: false });
    // One operation, so its heading appears once per severity group present.
    const headings = text.match(/^ {2}GET \/widgets\/\{id\}$/gm) ?? [];
    expect(headings).toHaveLength(3);
  });

  it('says so plainly when nothing changed', async () => {
    const result = await diffFixture('identical');
    const text = renderText(result, { color: false });
    expect(text).toContain('No differences found.');
    expect(text).not.toContain('BREAKING');
  });

  it('round-trips through JSON unchanged', async () => {
    const result = await diffFixture('responses');
    expect(JSON.parse(renderJson(result))).toEqual(result);
  });

  it('ends the JSON report with a newline', async () => {
    const result = await diffFixture('identical');
    expect(renderJson(result).endsWith('\n')).toBe(true);
  });

  it('sorts deterministically regardless of discovery order', async () => {
    const a = await diffFixture('responses');
    const b = await diffFixture('responses');
    expect(renderJson(a)).toBe(renderJson(b));

    const severities = a.changes.map((c) => c.severity);
    const ranks = severities.map(severityRank);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });
});
