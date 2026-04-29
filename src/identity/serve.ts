/**
 * Tiny HTTP server for the three .well-known endpoints.
 *
 * Uses Node's built-in `http` (no Hono dep). We serve:
 *   - GET /.well-known/agent-card.json          (A2A AgentCard)
 *   - GET /.well-known/agent-registration.json  (EIP-8004 endpoint-domain proof)
 *   - GET /.well-known/oasf-record.json         (optional; only if `oasf` provided)
 *   - GET /agent-card                           (alias for convenience)
 *
 * Response: `application/json; charset=utf-8`, CORS-permissive (* origin),
 * cache-control: public, max-age=60. Same defaults Lucid Agents uses.
 *
 * For production deployment behind a reverse proxy, just set
 * `X-Frqncy-Agent-Id` and serve the static JSON; this server is for the dev
 * loop and the Hermes daemon use case.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  toA2AAgentCard,
  toAgentRegistrationProof,
  type AgentCard,
} from './agent-card.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  card: AgentCard;
  /** Optional OASF record body — emitted at /.well-known/oasf-record.json. */
  oasf?: unknown;
  /** Override the request handler for additional routes (e.g. health checks). */
  onUnhandled?: (req: IncomingMessage, res: ServerResponse) => void;
}

export interface ServingHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function serveAgentCard(opts: ServeOptions): Promise<ServingHandle> {
  const port = opts.port ?? Number(process.env.FRQNCY_AGENT_PORT ?? 3030);
  const host = opts.host ?? '0.0.0.0';

  const a2aCard = toA2AAgentCard(opts.card);
  const registration = toAgentRegistrationProof(opts.card);

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=60');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === '/.well-known/agent-card.json' || url === '/agent-card') {
      writeJson(res, 200, a2aCard);
      return;
    }
    if (url === '/.well-known/agent-registration.json') {
      writeJson(res, 200, registration);
      return;
    }
    if (url === '/.well-known/oasf-record.json' && opts.oasf) {
      writeJson(res, 200, opts.oasf);
      return;
    }
    if (url === '/healthz' || url === '/health') {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    if (opts.onUnhandled) {
      opts.onUnhandled(req, res);
      return;
    }

    writeJson(res, 404, { error: 'not_found', path: url });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // When port = 0 the OS picked a free port; `server.address()` reports the
  // actual binding. Always trust it over `port` so URLs are correct in tests.
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${boundPort}`;

  return {
    url,
    port: boundPort,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
