const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // hanya bisa diakses dari komputer ini
const ROOT = path.resolve(__dirname);

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// File yang tidak boleh disajikan (kode backend, schema, dsb.)
const BLOCKED_EXT = new Set(['.gs', '.sql', '.md', '.env']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function serveIndex(res) {
  fs.readFile(path.join(ROOT, 'Index.html'), (err, content) => {
    if (err) return send(res, 500, 'Error loading Index.html', { 'Content-Type': 'text/plain' });
    send(res, 200, content, { 'Content-Type': MIME_TYPES['.html'] });
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain' });
  }

  if (pathname === '/' || pathname === '') return serveIndex(res);

  // Cegah path traversal: path final harus tetap di dalam ROOT
  const filePath = path.resolve(ROOT, '.' + path.posix.normalize(pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  const ext = path.extname(filePath).toLowerCase();
  if (BLOCKED_EXT.has(ext) || path.basename(filePath).startsWith('.')) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  fs.readFile(filePath, (err, content) => {
    if (!err) {
      return send(res, 200, content, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    }
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      // Fallback SPA hanya untuk route tanpa ekstensi; aset yang hilang -> 404
      return ext ? send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' }) : serveIndex(res);
    }
    send(res, 500, 'Server Error', { 'Content-Type': 'text/plain' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Dapoer Asri running locally at http://localhost:${PORT}`);
});
