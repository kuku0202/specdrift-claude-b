import { readFile, writeFile } from 'node:fs/promises';

import { renderRulesMarkdown } from '../dist/report/rules.js';

/**
 * Rewrite the taxonomy table in README.md from the rule table in the code.
 * `npm run docs:rules` regenerates it; a test asserts the two agree.
 */
const START = '<!-- BEGIN GENERATED TAXONOMY -->';
const END = '<!-- END GENERATED TAXONOMY -->';

const path = new URL('../README.md', import.meta.url);
const readme = await readFile(path, 'utf8');

const startIndex = readme.indexOf(START);
const endIndex = readme.indexOf(END);
if (startIndex === -1 || endIndex === -1) {
  throw new Error(`README.md is missing the ${START} / ${END} markers`);
}

const updated =
  readme.slice(0, startIndex + START.length) +
  `\n\n${renderRulesMarkdown()}\n\n` +
  readme.slice(endIndex);

await writeFile(path, updated, 'utf8');
console.log('README.md taxonomy table updated');
