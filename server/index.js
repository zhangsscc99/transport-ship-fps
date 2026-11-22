// Transport Ship FPS server: zero-dependency static server.
// Serves the built client at /transport/ plus /audio/ direct alias and a health API.
// Listens on 127.0.0.1:3028 only (behind the openfolio.uk gateway).

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3028;
const HOST = '127.0.0.1';
const DIST = path.join(__dirname, 'dist');
const INDEX_HTML = path.join(DIST, 'index.html');
const ASSETS_DIR = path.join(DIST, 'assets');
const PREFIX = '/transport';
const FILE_EXT_RE = /\.\w{2,5}$/;
const ASSET_REF_RE = new RegExp(`\\b(src|href)=(["'])(${PREFIX}/assets/[^"'?#]+)\\2`, 'g');

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

function sendText(req, res, status, body) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': MIME['.txt'],
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(buf);
}

function health(_req, res) {
  send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
}

function assetVersion(assetUrl, fallbackSeed) {
  const rel = assetUrl.slice(PREFIX.length);
  const file = path.normalize(path.join(DIST, rel));
  let seed = fallbackSeed;
  if (file.startsWith(ASSETS_DIR + path.sep)) {
    try {
      const st = fs.statSync(file);
      if (st.isFile()) {
        seed = `${rel}:${Math.trunc(st.mtimeMs)}:${st.size}`;
      }
    } catch {
      // Fall back to index.html mtime seed if asset cannot be stat'd.
    }
  }
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
}

function serveIndexHtml(req, res) {
  fs.stat(INDEX_HTML, (statErr, indexSt) => {
    if (statErr || !indexSt.isFile()) {
      return sendText(req, res, 404, 'not found');
    }
    fs.readFile(INDEX_HTML, 'utf8', (readErr, rawHtml) => {
      if (readErr) {
        return sendText(req, res, 500, 'internal error');
      }
      const fallbackSeed = `index:${Math.trunc(indexSt.mtimeMs)}:${indexSt.size}`;
      const html = rawHtml.replace(ASSET_REF_RE, (_m, attr, quote, assetUrl) => {
        const ver = assetVersion(assetUrl, fallbackSeed);
        return `${attr}=${quote}${assetUrl}?v=${ver}${quote}`;
      });
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': buf.length,
        'Cache-Control': 'no-store, must-revalidate',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(buf);
    });
  });
}

// Static file under DIST. `urlPath` must already be stripped of the /transport prefix.
function serveStatic(req, res, urlPath, allowSpaFallback = true) {
  let rawRel;
  try {
    rawRel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return sendText(req, res, 400, 'bad request');
  }
  const rel = rawRel === '/' || rawRel === '' ? '/index.html' : rawRel;
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep) && file !== INDEX_HTML) {
    return sendText(req, res, 403, 'forbidden');
  }
  if (file === INDEX_HTML) {
    return serveIndexHtml(req, res);
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      const hasFileExt = FILE_EXT_RE.test(rawRel);
      const isAssetPath = file.startsWith(ASSETS_DIR + path.sep) || file === ASSETS_DIR;
      if (!allowSpaFallback || hasFileExt || isAssetPath) {
        return sendText(req, res, 404, 'not found');
      }
      return serveIndexHtml(req, res);
    }
    const ext = path.extname(file).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const isAsset = file.startsWith(ASSETS_DIR + path.sep);
    const cacheControl =
      ext === '.html'
        ? 'no-store, must-revalidate'
        : isAsset
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600';
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
  return sendText(req, res, 404, 'not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[transport-fps] serving ${DIST} at http://${HOST}:${PORT}${PREFIX}/`);
});
