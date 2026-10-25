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

export function checkPrinterStatus(codeOrStr) {
  if (codeOrStr === 0 || codeOrStr === 'Normal' || codeOrStr === 'Ready' || codeOrStr === 3) {
    return { status: 'Ready', isOffline: false };
  }
  if (codeOrStr === 128 || codeOrStr === 'Offline' || String(codeOrStr).toLowerCase() === 'offline') {
    return { status: 'Offline', isOffline: true };
  }
  if (codeOrStr == null) {
    return { status: 'Unknown', isOffline: false };
  }
  return { status: String(codeOrStr), isOffline: false };
}

export function resolveActivePrinter(targetName, printerList = []) {
  if (!targetName) return { name: '', status: 'Unknown', switched: false };
  const exact = printerList.find(p => p.Name && p.Name.toLowerCase() === targetName.toLowerCase());
  
  if (!exact) {
    return { name: targetName, status: 'Unknown', switched: false };
  }

  const { status, isOffline } = checkPrinterStatus(exact.PrinterStatus);
  if (!isOffline) {
    return { name: exact.Name, status: 'Ready', switched: false, port: exact.PortName };
  }

  // Exact configured printer is OFFLINE! Look for active counterpart (e.g. same driver or model)
  const baseModel = exact.Name.replace(/\s*\(copy\s*\d+\)|\s*USB|\s*WiFi|\s*Network|\s*\(.*?\)/gi, '').trim().toLowerCase();
  const onlineCounterpart = printerList.find(p => {
    if (p.Name === exact.Name) return false;
    const { isOffline: counterOffline } = checkPrinterStatus(p.PrinterStatus);
    if (counterOffline) return false;
    const pModel = (p.Name || '').replace(/\s*\(copy\s*\d+\)|\s*USB|\s*WiFi|\s*Network|\s*\(.*?\)/gi, '').trim().toLowerCase();
    const sameDriver = exact.DriverName && p.DriverName && exact.DriverName.toLowerCase() === p.DriverName.toLowerCase();
    return sameDriver || (baseModel && pModel && (baseModel === pModel || pModel.includes(baseModel) || baseModel.includes(pModel)));
  });

  if (onlineCounterpart) {
    return {
      name: onlineCounterpart.Name,
      status: 'Ready',
      switched: true,
      reason: `Configured printer "${exact.Name}" is Offline. Switched to online counterpart "${onlineCounterpart.Name}".`,
      port: onlineCounterpart.PortName
    };
  }

  return { name: exact.Name, status: 'Offline', switched: false, port: exact.PortName };
}

export async function getWindowsPrinters() {
  if (process.platform !== 'win32') return [];
  try {
    const ps = 'Get-Printer | Select-Object Name, PrinterStatus, PortName, DriverName, Default | ConvertTo-Json -Compress';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 6000, windowsHide: true });
    if (!stdout || !stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function printPdfToWindowsPrinter({ pdfPath, printerName, options = {}, sumatraPath = null }) {
  if (!existsSync(pdfPath)) {
    throw new Error(`Print file not found at ${pdfPath}`);
  }
  if (!printerName) {
    throw new Error('Printer name is required for Windows printing.');
  }

  let targetPrinter = printerName;
  if (process.platform === 'win32') {
    const installed = await getWindowsPrinters();
    if (installed.length) {
      const resolution = resolveActivePrinter(printerName, installed);
      if (resolution.switched) {
        console.log(`[Print Helper] ${resolution.reason}`);
        targetPrinter = resolution.name;
      } else if (resolution.status === 'Offline') {
        throw new Error(`Printer "${printerName}" is currently Offline in Windows Spooler (Port: ${resolution.port || 'Unknown'}). Please check USB cable or power.`);
      }
    }
  }

  const cleanSettings = [
    options.color === 'color' ? 'color' : 'monochrome',
    options.duplex ? 'duplex' : 'simplex',
    `${Math.max(1, Number(options.copies) || 1)}x`,
    'paper=A4',
    'fit'
  ].join(',');

  let printMethod = null;
  if (sumatraPath && existsSync(sumatraPath)) {
    try {
      await run(sumatraPath, [
        '-print-to', targetPrinter,
        '-print-settings', cleanSettings,
        '-silent',
        pdfPath
      ], { timeout: 180000, windowsHide: true, maxBuffer: 65536 });
      printMethod = 'sumatrapdf-settings';
    } catch (sumatraErr) {
      console.warn(`[Print Helper] SumatraPDF advanced settings print failed (${sumatraErr.message}). Retrying with simple print...`);
      try {
        await run(sumatraPath, [
          '-print-to', targetPrinter,
          '-silent',
          pdfPath
        ], { timeout: 180000, windowsHide: true, maxBuffer: 65536 });
        printMethod = 'sumatrapdf-simple';
      } catch (retryErr) {
        console.warn(`[Print Helper] SumatraPDF simple print also failed (${retryErr.message}).`);
      }
    }
  }

  if (!printMethod) {
    const helper = await ensureSumatraPDF();
    if (helper && existsSync(helper) && helper !== sumatraPath) {
      try {
        await run(helper, [
          '-print-to', targetPrinter,
          '-silent',
          pdfPath
        ], { timeout: 180000, windowsHide: true, maxBuffer: 65536 });
        printMethod = 'sumatrapdf-portable';
      } catch (helperErr) {
        console.warn(`[Print Helper] Portable SumatraPDF failed: ${helperErr.message}`);
      }
    }
  }

  // Windows Spooler Native Fallback via PowerShell
  if (!printMethod && process.platform === 'win32') {
    try {
      console.log(`[Print Helper] Falling back to Windows native spooler for "${targetPrinter}"...`);
      const psCommand = `Start-Process -FilePath "${pdfPath.replace(/"/g, '`"')}" -Verb PrintTo -ArgumentList "${targetPrinter.replace(/"/g, '`"')}" -Wait -PassThru -WindowStyle Hidden`;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { timeout: 60000, windowsHide: true });
      printMethod = 'powershell-spooler';
    } catch (psErr) {
      throw new Error(`Windows Print Spooler submission failed for "${targetPrinter}": ${psErr.message}`);
    }
  }

  if (!printMethod) {
    throw new Error(`Could not print document to "${targetPrinter}". No working print engine available.`);
  }

  // Post-submission verification: verify spooler does not report immediate error
  if (process.platform === 'win32') {
    try {
      const psCheck = `Get-PrintJob -PrinterName "${targetPrinter.replace(/"/g, '`"')}" -ErrorAction SilentlyContinue | Select-Object Id, JobStatus | ConvertTo-Json -Compress`;
      const { stdout: jobOut } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCheck], { timeout: 3000, windowsHide: true });
      if (jobOut && jobOut.trim()) {
        const jobs = JSON.parse(jobOut);
        const list = Array.isArray(jobs) ? jobs : [jobs];
        const errorJob = list.find(j => j.JobStatus && /Error|Blocked|Offline/i.test(String(j.JobStatus)));
        if (errorJob) {
          throw new Error(`Printer "${targetPrinter}" reported spooler error: ${errorJob.JobStatus}`);
        }
      }
    } catch (spoolErr) {
      if (spoolErr.message.includes('reported spooler error')) throw spoolErr;
    }
  }

  return { method: printMethod, printer: targetPrinter };
}
