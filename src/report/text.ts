import { createColors } from 'picocolors';

import { SEVERITY_ORDER, type Change, type DiffResult, type Severity } from '../types.js';

export interface TextReportOptions {
  /** Emit ANSI colour. Defaults to whatever picocolors detects. */
  color?: boolean;
  /**
   * Show at most this many changes per severity group. Large real-world diffs
   * run to thousands of lines; the summary still counts every change.
   */
  limit?: number;
}

const GLYPHS: Record<Severity, string> = {
  breaking: 'x',
  warning: '!',
  additive: '+',
  informational: '.',
};

const HEADINGS: Record<Severity, string> = {
  breaking: 'BREAKING',
  warning: 'WARNING',
  additive: 'ADDITIVE',
  informational: 'INFORMATIONAL',
};

type Palette = ReturnType<typeof createColors>;

function paint(colors: Palette, severity: Severity, text: string): string {
  switch (severity) {
    case 'breaking':
      return colors.red(text);
    case 'warning':
      return colors.yellow(text);
    case 'additive':
      return colors.green(text);
    case 'informational':
      return colors.dim(text);
  }
}

/** The operation a change belongs to, used to group lines under one heading. */
function groupKey(change: Change): string {
  if (change.method && change.path) {
    return `${change.method.toUpperCase()} ${change.path}`;
  }
  return change.path ?? '(document)';
}

function describeSource(result: DiffResult): string {
  const { old: before, new: after } = result.source;
  const version = (v?: string): string => v ?? '?';
  const title = after.title ?? before.title;
  const versions = `${version(before.version)} -> ${version(after.version)}`;
  return title ? `${title}  ${versions}` : versions;
}

/**
 * Render a diff as human-readable text.
 *
 * Changes are grouped by severity and then by operation, so the reader sees the
 * things that will break them first and does not have to scan an interleaved
 * list.
 */
export function renderText(result: DiffResult, options: TextReportOptions = {}): string {
  const colors = createColors(options.color);
  const lines: string[] = [];
  const { summary } = result;

  lines.push(colors.bold(describeSource(result)));
  lines.push(
    colors.dim(`${result.source.old.input}`) +
      colors.dim(' -> ') +
      colors.dim(`${result.source.new.input}`),
  );
  lines.push('');

  if (summary.total === 0) {
    lines.push(colors.green('No differences found.'));
    lines.push('');
    return lines.join('\n');
  }

  for (const severity of SEVERITY_ORDER) {
    const changes = result.changes.filter((c) => c.severity === severity);
    if (changes.length === 0) continue;

    lines.push(
      paint(colors, severity, colors.bold(`${HEADINGS[severity]} (${changes.length})`)),
    );

    const shown = options.limit === undefined ? changes : changes.slice(0, options.limit);
    let currentGroup: string | null = null;
    for (const change of shown) {
      const key = groupKey(change);
      if (key !== currentGroup) {
        currentGroup = key;
        lines.push(`  ${colors.bold(key)}`);
      }
      lines.push(`    ${paint(colors, severity, GLYPHS[severity])} ${detail(change, colors)}`);
    }
    if (shown.length < changes.length) {
      lines.push(
        colors.dim(`    ... and ${changes.length - shown.length} more (raise --limit to show them)`),
      );
    }
    lines.push('');
  }

  lines.push(summaryLine(result, colors));
  lines.push('');
  return lines.join('\n');
}

function detail(change: Change, colors: Palette): string {
  const parts = [change.message];
  // Only worth showing the transition when both ends are known; a one-sided
  // value is already spelled out in the message.
  if (change.from !== undefined && change.to !== undefined) {
    parts.push(colors.dim(`(${change.from} -> ${change.to})`));
  }
  parts.push(colors.dim(`[${change.kind}]`));
  return parts.join(' ');
}

/** The one-line tally printed at the end of a text report. */
export function summaryLine(result: DiffResult, colors: Palette): string {
  const { bySeverity, total } = result.summary;
  const parts = SEVERITY_ORDER.filter((s) => bySeverity[s] > 0).map((s) =>
    paint(colors, s, `${bySeverity[s]} ${s}`),
  );
  return `${colors.bold(String(total))} change${total === 1 ? '' : 's'}: ${parts.join(colors.dim(' | '))}`;
}
