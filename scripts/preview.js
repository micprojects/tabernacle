import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function previewServer(port = 4173) {
  const server = createServer(async (req, res) => {
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!['127.0.0.1', 'localhost'].includes(host)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const target = await realpath(
        resolve(root, `.${pathname === '/' ? '/preview/index.html' : pathname}`),
      );
      // Serve only preview assets, never repository metadata or symlinked files outside it.
      const allowed = ['extension', 'preview'].some((dir) =>
        target.startsWith(resolve(root, dir) + sep),
      );
      const relative = target.slice(root.length + 1);
      if (
        !allowed ||
        relative.split(sep).some((part) => part.startsWith('.')) ||
        !types[extname(target)]
      ) {
        res.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': types[extname(target)],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await previewServer(Number(process.env.PORT) || 4173);
  console.log(`Tabernacle preview: http://127.0.0.1:${server.address().port}`);
}
