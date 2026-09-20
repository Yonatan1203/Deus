import type { IncomingMessage, ServerResponse } from 'http';

export interface EventHub {
  attach(req: IncomingMessage, res: ServerResponse): boolean;
  broadcast(type: string, data: unknown): void;
  clientCount(): number;
  close(): void;
}

export function createEventHub(
  opts: { keepaliveMs?: number; ringSize?: number; maxClients?: number } = {},
): EventHub {
  const keepaliveMs = opts.keepaliveMs ?? 20_000;
  const ringSize = opts.ringSize ?? 256;
  const maxClients = opts.maxClients ?? 8;
  const clients = new Map<ServerResponse, number>(); // res → consecutive full-buffer writes
  const ring: { id: number; frame: string }[] = [];
  let nextId = 1;

  const timer = setInterval(() => {
    for (const res of clients.keys()) res.write(': ping\n\n');
  }, keepaliveMs);
  timer.unref();

  return {
    attach(req, res) {
      if (clients.size >= maxClients) return false;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': ok\n\n');
      const last = Number(req.headers['last-event-id']);
      if (Number.isFinite(last)) {
        for (const e of ring) if (e.id > last) res.write(e.frame);
      }
      clients.set(res, 0);
      req.on('close', () => clients.delete(res));
      return true;
    },
    broadcast(type, data) {
      const id = nextId++;
      const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      ring.push({ id, frame });
      if (ring.length > ringSize) ring.shift();
      for (const [res, stalls] of clients) {
        if (res.write(frame)) {
          clients.set(res, 0);
        } else if (stalls + 1 >= 2) {
          clients.delete(res);
          res.end();
        } else {
          clients.set(res, stalls + 1);
        }
      }
    },
    clientCount() {
      return clients.size;
    },
    close() {
      clearInterval(timer);
      for (const res of clients.keys()) res.end();
      clients.clear();
    },
  };
}
