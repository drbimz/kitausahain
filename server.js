const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // Aman: hanya dapat diakses lokal
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

// File & ekstensi rahasia/backend yang DILARANG KERAS disajikan ke publik
const BLOCKED_EXT = new Set(['.gs', '.sql', '.md', '.env', '.lock', '.yml', '.yaml', '.sh', '.bat', '.cmd']);
const BLOCKED_FILES = new Set(['server.js', 'package.json', 'package-lock.json', '.gitignore', 'vercel.json']);

// POLA EXPLOIT VIRAL PHP & NODE.JS YANG DIBLOKIR OTOMATIS:
// 1. CVE-2024-4577 (PHP-CGI Windows Argument Injection RCE)
// 2. Web shell & file inclusion (allow_url_include, auto_prepend_file, php://input)
// 3. WordPress / CMS scanner bots (wp-login.php, xmlrpc.php, phpunit)
// 4. Null-byte injection (\0 / %00) & Path Traversal (../, %2e%2e/)
const VIRAL_ATTACK_SIGNATURES = [
  /\.php(\?|$)/i,
  /php-cgi/i,
  /cgi-bin/i,
  /%ad/i,                     // CVE-2024-4577 Windows PHP-CGI argument injection
  /auto_prepend_file/i,
  /allow_url_include/i,
  /php:\/\/input/i,
  /eval-stdin/i,
  /wp-login|xmlrpc|phpunit/i,
  /\0|%00/i,                  // Null-byte injection
  /\.\./                      // Path traversal
];

// HEADER KEAMANAN LENGKAP (A+ SECURITY RATING)
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:;"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function serveIndex(res) {
  const file = fs.existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'Index.html';
  fs.readFile(path.join(ROOT, file), (err, content) => {
    if (err) return send(res, 500, 'Error loading index.html', { 'Content-Type': 'text/plain' });
    send(res, 200, content, { 'Content-Type': MIME_TYPES['.html'] });
  });
}

const server = http.createServer((req, res) => {
  // Hanya izinkan metode GET & HEAD untuk keamanan aplikasi frontend
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
  }

  const rawUrl = req.url || '';

  // 1. CEK & BLOKIR SERANGAN VIRAL PHP & INJEKSI
  for (const pattern of VIRAL_ATTACK_SIGNATURES) {
    if (pattern.test(rawUrl)) {
      return send(res, 403, 'Forbidden: Suspicious exploit signature blocked by security filter.', {
        'Content-Type': 'text/plain'
      });
    }
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, 'Bad Request: Malformed URI sequence', { 'Content-Type': 'text/plain' });
  }

  if (pathname === '/' || pathname === '') return serveIndex(res);

  // 2. CEK PATH TRAVERSAL (Mencegah ../ keluar dari ROOT folder)
  const normalizedPosix = path.posix.normalize(pathname);
  if (normalizedPosix.includes('..') || normalizedPosix.includes('\0')) {
    return send(res, 403, 'Forbidden: Invalid path sequence', { 'Content-Type': 'text/plain' });
  }

  const filePath = path.resolve(ROOT, '.' + normalizedPosix);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden: Access outside root directory denied', { 'Content-Type': 'text/plain' });
  }

  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // 3. BLOKIR FILE RAHASIA / KONFIGURASI / SYSTEM DIRECTORY
  if (
    BLOCKED_EXT.has(ext) ||
    BLOCKED_FILES.has(fileName) ||
    fileName.startsWith('.') ||
    filePath.includes(path.sep + '.git') ||
    filePath.includes(path.sep + '.agents') ||
    filePath.includes(path.sep + '.gemini')
  ) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  fs.readFile(filePath, (err, content) => {
    if (!err) {
      return send(res, 200, content, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    }
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      // Fallback SPA hanya untuk rute internal tanpa ekstensi file
      return ext ? send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' }) : serveIndex(res);
    }
    send(res, 500, 'Server Error', { 'Content-Type': 'text/plain' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Dapoer Asri running locally at http://localhost:${PORT}`);
});
