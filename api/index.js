import { createApp } from '../server/index.js';
let service;
export default async function handler(req, res) {
  try {
    service ??= createApp({ seed: false }).catch(error => {
      service = undefined;
      throw error;
    });
    const { app } = await service;
    return app(req, res);
  } catch (error) {
    console.error('Vercel serverless startup error:', error);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: error.message || 'Service configuration or database unavailable. Contact the operator.'
    }));
  }
}
