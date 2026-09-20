import type { IncomingMessage, ServerResponse } from 'http';
import type { SessionInfo } from './auth.js';

export type AuthMode = 'session' | 'ticket' | 'none';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  remoteAddr: string;
  session: SessionInfo | null;
}

export type Handler = (ctx: RequestContext) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  auth: AuthMode;
  mutation: boolean;
}

export type Match =
  | {
      kind: 'ok';
      handler: Handler;
      auth: AuthMode;
      mutation: boolean;
      params: Record<string, string>;
    }
  | { kind: 'not_found' }
  | { kind: 'method_not_allowed' };

const split = (p: string): string[] => p.split('/').filter(Boolean);

export function createRouter() {
  const routes: Route[] = [];
  return {
    add(
      method: string,
      pattern: string,
      handler: Handler,
      opts?: { auth?: AuthMode; mutation?: boolean },
    ) {
      routes.push({
        method,
        segments: split(pattern),
        handler,
        auth: opts?.auth ?? 'session',
        mutation: opts?.mutation ?? (method !== 'GET' && method !== 'HEAD'),
      });
    },
    match(method: string, pathname: string): Match {
      const parts = split(pathname);
      let pathMatched = false;
      for (const r of routes) {
        if (r.segments.length !== parts.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < parts.length; i++) {
          const seg = r.segments[i];
          if (seg.startsWith(':')) {
            try {
              params[seg.slice(1)] = decodeURIComponent(parts[i]);
            } catch {
              ok = false;
              break;
            }
          } else if (seg !== parts[i]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        pathMatched = true;
        if (r.method === method) {
          return {
            kind: 'ok',
            handler: r.handler,
            auth: r.auth,
            mutation: r.mutation,
            params,
          };
        }
      }
      return pathMatched
        ? { kind: 'method_not_allowed' }
        : { kind: 'not_found' };
    },
  };
}
