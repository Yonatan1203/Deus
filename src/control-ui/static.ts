import fs from 'fs';
import type { ServerResponse } from 'http';
import path from 'path';

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
    "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; " +
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

export function serveStatic(
  rootDir: string,
  urlPath: string,
  res: ServerResponse,
): void {
  const full = resolveStaticPath(rootDir, urlPath);
  let data: Buffer;
  try {
    if (!full || !fs.statSync(full).isFile()) throw new Error('not a file');
    data = fs.readFileSync(full);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  // The shell and the service worker must never be served stale; assets may be.
  const cache =
    ext === '.html' || path.basename(full) === 'sw.js'
      ? 'no-cache'
      : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': cache,
  });
  res.end(data);
}
