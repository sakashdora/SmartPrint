import { createServer } from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateOptions, price } from '../server/print-options.js';
import { prepare } from '../server/printing.js';

// The outage portal: a small web page served by the agent on the campus network so that people can still print when
// the internet (and therefore SmartPrint) is down.
//
//  * It accepts work ONLY while the agent cannot reach the server. While the internet works it sends people to the
//    website, so the normal queue, wallet and audit trail are never bypassed.
//  * Students identify themselves with the PIN chosen when they reserved money; the cost is taken from that
//    reservation (never more than was reserved). Staff use the offline PIN they set while online and print without
//    charge up to a daily page limit. Cloud passwords are never entered here.
//  * Wrong PINs lock the ID until the agent is back online. Every spend and job goes to the agent's numbered local log
//    and is applied by the server once, when the connection returns.
//  * The page is plain HTTP on the local network: the PIN crosses that network unencrypted. Use it on a trusted
//    network, or put it behind a TLS-terminating proxy.
const MAX_BYTES = 20 * 1024 * 1024;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
const refuse = (status, code, error) => Object.assign(new Error(error), { status, code });

const PAGE = state => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartPrint · Offline printing</title>
<style>body{font:16px system-ui,sans-serif;max-width:30rem;margin:2rem auto;padding:0 1rem;color:#111}label{display:block;margin:.8rem 0 .2rem;font-weight:600}input,select,button{font:inherit;width:100%;padding:.55rem;box-sizing:border-box}button{margin-top:1rem;background:#2563eb;color:#fff;border:0;border-radius:.4rem}.note{background:#fff7e6;border:1px solid #f0d49b;padding:.7rem;border-radius:.4rem}.ok{color:#0a6b2a}.bad{color:#b42318}</style></head><body>
<h1>Offline printing</h1>${state.offline ? '<p class="note">The internet is down. You can still print here with your ID and offline PIN.</p>' : '<p class="note">The internet is working. Please print from the SmartPrint website instead.</p>'}
<form id="f"${state.offline ? '' : ' hidden'}>
<label>College / staff ID<input name="id" required autocomplete="username"></label>
<label>Offline PIN<input name="pin" type="password" inputmode="numeric" required autocomplete="off"></label>
<label>File (PDF, PNG or JPEG)<input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required></label>
<label>Copies<input name="copies" type="number" min="1" max="${esc(state.maxCopies)}" value="1"></label>
<label>Colour<select name="color"><option value="bw">Black &amp; white</option><option value="color">Colour</option></select></label>
<button>Print</button></form><p id="out" role="status"></p>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const f=e.target,o=document.getElementById('out');o.className='';o.textContent='Printing…';const file=f.file.files[0];
try{const r=await fetch('/print',{method:'POST',headers:{'Content-Type':file.type,'X-College-Id':encodeURIComponent(f.id.value),'X-Pin':encodeURIComponent(f.pin.value),'X-Options':JSON.stringify({copies:Number(f.copies.value),color:f.color.value})},body:file});
const b=await r.json();o.className=r.ok?'ok':'bad';o.textContent=r.ok?('Sent to the printer: '+b.pages+' page(s)'+(b.chargedMinor?(', ₹'+(b.chargedMinor/100).toFixed(2)+' from your reservation, ₹'+(b.remainingMinor/100).toFixed(2)+' left'):'')+'.'):b.error;f.pin.value='';}catch(x){o.className='bad';o.textContent='Could not reach the print point.';}};</script></body></html>`;

export function startPortal(core, { port = 17640, host = '0.0.0.0', alwaysOpen = false, perMinute = 40, log = () => {} } = {}) {
  const hits = new Map();
  let chain = Promise.resolve(); // one job at a time, so the remaining reservation is always checked against the latest spend
  const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  async function handlePrint(req, bytes) {
    if (!alwaysOpen && !core.isOffline()) throw refuse(409, 'portal.online', 'The internet is working: please print from the SmartPrint website.');
    const limits = core.settings.offline?.limits, rates = core.settings.offline?.rates;
    if (!limits || !rates) throw refuse(503, 'portal.not_ready', 'This print point has not been set up for offline printing yet.');
    const type = String(req.headers['content-type'] || '').split(';')[0];
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255, pdf = bytes.subarray(0, 5).toString() === '%PDF-';
    if (!bytes.length || !(pdf || png || jpg) || !['application/pdf', 'image/png', 'image/jpeg'].includes(type)) throw refuse(400, 'portal.file', 'Send a PDF, PNG or JPEG file.');
    const collegeId = decodeURIComponent(String(req.headers['x-college-id'] || '')).trim(), pin = decodeURIComponent(String(req.headers['x-pin'] || ''));
    if (!collegeId) throw refuse(400, 'portal.id', 'Enter your ID.');
    let options;
    try { options = validateOptions(JSON.parse(req.headers['x-options'] || '{}')); } catch (error) { throw refuse(400, 'portal.options', error.message); }
    if (options.layout === 'card') throw refuse(400, 'portal.options', 'Card layout is not available here.');
    if (options.copies > limits.maxCopies) throw refuse(400, 'portal.copies', `At most ${limits.maxCopies} copies.`);

    // Who is it? Staff with an offline PIN first, otherwise a student with a reservation at this print point.
    let staff = null;
    try { staff = limits.staffEnabled ? core.localStaffAuth(collegeId, pin) : null; } catch (error) { throw refuse(403, error.code, error.message); }
    if (options.color === 'color' && !(staff ? limits.colourStaff : limits.colourStudents)) throw refuse(400, 'portal.colour', 'Colour printing is not allowed for your account.');
    let prepared;
    try { prepared = await prepare([{ data: bytes.toString('base64') }], options); } catch (error) { throw refuse(400, 'portal.file', `Unable to prepare the file: ${error.message}`); }
    if (prepared.pages > limits.maxPagesPerJob) throw refuse(400, 'portal.pages', `At most ${limits.maxPagesPerJob} pages per job.`);
    const sheetPages = prepared.pages * options.copies;

    let spend = null, amountMinor = 0;
    if (staff) {
      if (core.staffPagesToday() + sheetPages > limits.staffDailyPages) throw refuse(429, 'portal.daily_limit', `The daily limit of ${limits.staffDailyPages} offline pages was reached.`);
    } else {
      if (!limits.studentsEnabled) throw refuse(403, 'offline.disabled', 'Offline printing is not enabled for students.');
      amountMinor = price(prepared.pages, options, { bw: rates.bw, color: rates.color }).amount;
      try { spend = core.localSpend({ collegeId, pin, pages: sheetPages, amountMinor, jobRef: randomUUID() }); }
      catch (error) { throw refuse(error.code === 'offline.insufficient' ? 402 : 403, error.code, error.message); }
    }
    const undo = () => { if (spend) core.adjustSpend(spend.seq, 0); };

    // A printer that can do the job and that Windows says is working.
    const printers = (await core.driver.listPrinters()).filter(p => String(p.status).toLowerCase() !== 'offline' && (options.color !== 'color' || p.color === true) && (!options.duplex || p.duplex === true));
    if (!printers.length) { undo(); throw refuse(503, 'portal.no_printer', 'No working printer can do this job right now.'); }
    const pdfPath = join(core.dir, 'cache', `portal-${randomUUID()}.pdf`);
    let outcome;
    try {
      writeFileSync(pdfPath, prepared.bytes, { mode: 0o600 });
      outcome = await core.driver.print({ printerName: printers[0].name, pdfPath, options, jobPages: sheetPages });
    } catch (error) { outcome = { outcome: 'failed', error: error.message, nothingPrinted: false }; }
    finally { try { unlinkSync(pdfPath); } catch {} }

    if (outcome.outcome === 'completed') {
      if (staff) core.recordOfflineStaffJob({ collegeId: staff.collegeId, pages: sheetPages, fileName: 'offline portal' });
      return { ok: true, pages: sheetPages, chargedMinor: amountMinor, remainingMinor: spend?.remainingMinor ?? 0 };
    }
    const printed = Number(outcome.pages) || 0;
    if (outcome.nothingPrinted === true && printed === 0) { undo(); throw refuse(502, 'portal.print_failed', `The printer did not print: ${outcome.error || 'unknown problem'}. You were not charged.`); }
    // Partly or unknowably printed: charge only for the pages known to have come out.
    if (spend) core.adjustSpend(spend.seq, Math.ceil(amountMinor * Math.min(printed, sheetPages) / sheetPages));
    if (staff && printed > 0) core.recordOfflineStaffJob({ collegeId: staff.collegeId, pages: printed, fileName: 'offline portal (partial)' });
    throw refuse(502, 'portal.partial', `The job did not finish${printed ? ` (${printed} page(s) came out)` : ''}. ${spend ? 'You are charged only for pages that printed.' : ''}`.trim());
  }

  const server = createServer((req, res) => {
    const ip = req.socket.remoteAddress, minute = Math.floor(Date.now() / 60000), key = `${ip}:${minute}`;
    hits.set(key, (hits.get(key) || 0) + 1); for (const k of hits.keys()) if (!k.endsWith(`:${minute}`)) hits.delete(k);
    if (hits.get(key) > perMinute) return json(res, 429, { error: 'Too many requests. Wait a minute.' });
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && path === '/') {
      const limits = core.settings.offline?.limits ?? {};
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(PAGE({ offline: alwaysOpen || core.isOffline(), maxCopies: limits.maxCopies ?? 20 }));
    }
    if (req.method === 'GET' && path === '/status') return json(res, 200, { offline: alwaysOpen || core.isOffline() });
    if (req.method === 'POST' && path === '/print') {
      const chunks = []; let size = 0, tooBig = false;
      req.on('data', c => { size += c.length; if (size > MAX_BYTES) { tooBig = true; req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (tooBig) return json(res, 413, { error: 'The file is larger than 20 MB.' });
        serial(() => handlePrint(req, Buffer.concat(chunks))).then(result => json(res, 200, result), error => json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong.', code: error.code }));
      });
      return;
    }
    json(res, 404, { error: 'Not found.' });
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { log(`[Portal] Offline printing page on http://${host}:${server.address().port} (LAN, plain HTTP)`); resolve(server); }); });
}
