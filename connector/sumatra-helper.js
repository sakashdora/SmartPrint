import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isVirtualPrinter } from '../server/printer-capabilities.js';

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

// Get-Printer's PrinterStatus is the Windows spooler bitmask (PRINTER_STATUS_*). Only the OFFLINE bit
// means jobs cannot reach the printer; busy, printing, warming up, power save or toner low still print.
// Matching the whole value against 0 used to treat an idle HP LaserJet in power save as unusable.
const STATUS_BITS = [
  [0x80, 'Offline'], [0x1, 'Paused'], [0x2, 'Error'], [0x8, 'Paper jam'], [0x10, 'Paper out'],
  [0x40, 'Paper problem'], [0x400000, 'Door open'], [0x100000, 'Needs attention'], [0x40000, 'No toner'],
  [0x20000, 'Toner low'], [0x400, 'Printing'], [0x4000, 'Processing'], [0x200, 'Busy'],
  [0x10000, 'Warming up'], [0x8000, 'Initializing'], [0x1000000, 'Power save'], [0x2000, 'Waiting']
];
export function checkPrinterStatus(codeOrStr) {
  if (codeOrStr == null || codeOrStr === '') return { status: 'Unknown', isOffline: false };
  if (typeof codeOrStr === 'string' && !/^\d+$/.test(codeOrStr)) {
    if (/offline/i.test(codeOrStr)) return { status: 'Offline', isOffline: true };
    if (/^(normal|ready|idle)$/i.test(codeOrStr)) return { status: 'Ready', isOffline: false };
    return { status: codeOrStr, isOffline: false };
  }
  const code = Number(codeOrStr);
  if (!Number.isInteger(code) || code === 0) return { status: 'Ready', isOffline: false };
  if (code & 0x80) return { status: 'Offline', isOffline: true };
  const label = STATUS_BITS.find(([bit]) => code & bit)?.[1];
  // Activity bits are a working printer; problem bits are reported but the spooler still queues.
  if (!label || /Printing|Processing|Busy|Warming|Initializing|Power save|Waiting|Toner low/.test(label)) return { status: 'Ready', isOffline: false, detail: label };
  return { status: label, isOffline: false };
}

const GENERIC_WORDS = new Set(['printer', 'printers', 'series', 'usb', 'wifi', 'wireless', 'network', 'copy', 'redirected', 'class', 'driver', 'pcl', 'pcl5', 'pcl6', 'ps', 'xl', 'gdi', 'universal', 'upd', 'the', 'and', 'on']);
function modelTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/hewlett[\s-]*packard/g, 'hp')
    .replace(/\((copy|redirected)\s*\d+\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(t => t && !GENERIC_WORDS.has(t) && !/^\d$/.test(t));
}

// Ranks installed printers against the configured name. Model numbers (tokens with a digit, such as
// "1020" or "t820dw") must all match; a brand-only name ("HP Printer") matches any printer of that brand.
function similarPrinters(targetName, list) {
  const target = modelTokens(targetName);
  if (!target.length) return [];
  const models = target.filter(t => /\d/.test(t));
  const words = models.length ? models : target;
  return list.filter(p => {
    const have = new Set([...modelTokens(p.Name), ...modelTokens(p.DriverName)]);
    return words.every(t => have.has(t) || [...have].some(h => h.length > 3 && t.length > 3 && (h.includes(t) || t.includes(h))));
  });
}

export function isPhysicalPrinter(p) {
  return Boolean(p?.Name) && !isVirtualPrinter({ name: p.Name, port: p.PortName, driver: p.DriverName });
}

// Prefers a printer that is online, then a USB cable, then the Windows default.
function bestOf(list) {
  const score = p => (checkPrinterStatus(p.PrinterStatus).isOffline ? 0 : 4) + (/^(USB|DOT4)/i.test(String(p.PortName || '')) ? 2 : 0) + (p.Default ? 1 : 0);
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

// Picks the Windows printer to print to. An exact name wins (switching to an online copy if it is
// offline). Otherwise a printer of the same model or brand, then the Windows default, then any real
// printer. Software printers (PDF, OneNote, PaperPort, AnyDesk, ...) are never picked as a fallback:
// a job sent there "succeeds" while no paper comes out.
export function pickPrinter(targetName, printerList = []) {
  const list = printerList.filter(p => p && p.Name);
  const exact = targetName && list.find(p => p.Name.toLowerCase() === String(targetName).toLowerCase());
  if (exact) {
    const res = resolveActivePrinter(exact.Name, list);
    return { name: res.name, switched: res.switched, reason: res.reason, status: res.status };
  }
  const physical = list.filter(isPhysicalPrinter);
  const similar = targetName ? similarPrinters(targetName, physical) : [];
  if (similar.length) {
    const chosen = bestOf(similar);
    return { name: chosen.Name, switched: true, status: checkPrinterStatus(chosen.PrinterStatus).status, reason: `Printer "${targetName}" is not installed under that exact name. Using matching Windows printer "${chosen.Name}".` };
  }
  const def = physical.find(p => p.Default);
  const chosen = def && !checkPrinterStatus(def.PrinterStatus).isOffline ? def : bestOf(physical);
  if (chosen) {
    return { name: chosen.Name, switched: true, status: checkPrinterStatus(chosen.PrinterStatus).status, reason: `${targetName ? `Printer "${targetName}" was not found.` : 'No printer configured.'} Using ${chosen === def ? 'the Windows default printer' : 'the connected printer'} "${chosen.Name}".` };
  }
  return { name: '', switched: false, status: 'Unknown', reason: 'No physical printer is installed in Windows.' };
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
  // Get-Printer has no Default property, so the Windows default printer comes from Win32_Printer.
  // PowerShell can take several seconds to start on a busy shop PC, so allow a generous timeout.
  const ps = [
    '$def = (Get-CimInstance -ClassName Win32_Printer -Filter "Default=TRUE" -ErrorAction SilentlyContinue | Select-Object -First 1).Name',
    '$list = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, PrinterStatus, PortName, DriverName, @{ n = "Default"; e = { $_.Name -eq $def } })',
    'ConvertTo-Json -Compress -InputObject $list'
  ].join('; ');
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000, windowsHide: true });
    if (!stdout || !stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(p => p && p.Name);
  } catch {
    return [];
  }
}

