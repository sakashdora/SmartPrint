import { createServer } from 'node:http';

// A tiny HTTP endpoint on 127.0.0.1 that lets the SmartPrint Printers page, opened on the shop PC,
// read this PC's real printers and link this connector with one click: the device key goes straight
// from the dashboard to the connector, so the owner never copies a key or a command.
export const BRIDGE_PORT = Number(process.env.SMARTPRINT_BRIDGE_PORT) || 17631;
export const DEFAULT_TRUSTED_ORIGINS = ['https://smartprint-ieks.onrender.com'];

const originOf = value => { try { return new URL(value).origin; } catch { return ''; } };

// Pages allowed to talk to the connector: the SmartPrint server it is linked to, the hosted SmartPrint
// app, extra origins from SMARTPRINT_TRUSTED_ORIGINS, and a dashboard served from this PC itself.
// Any other website gets no CORS grant, so the browser blocks it from reading or pairing.
export function isTrustedOrigin(origin, { base = '', extra = [] } = {}) {
  if (!origin || origin === 'null') return false;
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return true;
  if (originOf(base) === origin) return true;
  return [...DEFAULT_TRUSTED_ORIGINS, ...extra].map(originOf).includes(origin);
}

async function readJson(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

// `connector` supplies: state() -> { base, linked, needsRelink, printer }, printers() -> list,
// pair({ url, token, printer }) -> { printer }. `extraOrigins` adds trusted origins.
export function createBridgeHandler(connector, { extraOrigins = [] } = {}) {
  return async (req, res) => {
    const origin = req.headers.origin || '';
    const trusted = isTrustedOrigin(origin, { base: connector.state().base, extra: extraOrigins });
    const send = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Vary: 'Origin',
        ...(trusted ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Private-Network': 'true' } : {})
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
      if (req.method === 'OPTIONS') {
        if (!trusted) return send(403, { error: 'Origin not allowed.' });
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin'
        });
        return res.end();
      }
      // A request without a trusted Origin (another website, or a plain script) gets nothing.
      if (!trusted) return send(403, { error: 'Origin not allowed.' });
      if (req.method === 'GET' && path === '/status') {
        const s = connector.state();
        return send(200, {
          app: 'smartprint-connector',
          version: 3,
          linked: s.linked,
          needsRelink: s.needsRelink,
          server: originOf(s.base),
          linkedHere: s.linked && originOf(s.base) === origin,
          printer: s.printer || '',
          // ?printers=0 is the cheap "is the connector running" check the Printers page polls.
          printers: url.searchParams.get('printers') === '0' ? [] : await connector.printers({ fresh: url.searchParams.has('fresh') })
        });
      }
      if (req.method === 'POST' && path === '/pair') {
        const body = await readJson(req);
        const target = String(body.url || ''), token = String(body.token || ''), printer = String(body.printer || '').trim().slice(0, 200);
        // A page can only link the connector to its own server.
        if (originOf(target) !== origin) return send(400, { error: 'The server address must match this page.' });
        if (!/^[A-Za-z0-9_-]{16,200}$/.test(token)) return send(400, { error: 'Invalid device key.' });
        const s = connector.state();
        if (s.linked && originOf(s.base) !== origin && body.replace !== true) {
          return send(409, { error: 'linked-elsewhere', server: originOf(s.base) });
        }
        const result = await connector.pair({ url: origin, token, printer });
        return send(200, { ok: true, printer: result.printer });
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      return send(error.status || 500, { error: error.message || 'Connector error.' });
    }
  };
}

export function startBridge(connector, { port = BRIDGE_PORT, extraOrigins = [], log = console.log } = {}) {
  const server = createServer(createBridgeHandler(connector, { extraOrigins }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); log(`  Dashboard link: http://127.0.0.1:${port} (this PC only)`); resolve(server); });
  });
}
