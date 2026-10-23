import { createApp } from '../server/index.js';
let service;
export default async function handler(req, res) {
  try { service ??= createApp({ seed: false }).catch(error => { service = undefined; throw error; }); const { app } = await service; return app(req, res); }
  catch { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Service configuration or database unavailable. Contact the operator.' })); }
}
