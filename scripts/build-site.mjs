import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { Marked } from 'marked';

/**
 * Build the documentation site from README.md.
 *
 * One page, no client-side JavaScript, no external requests. The README is the
 * single source of truth for the documentation; this script only wraps it in a
 * readable shell and lifts its headings into a sidebar.
 */

const OUT_DIR = new URL('../site/', import.meta.url);
const README = new URL('../README.md', import.meta.url);
const PKG = new URL('../package.json', import.meta.url);

const pkg = JSON.parse(await readFile(PKG, 'utf8'));
const markdown = await readFile(README, 'utf8');

/** Stable, readable id for a heading, matching GitHub's slug rules closely enough. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const headings = [];
const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const plain = text.replace(/<[^>]+>/g, '');
      const id = slugify(plain);
      if (depth === 2) headings.push({ id, text: plain });
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${text}</a></h${depth}>\n`;
    },
  },
});

// The README opens with the project name and a badge; the page has its own
// header for those, so drop the first heading and the badge line.
const body = markdown
  .replace(/^# specdrift\n/, '')
  .replace(/^\[!\[npm\][^\n]*\n/m, '');

const content = await marked.parse(body);

const nav = headings
  .map(({ id, text }) => `        <li><a href="#${id}">${escapeHtml(text)}</a></li>`)
  .join('\n');

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>specdrift - OpenAPI diff with breaking-change detection</title>
<meta name="description" content="${escapeHtml(pkg.description)}">
<style>
:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #59636e;
  --border: #d1d9e0;
  --accent: #0969da;
  --code-bg: #f6f8fa;
  --breaking: #cf222e;
  --warning: #9a6700;
  --additive: #1a7f37;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #9198a1;
    --border: #3d444d;
    --accent: #4493f8;
    --code-bg: #151b23;
    --breaking: #ff7b72;
    --warning: #d29922;
    --additive: #3fb950;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
a { color: var(--accent); }
header.hero {
  border-bottom: 1px solid var(--border);
  padding: 3rem 1.5rem 2.25rem;
  text-align: center;
}
header.hero h1 { margin: 0; font-size: 2.5rem; letter-spacing: -0.02em; }
header.hero p.tagline {
  margin: 0.75rem auto 1.5rem;
  max-width: 44rem;
  color: var(--muted);
  font-size: 1.1rem;
}
.links a {
  display: inline-block;
  margin: 0 0.4rem;
  padding: 0.45rem 1rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  text-decoration: none;
  font-size: 0.9rem;
}
.links a:hover { border-color: var(--accent); }
.layout {
  display: grid;
  grid-template-columns: 16rem minmax(0, 1fr);
  gap: 3rem;
  max-width: 68rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 5rem;
}
nav.toc { position: sticky; top: 2rem; align-self: start; font-size: 0.9rem; }
nav.toc strong {
  display: block;
  margin-bottom: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.72rem;
  color: var(--muted);
}
nav.toc ul { list-style: none; margin: 0; padding: 0; }
nav.toc li { margin: 0.3rem 0; }
nav.toc a { text-decoration: none; color: var(--muted); }
nav.toc a:hover { color: var(--accent); }
main { min-width: 0; }
main h2 {
  margin-top: 3rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--border);
  letter-spacing: -0.01em;
}
main h3 { margin-top: 2rem; }
main h4 { margin-top: 1.75rem; color: var(--muted); }
main .anchor { color: inherit; text-decoration: none; }
main .anchor:hover { color: var(--accent); }
code {
  font-family: var(--mono);
  font-size: 0.875em;
  background: var(--code-bg);
  padding: 0.15em 0.4em;
  border-radius: 5px;
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  overflow-x: auto;
  line-height: 1.5;
}
pre code { background: none; padding: 0; font-size: 0.83rem; }
table {
  border-collapse: collapse;
  width: 100%;
  display: block;
  overflow-x: auto;
  margin: 1rem 0;
  font-size: 0.92rem;
}
th, td { border: 1px solid var(--border); padding: 0.5rem 0.7rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); }
blockquote {
  margin: 1rem 0;
  padding: 0.1rem 1rem;
  border-left: 4px solid var(--border);
  color: var(--muted);
}
hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }
footer {
  border-top: 1px solid var(--border);
  padding: 2rem 1.5rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.875rem;
}
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; gap: 1.5rem; }
  nav.toc { position: static; }
}
</style>
</head>
<body>
<header class="hero">
  <h1>specdrift</h1>
  <p class="tagline">${escapeHtml(pkg.description)}</p>
  <p class="links">
    <a href="https://github.com/kuku0202/specdrift-claude-b">GitHub</a>
    <a href="https://www.npmjs.com/package/${pkg.name}">npm</a>
    <a href="https://github.com/kuku0202/specdrift-claude-b/releases">Releases</a>
  </p>
</header>
<div class="layout">
  <nav class="toc">
    <strong>Contents</strong>
    <ul>
${nav}
    </ul>
  </nav>
  <main>
${content}
  </main>
</div>
<footer>
  ${escapeHtml(pkg.name)} v${pkg.version} &middot; MIT licensed
</footer>
</body>
</html>
`;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('index.html', OUT_DIR), html, 'utf8');
// Stop GitHub Pages running the output through Jekyll.
await writeFile(new URL('.nojekyll', OUT_DIR), '', 'utf8');

console.log(`site/index.html written (${headings.length} sections)`);
