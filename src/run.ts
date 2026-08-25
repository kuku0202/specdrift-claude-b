import { parseArgs } from 'node:util';

import { cacheStats, clearCache } from './cache.js';
import { diffDocuments } from './diff/index.js';
import { loadSpec, SpecLoadError } from './loader.js';
import { renderJson } from './report/json.js';
import { renderRulesText } from './report/rules.js';
import { renderText } from './report/text.js';
import { isSeverity, meetsThreshold } from './severity.js';
import type { DiffResult, Severity } from './types.js';
import { VERSION } from './version.js';

/** Streams and terminal facts the CLI writes to. Injected so tests can capture. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether stdout is a terminal, which decides default colouring. */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

/** Process exit codes, as documented in the README. */
export const EXIT = {
  /** No change met the `--fail-on` threshold. */
  ok: 0,
  /** At least one change met the threshold. */
  changesFound: 1,
  /** Bad usage, or a specification that could not be read. */
  error: 2,
} as const;

const HELP = `specdrift ${VERSION}
Diff two OpenAPI 3.x specifications and report what changed.

USAGE
  specdrift <old-spec> <new-spec> [options]

  Each spec may be a local file path or an http(s) URL, in JSON or YAML.

OPTIONS
  -f, --format <text|json>   Output format. Default: text.
      --fail-on <severity>   Exit non-zero when a change of this severity or
                             worse is found: breaking, warning, additive,
                             informational, or none. Default: breaking.
      --limit <n>            Show at most n changes per severity group (text only).
      --no-cache             Do not read or write the on-disk cache of fetched specs.
      --cache-dir <path>     Override the cache directory.
      --color / --no-color   Force colour on or off. Default: on when stdout is a TTY.
      --rules                Print the severity taxonomy and exit.
      --clear-cache          Delete the cache directory and exit.
  -h, --help                 Show this help.
  -V, --version              Print the version.

EXIT CODES
  0  no change met the --fail-on threshold
  1  at least one change met the threshold
  2  bad usage, or a spec could not be read or parsed

EXAMPLES
  specdrift ./v1.yaml ./v2.yaml
  specdrift https://example.com/v1.json https://example.com/v2.json --format json
  specdrift old.yaml new.yaml --fail-on warning
`;

interface ParsedOptions {
  format: 'text' | 'json';
  failOn: Severity | 'none';
  limit?: number;
  noCache: boolean;
  cacheDir?: string;
  color?: boolean;
}

class UsageError extends Error {}

function parse(argv: string[]): { positionals: string[]; options: ParsedOptions } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      format: { type: 'string', short: 'f', default: 'text' },
      'fail-on': { type: 'string', default: 'breaking' },
      limit: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'cache-dir': { type: 'string' },
      color: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      rules: { type: 'boolean', default: false },
      'clear-cache': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'V', default: false },
    },
  });

  const format = values.format;
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`--format must be "text" or "json", got "${String(format)}"`);
  }

  const failOnRaw = String(values['fail-on']);
  if (failOnRaw !== 'none' && !isSeverity(failOnRaw)) {
    throw new UsageError(
      `--fail-on must be one of breaking, warning, additive, informational, none; got "${failOnRaw}"`,
    );
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new UsageError(`--limit must be a non-negative integer, got "${values.limit}"`);
    }
  }

  const color = values['no-color'] === true ? false : values.color === true ? true : undefined;

  // `help`, `version`, `rules` and `clear-cache` are handled by the caller.
  const options: ParsedOptions = {
    format,
    failOn: failOnRaw,
    noCache: values['no-cache'] === true,
    ...(limit === undefined ? {} : { limit }),
    ...(values['cache-dir'] === undefined ? {} : { cacheDir: values['cache-dir'] }),
    ...(color === undefined ? {} : { color }),
  };
  return { positionals, options };
}

/** True when the argv asks for one of the modes that ignores the positionals. */
function immediateMode(argv: string[]): 'help' | 'version' | 'rules' | 'clear-cache' | null {
  if (argv.includes('-h') || argv.includes('--help')) return 'help';
  if (argv.includes('-V') || argv.includes('--version')) return 'version';
  if (argv.includes('--rules')) return 'rules';
  if (argv.includes('--clear-cache')) return 'clear-cache';
  return null;
}

/**
 * Run the CLI.
 *
 * @param argv - Arguments after the program name.
 * @param io - Output sinks and terminal facts.
 * @returns The process exit code; see {@link EXIT}.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  const mode = immediateMode(argv);
  if (mode === 'help') {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (mode === 'version') {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (mode === 'rules') {
    io.stdout(renderRulesText());
    return EXIT.ok;
  }

  let positionals: string[];
  let options: ParsedOptions;
  try {
    ({ positionals, options } = parse(argv));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`specdrift: ${message}\n\nRun "specdrift --help" for usage.\n`);
    return EXIT.error;
  }

  if (mode === 'clear-cache') {
    const stats = await cacheStats(options.cacheDir ? { dir: options.cacheDir } : {});
    const dir = await clearCache(options.cacheDir ? { dir: options.cacheDir } : {});
    io.stdout(`Cleared ${stats.entries} cached spec(s) from ${dir}\n`);
    return EXIT.ok;
  }

  if (positionals.length !== 2) {
    io.stderr(
      positionals.length < 2
        ? 'specdrift: expected two specifications to compare.\n\nRun "specdrift --help" for usage.\n'
        : `specdrift: expected two specifications, got ${positionals.length}.\n\nRun "specdrift --help" for usage.\n`,
    );
    return EXIT.error;
  }

  const [oldInput, newInput] = positionals as [string, string];

  let result: DiffResult;
  try {
    const loadOptions = {
      noCache: options.noCache,
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    };
    const [before, after] = await Promise.all([
      loadSpec(oldInput, loadOptions),
      loadSpec(newInput, loadOptions),
    ]);
    result = diffDocuments(before.document, after.document, {
      old: before.source,
      new: after.source,
    });
  } catch (error) {
    if (error instanceof SpecLoadError) {
      io.stderr(`specdrift: ${error.message}\n`);
      return EXIT.error;
    }
    throw error;
  }

  if (options.format === 'json') {
    io.stdout(renderJson(result));
  } else {
    const color = options.color ?? (io.isTTY && !io.env['NO_COLOR']);
    io.stdout(
      renderText(result, {
        color,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      }),
    );
  }

  if (options.failOn === 'none') return EXIT.ok;
  const tripped = result.changes.some((change) =>
    meetsThreshold(change.severity, options.failOn as Severity),
  );
  return tripped ? EXIT.changesFound : EXIT.ok;
}