export async function printPdfToWindowsPrinter({ pdfPath, printerName, options = {}, sumatraPath = null }) {
  if (!existsSync(pdfPath)) {
    throw new Error(`Print file not found at ${pdfPath}`);
  }
  let targetPrinter = printerName || '';
  if (process.platform === 'win32') {
    const installed = await getWindowsPrinters();
    if (installed.length) {
      // Re-resolved for every job: a USB printer moved to another socket (common with the HP LaserJet
      // 1020/P1108) is reinstalled by Windows as "... (Copy 1)" on a new USB port.
      const resolution = pickPrinter(printerName, installed);
      if (!resolution.name) throw new Error(`${resolution.reason} Install the printer driver and print a Windows test page first.`);
      if (resolution.switched) console.log(`[Print Helper] ${resolution.reason}`);
      targetPrinter = resolution.name;
      if (resolution.status === 'Offline') {
        const port = installed.find(p => p.Name === targetPrinter)?.PortName;
        throw new Error(`Printer "${targetPrinter}" is Offline in Windows (Port: ${port || 'Unknown'}). Check the USB cable and power. If the cable was moved to another USB socket, open Printer properties > Ports and tick the active USB00x port.`);
      }
    }
  }

  if (!targetPrinter) throw new Error('No printer is installed in Windows. Install the printer driver and print a Windows test page first.');

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
      // Paths and printer names travel in environment variables, never inside the command text.
      const psCommand = 'Start-Process -FilePath $env:SMARTPRINT_PDF -Verb PrintTo -ArgumentList (\'"\' + $env:SMARTPRINT_TARGET + \'"\') -Wait -PassThru -WindowStyle Hidden';
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { timeout: 60000, windowsHide: true, env: { ...process.env, SMARTPRINT_PDF: pdfPath, SMARTPRINT_TARGET: targetPrinter } });
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
      const psCheck = 'ConvertTo-Json -Compress -InputObject @(Get-PrintJob -PrinterName $env:SMARTPRINT_TARGET -ErrorAction SilentlyContinue | Select-Object Id, DocumentName, @{ n = "JobStatus"; e = { [string]$_.JobStatus } })';
      const { stdout: jobOut } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCheck], { timeout: 10000, windowsHide: true, env: { ...process.env, SMARTPRINT_TARGET: targetPrinter } });
      if (jobOut && jobOut.trim()) {
        const jobs = JSON.parse(jobOut);
        const list = (Array.isArray(jobs) ? jobs : [jobs]).filter(Boolean);
        const fileName = pdfPath.split(/[\\/]/).pop().toLowerCase();
        const failing = j => j.JobStatus && /Error|Blocked|Offline/i.test(String(j.JobStatus));
        const ownJob = list.find(j => String(j.DocumentName || '').toLowerCase().includes(fileName));
        const stuck = list.find(j => j !== ownJob && failing(j));
        if (ownJob && failing(ownJob)) {
          throw new Error(`Printer "${targetPrinter}" reported spooler error: ${ownJob.JobStatus}`);
        }
        if (stuck) {
          // An older failed job at the head of the Windows queue blocks every job behind it.
          throw new Error(`Printer "${targetPrinter}" reported spooler error: an earlier Windows print job ("${stuck.DocumentName || stuck.Id}") is stuck with status ${stuck.JobStatus}. Clear the printer queue in Windows, then retry.`);
        }
      }
    } catch (spoolErr) {
      if (spoolErr.message.includes('reported spooler error')) throw spoolErr;
    }
  }

  return { method: printMethod, printer: targetPrinter };
}
