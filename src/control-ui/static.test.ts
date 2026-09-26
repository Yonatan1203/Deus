import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveStaticPath, SECURITY_HEADERS } from './static.js';

describe('control-ui static', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');

  it('maps / to index.html and blocks traversal', () => {
    expect(resolveStaticPath(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveStaticPath(root, '/index.html')).toBe(
      path.join(root, 'index.html'),
    );
    expect(resolveStaticPath(root, '/../package.json')).toBeNull();
    expect(resolveStaticPath(root, '/..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveStaticPath(root, '/%00')).toBeNull();
    expect(resolveStaticPath(root, '/%ZZ')).toBeNull();
  });

  it('ships a strict CSP with no inline allowances', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'"); // self-hosted Geist
    expect(csp).not.toContain('unsafe-inline');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });
});

// Compression and validation caching: text is gzip'd when the client takes
// it, fonts never; an unchanged file answers 304 to its own ETag.
import http from 'http';
import { serveStatic } from './static.js';

function fakeRes() {
  const out: {
    status: number;
    headers: Record<string, unknown>;
    body: Buffer;
  } = {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
  };
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      out.status = status;
      out.headers = headers;
    },
    end(data?: Buffer | string) {
      if (data) out.body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    },
  } as unknown as http.ServerResponse;
  return { res, out };
}
const req = (headers: Record<string, string>) =>
  ({ headers }) as unknown as http.IncomingMessage;

describe('control-ui static: gzip and ETag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-gz-'));
  const css = '.a{color:red}\n'.repeat(400);
  fs.writeFileSync(path.join(root, 'app.css'), css);
  fs.writeFileSync(path.join(root, 'f.woff2'), Buffer.alloc(3000, 7));

  it('gzips text when accepted, and sends it plain otherwise', async () => {
    const zlib = await import('zlib');
    const a = fakeRes();
    serveStatic(
      root,
      '/app.css',
      a.res,
      req({ 'accept-encoding': 'gzip, br' }),
    );
    expect(a.out.status).toBe(200);
    expect(a.out.headers['Content-Encoding']).toBe('gzip');
    expect(a.out.headers['Vary']).toBe('Accept-Encoding');
    expect(a.out.body.length).toBeLessThan(css.length / 4);
    expect(zlib.gunzipSync(a.out.body).toString()).toBe(css);
    const b = fakeRes();
    serveStatic(root, '/app.css', b.res, req({}));
    expect(b.out.headers['Content-Encoding']).toBeUndefined();
    expect(b.out.body.toString()).toBe(css);
    expect(a.out.headers['ETag']).toBe(b.out.headers['ETag']);
  });

  it('never gzips fonts', () => {
    const a = fakeRes();
    serveStatic(root, '/f.woff2', a.res, req({ 'accept-encoding': 'gzip' }));
    expect(a.out.headers['Content-Encoding']).toBeUndefined();
    expect(a.out.body.length).toBe(3000);
  });

  it('answers 304 to a matching ETag, and 200 once the file changes', () => {
    const a = fakeRes();
    serveStatic(root, '/app.css', a.res, req({}));
    const etag = String(a.out.headers['ETag']);
    const b = fakeRes();
    serveStatic(root, '/app.css', b.res, req({ 'if-none-match': etag }));
    expect(b.out.status).toBe(304);
    expect(b.out.body.length).toBe(0);
    fs.writeFileSync(path.join(root, 'app.css'), css + '.b{}');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'app.css'), later, later);
    const c = fakeRes();
    serveStatic(root, '/app.css', c.res, req({ 'if-none-match': etag }));
    expect(c.out.status).toBe(200);
    expect(c.out.headers['ETag']).not.toBe(etag);
  });

  it('still works with no request (old call shape)', () => {
    const a = fakeRes();
    serveStatic(root, '/app.css', a.res);
    expect(a.out.status).toBe(200);
    expect(a.out.headers['Content-Encoding']).toBeUndefined();
  });
});
