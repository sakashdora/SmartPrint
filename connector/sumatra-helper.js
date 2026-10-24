import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export async function ensureSumatraPDF() {
  const localApp = process.env.LOCALAPPDATA || '.';
  const candidatePaths = [
    process.env.SUMATRA_PATH,
    join(localApp, 'SmartPrintConnector', 'SumatraPDF.exe'),
    join(__dirname, 'bin', 'SumatraPDF.exe'),
    join(__dirname, 'SumatraPDF.exe'),
    'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
    'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe'
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const info = await stat(p);
        if (info.isFile() && info.size > 100000) {
          return resolve(p);
        }
      } catch {}
    }
  }

  // Auto-download portable SumatraPDF to %LOCALAPPDATA%\SmartPrintConnector\SumatraPDF.exe
  const targetDir = resolve(localApp, 'SmartPrintConnector');
  await mkdir(targetDir, { recursive: true });
  const targetExe = join(targetDir, 'SumatraPDF.exe');
  const tempZip = join(targetDir, 'sumatra_portable.zip');

  const downloadUrls = [
    'https://files.sumatrapdfreader.org/software/sumatrapdf/rel/3.5.2/SumatraPDF-3.5.2-64.zip',
    'https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.zip'
  ];

  for (const url of downloadUrls) {
    try {
      console.log(`[SumatraPDF] Downloading portable helper from ${url}...`);
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) continue;
      const arrayBuffer = await response.arrayBuffer();
      await writeFile(tempZip, Buffer.from(arrayBuffer));

      // Extract using native Windows tar.exe (no PowerShell needed)
      await run('tar.exe', ['-xf', tempZip, '-C', targetDir], { timeout: 45000, windowsHide: true });

      await unlink(tempZip).catch(() => {});

      if (!existsSync(targetExe)) {
        const { readdirSync, copyFileSync } = await import('node:fs');
        const files = readdirSync(targetDir);
        const match = files.find(f => /^SumatraPDF.*\.exe$/i.test(f));
        if (match) {
          copyFileSync(join(targetDir, match), targetExe);
        }
      }

      if (existsSync(targetExe)) {
        console.log(`[SumatraPDF] Portable SumatraPDF verified at ${targetExe}`);
        return targetExe;
      }
    } catch (err) {
      console.warn(`[SumatraPDF] Download attempt failed: ${err.message}`);
      await unlink(tempZip).catch(() => {});
    }
  }

  return null;
}

export async function printPdfToWindowsPrinter({ pdfPath, printerName, options = {}, sumatraPath = null }) {
  if (sumatraPath && existsSync(sumatraPath)) {
    const settings = [
      'paper=A4',
      'noscale',
      options.color === 'color' ? 'color' : 'monochrome',
      options.duplex ? 'duplexlong' : 'simplex',
      `${options.copies || 1}x`,
      'collate'
    ].join(',');

    try {
      await run(sumatraPath, [
        '-print-to', printerName,
        '-print-settings', settings,
        '-silent',
        pdfPath
      ], { timeout: 180000, windowsHide: true, maxBuffer: 65536 });
      return { method: 'sumatrapdf' };
    } catch (sumatraErr) {
      console.warn(`[Print Helper] SumatraPDF advanced settings print failed (${sumatraErr.message}). Retrying with simple print...`);
      try {
        await run(sumatraPath, [
          '-print-to', printerName,
          '-silent',
          pdfPath
        ], { timeout: 180000, windowsHide: true, maxBuffer: 65536 });
        return { method: 'sumatrapdf-simple' };
      } catch (retryErr) {
        console.warn(`[Print Helper] SumatraPDF simple print also failed (${retryErr.message}).`);
      }
    }
  }

  const helper = await ensureSumatraPDF();
  if (helper && existsSync(helper)) {
    try {
      await run(helper, [
        '-print-to', printerName,
        '-silent',
        pdfPath
      ], { timeout: 180000, windowsHide: true, maxBuffer: 65536 });
      return { method: 'sumatrapdf' };
    } catch (helperErr) {
      console.warn(`[Print Helper] Portable SumatraPDF failed: ${helperErr.message}`);
    }
  }

  // Windows Spooler Native Fallback via PowerShell
  if (process.platform === 'win32') {
    try {
      console.log(`[Print Helper] Falling back to Windows native spooler for "${printerName}"...`);
      const psCommand = `Start-Process -FilePath "${pdfPath.replace(/"/g, '`"')}" -Verb PrintTo -ArgumentList "${printerName.replace(/"/g, '`"')}" -Wait -PassThru -WindowStyle Hidden`;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { timeout: 60000, windowsHide: true });
      return { method: 'powershell-spooler' };
    } catch (psErr) {
      console.error(`[Print Helper] Windows spooler fallback failed: ${psErr.message}`);
    }
  }

  return { method: 'direct-spooler' };
}
