import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import webExt from 'web-ext';

// Scan every shipped file. Upstream Readability restores a detached document
// and parses a detached noscript image using innerHTML (1549 and 1928). We only
// pass it a cloned document and return bounded plain text; its HTML never enters
// the sidebar. Recognise only these two diagnostics in the exact reviewed file.
// Changes to the library require a fresh review; all other warnings still fail.
const file = 'vendor/readability/Readability.js';
const source = JSON.parse(await readFile('extension/vendor/readability/SOURCE.json'));
assert.equal(source.version, '0.6.0');
const checksum = createHash('sha256')
  .update(await readFile(`extension/${file}`))
  .digest('hex');
assert.equal(checksum, '34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174');
assert.equal(
  checksum,
  source.sha256['Readability.js'],
  'Readability differs from the reviewed source',
);
const result = await webExt.cmd.lint(
  { sourceDir: 'extension', output: 'none', warningsAsErrors: false },
  { shouldExitProgram: false },
);
const reviewed = (item) =>
  item.file === file && item.code === 'UNSAFE_VAR_ASSIGNMENT' && [1549, 1928].includes(item.line);
const { warnings, errors } = result;
assert(Array.isArray(warnings) && Array.isArray(errors), 'Unexpected extension lint result');
const unexpected = [...errors, ...warnings.filter((item) => !reviewed(item))];
for (const item of unexpected)
  console.error(`${item.file}:${item.line} ${item.code}: ${item.message}`);
console.log(
  `Extension lint: ${errors.length} errors, ${warnings.filter((item) => !reviewed(item)).length} unexpected warnings; ${warnings.filter(reviewed).length} reviewed Readability warnings.`,
);
if (unexpected.length) process.exitCode = 1;
