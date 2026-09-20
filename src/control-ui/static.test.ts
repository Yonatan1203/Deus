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
    expect(csp).not.toContain('unsafe-inline');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });
});
