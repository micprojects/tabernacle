import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceSource } from '../../scripts/instrumentation/source.js';

const availability = 'src/new-tab/availability.js';

// Retain coverage of the paused feature using test responses or an isolated copy.
// The shipped extension and ordinary preview always keep their disabled switch.
async function enabledSource() {
  return replaceSource(
    await readFile(join('extension', availability), 'utf8'),
    'export const NEW_TAB_AVAILABLE = false;',
    'export const NEW_TAB_AVAILABLE = true;',
  );
}

export async function enableNewTabInContext(context) {
  const body = await enabledSource();
  await context.route('**/extension/' + availability, (route) =>
    route.fulfill({ contentType: 'application/javascript', body }),
  );
}

export async function newTabTestExtension(root) {
  const extension = join(root, 'new-tab-extension');
  await cp('extension', extension, { recursive: true });
  await writeFile(join(extension, availability), await enabledSource());
  return extension;
}
