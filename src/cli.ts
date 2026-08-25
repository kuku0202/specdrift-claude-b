#!/usr/bin/env node
import { run } from './run.js';

/**
 * Thin executable wrapper. All behaviour lives in `run()` so that the CLI can
 * be exercised in-process by the test suite as well as by spawning the binary.
 */
const code = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stdout.isTTY === true,
  env: process.env,
});

process.exitCode = code;
