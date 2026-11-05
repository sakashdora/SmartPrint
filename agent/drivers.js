import { getWindowsPrinters, printPdfToWindowsPrinter, checkPrinterStatus, isPhysicalPrinter, listPrintJobs, ensureSumatraPDF } from '../connector/sumatra-helper.js';
import { probePrinterCapabilities, classifyConnection, guessCapabilities } from '../server/printer-capabilities.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Follows a job through the Windows queue and decides how it ended. Pure over `list` so it can be tested without a printer:
//   the job left the queue            -> completed (pages = the most Windows ever reported)
//   it shows an error/offline state for a long time or the wait ran out -> not completed; the pages seen so far are
//   reported so the server treats it as uncertain/partial instead of guessing.
export async function trackCompletion({ list, fileName, intervalMs = 3000, timeoutMs = 900000, errorLimitMs = 120000, sleepImpl = sleep }) {
  const started = Date.now(); let maxPages = 0, errorSince = null, seen = false;
  while (Date.now() - started < timeoutMs) {
    let jobs;
    try { jobs = await list(); } catch { await sleepImpl(intervalMs); continue; }
    const own = jobs.find(j => String(j.DocumentName || '').toLowerCase().includes(fileName.toLowerCase()));
    if (!own) return seen ? { outcome: 'completed', pages: maxPages || undefined } : { outcome: 'completed', pages: undefined };
    seen = true;
    maxPages = Math.max(maxPages, Number(own.PagesPrinted) || 0);
    if (/Error|Offline|Blocked|Paper|Intervention|Paused/i.test(String(own.JobStatus))) {
      errorSince ??= Date.now();
      if (Date.now() - errorSince > errorLimitMs) return { outcome: 'failed', pages: maxPages, error: `The printer reported a problem (${own.JobStatus}).`, nothingPrinted: false };
    } else errorSince = null;
    await sleepImpl(intervalMs);
  }
  return { outcome: 'failed', pages: maxPages, error: 'The job did not finish in time.', nothingPrinted: false };
}

// The real thing: Windows spooler through SumatraPDF (the same engine as the shop connector). Never used in tests.
export function windowsDriver({ sumatraPath = null } = {}) {
  return {
    async listPrinters() {
      const raw = (await getWindowsPrinters()).filter(isPhysicalPrinter);
      const capabilities = await probePrinterCapabilities(raw.map(p => p.Name));
      return raw.map(p => {
        const port = String(p.PortName || ''), { connectionType } = classifyConnection({ name: p.Name, port, driver: p.DriverName });
        const verified = capabilities.get(p.Name), guess = guessCapabilities(p.Name, p.DriverName);
        // Unknown must stay unknown: only driver-verified answers are reported as true or false.
        return { name: p.Name, color: verified ? verified.color : undefined, duplex: verified ? verified.duplex : undefined, connection: /wifi|network/i.test(connectionType) ? 'network' : 'usb', status: checkPrinterStatus(p.PrinterStatus).status, guessed: verified ? undefined : guess };
      });
    },
    async print({ printerName, pdfPath, options }) {
      const sumatra = sumatraPath || await ensureSumatraPDF();
      try { await printPdfToWindowsPrinter({ pdfPath, printerName, options, sumatraPath: sumatra }); }
      catch (error) { return { outcome: 'failed', error: error.message, nothingPrinted: true }; } // the helper removes a job the printer never took
      const fileName = pdfPath.split(/[\\/]/).pop();
      return trackCompletion({ list: () => listPrintJobs(printerName), fileName });
    }
  };
}

// For tests and dry runs: "prints" by recording the job. Behaviour can be scripted.
export function simulatedDriver({ printers = [{ name: 'Simulated Mono', color: false, duplex: false, status: 'Ready' }], onPrint = null } = {}) {
  const printed = [];
  return {
    printed,
    async listPrinters() { return printers; },
    async print(job) {
      printed.push({ printerName: job.printerName, options: job.options });
      if (onPrint) return onPrint(job, printed.length);
      return { outcome: 'completed', pages: job.jobPages };
    }
  };
}
