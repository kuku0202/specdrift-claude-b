import { chmod } from 'node:fs/promises';

// tsc preserves the shebang but not the executable bit; restore it after build.
await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);
