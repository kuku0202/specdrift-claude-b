import { RULES, type ChangeKind, type SeverityRule } from '../severity.js';
import type { Severity } from '../types.js';

/** Areas in the order they are presented, with their display names. */
const SECTIONS: ReadonlyArray<[prefix: string[], title: string]> = [
  [['endpoint.', 'operation.', 'operationId.'], 'Endpoints and operations'],
  [['parameter.'], 'Request parameters'],
  [['requestBody.'], 'Request bodies'],
  [['response.'], 'Responses'],
  [['schema.'], 'Schemas'],
  [['security.'], 'Security'],
];

function severityCell(rule: SeverityRule): { request: Severity; response: Severity } {
  const { severity } = rule;
  return typeof severity === 'string'
    ? { request: severity, response: severity }
    : severity;
}

function kindsFor(prefixes: string[]): ChangeKind[] {
  return (Object.keys(RULES) as ChangeKind[]).filter((kind) =>
    prefixes.some((prefix) => kind.startsWith(prefix)),
  );
}

/**
 * Render the severity taxonomy as a Markdown table.
 *
 * The README embeds the output of this function between marker comments; a test
 * regenerates it and asserts the file matches, so the documented taxonomy can
 * never disagree with the code that implements it.
 */
export function renderRulesMarkdown(): string {
  const out: string[] = [];
  for (const [prefixes, title] of SECTIONS) {
    const kinds = kindsFor(prefixes);
    if (kinds.length === 0) continue;
    out.push(`#### ${title}`, '');
    out.push('| Change | Severity | Reasoning |');
    out.push('| --- | --- | --- |');
    for (const kind of kinds) {
      const rule = RULES[kind] as SeverityRule;
      const { request, response } = severityCell(rule);
      // Only spell out both sides when the rule actually splits on direction.
      const verdict =
        request === response
          ? request
          : `in a request **${request}**<br>in a response **${response}**`;
      const rationale = rule.rationale.replace(/\|/g, '\\|');
      out.push(`| \`${kind}\` | ${verdict} | ${rationale} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** Render the taxonomy as plain text, for `specdrift --rules`. */
export function renderRulesText(): string {
  const out: string[] = ['specdrift severity taxonomy', ''];
  for (const [prefixes, title] of SECTIONS) {
    const kinds = kindsFor(prefixes);
    if (kinds.length === 0) continue;
    out.push(`${title}:`);
    for (const kind of kinds) {
      const rule = RULES[kind] as SeverityRule;
      const { request, response } = severityCell(rule);
      const verdict =
        request === response ? request : `request:${request} response:${response}`;
      out.push(`  ${kind.padEnd(42)} ${verdict}`);
    }
    out.push('');
  }
  return out.join('\n');
}
