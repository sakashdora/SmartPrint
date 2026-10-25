import { randomUUID } from 'node:crypto';

const SENSITIVE_KEYS = new Set([
  'password', 'token', 'secret', 'key', 'razorpay_signature',
  'cookie', 'authorization', 'x-razorpay-signature', 'data'
]);

function sanitize(obj, depth = 0) {
  if (depth > 4 || obj == null) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => sanitize(item, depth + 1));
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      clean[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      clean[k] = sanitize(v, depth + 1);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export function logEvent(stage, details = {}) {
  const timestamp = new Date().toISOString();
  const correlationId = details.correlationId || details.reqId || randomUUID();
  const latency = details.latencyMs != null ? `${details.latencyMs.toFixed(1)}ms` : null;

  const logPayload = {
    timestamp,
    stage,
    correlationId,
    ...(latency ? { latencyMs: Number(details.latencyMs.toFixed(1)) } : {}),
    ...sanitize(details)
  };

  const formattedMsg = `[${timestamp}] [${stage}] [corr:${correlationId.slice(0, 8)}]${latency ? ` (${latency})` : ''} ${details.message || ''}`;

  if (process.env.NODE_ENV === 'test') {
    // In test environment, keep console output clean unless DEBUG is set
    if (process.env.DEBUG) console.log(formattedMsg);
  } else {
    console.log(formattedMsg, Object.keys(details).length > 2 ? JSON.stringify(sanitize(details)) : '');
  }

  return logPayload;
}

export function requestLogger(req, res, next) {
  const start = performance.now();
  req.id = req.headers['x-correlation-id'] || randomUUID();
  res.setHeader('X-Correlation-ID', req.id);

  res.on('finish', () => {
    const latencyMs = performance.now() - start;
    if (req.path.startsWith('/api/')) {
      logEvent('http.request', {
        correlationId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        latencyMs,
        ip: req.ip
      });
    }
  });

  next();
}
