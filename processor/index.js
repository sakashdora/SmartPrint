import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scan } from './clam.js';
import { localProcess } from '../server/process-client.js';
import { validateOptions } from '../server/printing.js';
const run = promisify(execFile), app = express();
if (!process.env.PROCESSOR_SECRET || process.env.PROCESSOR_SECRET.length < 32) throw new Error('PROCESSOR_SECRET is required.');
let active = 0;
app.use((req, res, next) => { const received = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${process.env.PROCESSOR_SECRET}`); if (received.length !== expected.length || !timingSafeEqual(received, expected)) return res.sendStatus(401); next(); });
app.use(express.json({ limit: '29mb' }));
app.post('/prepare', async (req, res) => {
  if (active >= 1) return res.status(429).json({ error: 'Printer preparation is busy. Try again shortly.' });
  active++;
  let temporary;
  try {
    const options = validateOptions(req.body.options), files = req.body.files;
    if (!Array.isArray(files) || files.length < 1 || files.length > 2) throw new Error('Choose one document or two card images.');
    let total = 0;
    temporary = await mkdtemp(join(tmpdir(), 'smartprint-'));
    const profile = join(temporary, 'profile');
    await mkdir(join(profile, 'user'), { recursive: true });
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item></oor:items>');
    const converted = [];
    for (const file of files) {
      if (typeof file.data !== 'string') throw new Error('Invalid file.');
      const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
      if (total > 20 * 1024 * 1024) throw new Error('Files must total 20 MiB or less.');
      await scan(bytes);
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const extension = String(file.name ?? '').split('.').pop().toLowerCase();
        if (!['docx', 'pptx', 'xlsx'].includes(extension)) throw new Error('Supported Office formats are DOCX, PPTX and XLSX.');
        const path = join(temporary, `document.${extension}`);
        await writeFile(path, bytes, { mode: 0o600 });
        await run('libreoffice', [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', temporary, path], { timeout: 60000, maxBuffer: 65536, env: { PATH: process.env.PATH, HOME: temporary } });
        const pdfPath = join(temporary, 'document.pdf');
        if ((await stat(pdfPath)).size > 40 * 1024 * 1024) throw new Error('Converted document is too large.');
        const pdf = await readFile(pdfPath); await scan(pdf); converted.push({ data: pdf.toString('base64') });
      } else converted.push(file);
    }
    const result = await localProcess(converted, options);
    if (result.bytes.length > 40 * 1024 * 1024) throw new Error('Prepared PDF exceeds 40 MiB. Reduce the number of pages or image resolution.');
    res.json({ pages: result.pages, outputPages: result.outputPages, data: Buffer.from(result.bytes).toString('base64') });
  } catch (error) { res.status(400).json({ error: error.message.startsWith('Command failed') || error.code ? 'Unable to convert this document. Export it as PDF and try again.' : error.message }); }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); active--; }
});
app.listen(4000, '0.0.0.0', () => console.log('Isolated processor listening on port 4000'));
