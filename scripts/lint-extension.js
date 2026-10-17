import assert from 'node:assert/strict';
import webExt from 'web-ext';

const result = await webExt.cmd.lint(
  { sourceDir: 'extension', output: 'none', warningsAsErrors: false },
  { shouldExitProgram: false },
);
const { warnings, errors } = result;
assert(Array.isArray(warnings) && Array.isArray(errors), 'Unexpected extension lint result');
const unexpected = [...errors, ...warnings];
for (const item of unexpected)
  console.error(`${item.file}:${item.line} ${item.code}: ${item.message}`);
console.log(`Extension lint: ${errors.length} errors, ${warnings.length} warnings.`);
if (unexpected.length) process.exitCode = 1;
