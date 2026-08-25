import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { EXIT, run, type Io } from '../src/run.js';
import type { DiffResult } from '../src/index.js';

import { fixture } from './helpers.js';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(argv: string[], overrides: Partial<Io> = {}): Promise<Capture> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    env: {},
    ...overrides,
  });
  return { code, stdout, stderr };
}

const OLD = fixture('responses', 'old.yaml');
const NEW = fixture('responses', 'new.yaml');
const SAME = fixture('identical', 'old.yaml');

describe('cli', () => {
  it('prints help and exits zero', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('specdrift <old-spec> <new-spec>');
    expect(stdout).toContain('--fail-on');
  });

  it('prints the version', async () => {
    const { code, stdout } = await cli(['--version']);
    expect(code).toBe(EXIT.ok);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints the severity taxonomy', async () => {
    const { code, stdout } = await cli(['--rules']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('schema.property.removed');
    expect(stdout).toContain('request:warning response:breaking');
  });

  it('exits 1 when breaking changes are present', async () => {
    const { code, stdout } = await cli([OLD, NEW]);
    expect(code).toBe(EXIT.changesFound);
    expect(stdout).toContain('BREAKING');
  });

  it('exits 0 when the specs are identical', async () => {
    const { code, stdout } = await cli([SAME, SAME]);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('No differences found.');
  });

  it('exits 0 for additive-only changes at the default threshold', async () => {
    const { code } = await cli([
      fixture('additive-only', 'old.yaml'),
      fixture('additive-only', 'new.yaml'),
    ]);
    expect(code).toBe(EXIT.ok);
  });

  it('exits 1 for additive-only changes when --fail-on additive', async () => {
    const { code } = await cli([
      fixture('additive-only', 'old.yaml'),
      fixture('additive-only', 'new.yaml'),
      '--fail-on',
      'additive',
    ]);
    expect(code).toBe(EXIT.changesFound);
  });

  it('never fails with --fail-on none', async () => {
    const { code } = await cli([OLD, NEW, '--fail-on', 'none']);
    expect(code).toBe(EXIT.ok);
  });

  it('emits parseable JSON with a stable shape', async () => {
    const { code, stdout } = await cli([OLD, NEW, '--format', 'json']);
    expect(code).toBe(EXIT.changesFound);
    const parsed = JSON.parse(stdout) as DiffResult;
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.summary.total).toBe(parsed.changes.length);
    expect(parsed.source.old.input).toBe(OLD);
    for (const change of parsed.changes) {
      expect(change).toHaveProperty('kind');
      expect(change).toHaveProperty('severity');
      expect(change).toHaveProperty('pointer');
      expect(change).toHaveProperty('message');
    }
  });

  it('produces byte-identical JSON across runs', async () => {
    const a = await cli([OLD, NEW, '-f', 'json']);
    const b = await cli([OLD, NEW, '-f', 'json']);
    expect(a.stdout).toBe(b.stdout);
  });

  it('colours output only when asked or when stdout is a TTY', async () => {
    const plain = await cli([OLD, NEW]);
    expect(plain.stdout).not.toContain('[');

    const forced = await cli([OLD, NEW, '--color']);
    expect(forced.stdout).toContain('[');

    const tty = await cli([OLD, NEW], { isTTY: true });
    expect(tty.stdout).toContain('[');

    const suppressed = await cli([OLD, NEW], { isTTY: true, env: { NO_COLOR: '1' } });
    expect(suppressed.stdout).not.toContain('[');
  });

  it('truncates long groups with --limit and says how many were hidden', async () => {
    const { stdout } = await cli([OLD, NEW, '--limit', '1']);
    expect(stdout).toContain('and 3 more');
  });

  it('rejects an unknown format', async () => {
    const { code, stderr } = await cli([OLD, NEW, '--format', 'xml']);
    expect(code).toBe(EXIT.error);
    expect(stderr).toContain('--format must be');
  });

  it('rejects an unknown severity threshold', async () => {
    const { code, stderr } = await cli([OLD, NEW, '--fail-on', 'catastrophic']);
    expect(code).toBe(EXIT.error);
    expect(stderr).toContain('--fail-on must be one of');
  });

  it('rejects a non-numeric limit', async () => {
    const { code, stderr } = await cli([OLD, NEW, '--limit', 'lots']);
    expect(code).toBe(EXIT.error);
    expect(stderr).toContain('--limit must be');
  });

  it('rejects an unknown flag', async () => {
    const { code, stderr } = await cli([OLD, NEW, '--wat']);
    expect(code).toBe(EXIT.error);
    expect(stderr).toContain('specdrift:');
  });

  it('requires exactly two specifications', async () => {
    expect((await cli([])).code).toBe(EXIT.error);
    expect((await cli([OLD])).stderr).toContain('expected two specifications');
    expect((await cli([OLD, NEW, SAME])).stderr).toContain('got 3');
  });

  it('reports an unreadable specification without a stack trace', async () => {
    const { code, stderr } = await cli([OLD, '/nonexistent/spec.yaml']);
    expect(code).toBe(EXIT.error);
    expect(stderr).toContain('no such file');
    expect(stderr).not.toContain('at ');
  });

  it('clears the cache directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'specdrift-cli-'));
    try {
      const { code, stdout } = await cli(['--clear-cache', '--cache-dir', dir]);
      expect(code).toBe(EXIT.ok);
      expect(stdout).toContain('Cleared 0 cached spec(s)');
      expect(existsSync(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the built binary', () => {
  it('runs from dist and sets the documented exit code', async () => {
    const bin = join(ROOT, 'dist', 'cli.js');
    if (!existsSync(bin)) {
      throw new Error('dist/cli.js is missing - run `npm run build` before the tests');
    }
    await expect(
      execFileAsync(process.execPath, [bin, OLD, NEW, '--format', 'json']),
    ).rejects.toMatchObject({ code: EXIT.changesFound });

    const { stdout } = await execFileAsync(process.execPath, [bin, SAME, SAME]);
    expect(stdout).toContain('No differences found.');
  });
});
