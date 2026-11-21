// Transport Ship FPS server: zero-dependency static server.
// Serves the built client at /transport/ plus /audio/ direct alias and a health API.
// Listens on 127.0.0.1:3028 only (behind the openfolio.uk gateway).

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3028;
const HOST = '127.0.0.1';
const DIST = path.join(__dirname, 'dist');
const PREFIX = '/transport';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function health(_req, res) {
  send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
}

// Static file under DIST. `urlPath` must already be stripped of the /transport prefix.
function serveStatic(req, res, urlPath, allowSpaFallback = true) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep) && file !== path.join(DIST, 'index.html')) {
    return send(res, 403, 'forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!allowSpaFallback) return send(res, 404, 'not found');
      const index = path.join(DIST, 'index.html');
      if (!fs.existsSync(index)) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(index).pipe(res);
    }
    const ext = path.extname(file).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    const size = st.size;
    const range = req.headers.range;

    if (range && typeof range === 'string') {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(size - 1, parseInt(m[2], 10)) : size - 1;
        if (start <= end && start < size) {
          res.writeHead(206, {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1,
            'Cache-Control': cacheControl,
          });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
      }
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  if (pathname === '/api/health' || pathname === `${PREFIX}/api/health`) {
    return health(req, res);
  }
  if (pathname === '/') {
    return send(res, 302, '', { Location: `${PREFIX}/` });
  }
  if (pathname === PREFIX) {
    return send(res, 301, '', { Location: `${PREFIX}/` });
  }
  if (pathname.startsWith(PREFIX + '/')) {
    return serveStatic(req, res, pathname.slice(PREFIX.length), true);
  }
  if (pathname.startsWith('/audio/') || pathname.startsWith('/models/')) {
    return serveStatic(req, res, pathname, false);
  }
  return send(res, 404, 'not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[transport-fps] serving ${DIST} at http://${HOST}:${PORT}${PREFIX}/`);
});
