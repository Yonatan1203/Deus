import crypto from 'crypto';
import fs from 'fs';
import type { IncomingHttpHeaders, ServerResponse } from 'http';
import path from 'path';
import zlib from 'zlib';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Applied to EVERY response by server.ts. The app has no inline script or
// style, so the CSP needs no nonce; anything rendered from API data goes in
// as a text node, and the policy is the backstop if that rule is ever broken.
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; manifest-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export function resolveStaticPath(
  rootDir: string,
  urlPath: string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const root = path.resolve(rootDir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

// Text is worth compressing over an SSH tunnel to a phone; fonts and images
// are already packed. Gzipped bytes and the ETag are memoized per file
// version, so a request costs a stat, not a compression. Compressing is
// synchronous on purpose: it happens once per file version for a few small
// files, on a single-operator server.
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
]);
const MEMO_MAX = 64;
const memo = new Map<
  string,
  { key: string; raw: Buffer; gz: Buffer | null; etag: string }
>();

export function serveStatic(
  rootDir: string,
  urlPath: string,
  res: ServerResponse,
  req?: { headers: IncomingHttpHeaders },
): void {
  const full = resolveStaticPath(rootDir, urlPath);
  let st: fs.Stats;
  try {
    if (!full) throw new Error('bad path');
    st = fs.statSync(full);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const key = `${st.mtimeMs}:${st.size}`;
  let entry = memo.get(full);
  if (!entry || entry.key !== key) {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(full);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    entry = {
      key,
      raw,
      gz: COMPRESSIBLE.has(ext) ? zlib.gzipSync(raw, { level: 6 }) : null,
      etag: `"${crypto.createHash('sha1').update(raw).digest('hex')}"`,
    };
    memo.delete(full);
    memo.set(full, entry);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string); // non-empty: size > 0
  }
  // The shell and the service worker must never be served stale; assets may be.
  const cache =
    ext === '.html' || path.basename(full) === 'sw.js'
      ? 'no-cache'
      : 'public, max-age=3600';
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': cache,
    ETag: entry.etag,
    Vary: 'Accept-Encoding',
  };
  const ifNoneMatch = req?.headers['if-none-match'];
  if (
    ifNoneMatch &&
    ifNoneMatch.split(',').some((t) => t.trim() === entry.etag)
  ) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const accept = String(req?.headers['accept-encoding'] ?? '');
  const body = entry.gz && /\bgzip\b/.test(accept) ? entry.gz : entry.raw;
  if (body !== entry.raw) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}
