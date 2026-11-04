import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Asks each Windows printer driver whether it can print colour and duplex (DeviceCapabilities via
// System.Drawing.Printing.PrinterSettings). Names travel through an environment variable, never the
// command text. Printers the driver cannot describe are left out: callers must treat them as unknown.
// Colour comes from the driver's PrintCapabilities (System.Printing) where available: the older
// DeviceCapabilities answer claims colour for mono drivers such as the HP LaserJet 1020.
const script = [
  'Add-Type -AssemblyName System.Drawing',
  'try { Add-Type -AssemblyName System.Printing; $srv = New-Object System.Printing.LocalPrintServer } catch { $srv = $null }',
  '$names = $env:SMARTPRINT_PRINTER_NAMES | ConvertFrom-Json',
  '$out = @(foreach ($n in $names) { $s = New-Object System.Drawing.Printing.PrinterSettings; $s.PrinterName = [string]$n;',
  'if ($s.IsValid) { $color = [bool]$s.SupportsColor; $duplex = [bool]$s.CanDuplex;',
  'if ($srv) { try { $c = $srv.GetPrintQueue([string]$n).GetPrintCapabilities(); $color = @($c.OutputColorCapability | Where-Object { "$_" -eq "Color" }).Count -gt 0;',
  '$duplex = $duplex -and (@($c.DuplexingCapability | Where-Object { "$_" -like "TwoSided*" }).Count -gt 0) } catch {} }',
  '$driver = [string](Get-Printer -Name ([string]$n) -ErrorAction SilentlyContinue).DriverName;',
  '[pscustomobject]@{ name = [string]$n; driver = $driver; color = $color; duplex = $duplex } } })',
  'ConvertTo-Json -Compress -InputObject $out'
].join('\n');

// Software printers that accept a job but never put paper out. Picking one of these as the fallback
// printer makes jobs "print" successfully while nothing comes out.
const VIRTUAL_NAME = /OneNote|Fax|XPS|PDF|PaperPort|Image Printer|AnyDesk|TeamViewer|Snagit|Send To|CutePDF|doPDF|novaPDF|Bullzip|PDFCreator|Foxit|Nitro|Print to|Document Writer|ePrint/i;
const VIRTUAL_PORT = /^(nul:?|PORTPROMPT:|FILE:|XPSPort:|SHRFAX:|PDF.*|.*Writer Port.*|AnyDesk.*)$/i;
export function isVirtualPrinter({ name = '', port = '', driver = '' } = {}) {
  return VIRTUAL_NAME.test(name) || VIRTUAL_NAME.test(driver) || VIRTUAL_PORT.test(String(port).trim());
}

// Port naming used by Windows and the vendor port monitors (HP, Brother, Canon, Epson).
export function classifyConnection({ name = '', port = '', driver = '' } = {}) {
  const p = String(port).trim();
  if (isVirtualPrinter({ name, port: p, driver })) return { connectionType: 'Virtual / PDF', isWifi: false, isWired: false };
  if (/^(USB|DOT4|LPT|COM)\d*/i.test(p) || /^HPUSB|usb/i.test(p) || /\busb\b/i.test(name)) return { connectionType: 'Wired USB Cable', isWifi: false, isWired: true };
  if (/^(WSD|TCP|IP_|NPI|HP[0-9A-F]{6}|BRN|BRW|CNB|EP[0-9A-F]{6})/i.test(p) || /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(p) || /^https?:/i.test(p) || /wifi|wireless|network/i.test(name)) {
    return { connectionType: 'WiFi / Wireless Network', isWifi: true, isWired: false };
  }
  return { connectionType: 'Local Spooler', isWifi: false, isWired: false };
}

// Display-only guess from the model name, used until the driver is probed. It errs on "no": a mono
// laser such as the HP LaserJet 1020 must never be advertised as colour or two-sided.
export function guessCapabilities(name = '', driver = '') {
  const text = `${name} ${driver}`;
  const mono = /mono|black|\bB&?W\b/i.test(text) || (/laser|LBP|HL-|\bML-|SCX|imageCLASS/i.test(text) && !/colou?r|\bCP\d|\bCM\d|\bM[2-4]5\d|\bM[2-4]8\d|\bM47\d|\bMFC-L3|\bHL-L3|\bDCP-L3/i.test(text));
  const color = !mono && /colou?r|DeskJet|OfficeJet|ENVY|Ink ?Tank|Smart ?Tank|PIXMA|MAXIFY|EcoTank|Epson|Photo|\bDCP-T|\bMFC-T|\bDCP-J|\bMFC-J|\bG\d{4}\b|\bL\d{3,4}\b/i.test(text);
  const duplex = /duplex/i.test(text) || /\d+[a-z]*d[nw]?\b/i.test(name);
  return { color, duplex };
}

export async function probePrinterCapabilities(names) {
  const list = [...new Set((Array.isArray(names) ? names : [names]).map(n => String(n ?? '').trim()).filter(Boolean))].slice(0, 50);
  const result = new Map();
  if (process.platform !== 'win32' || !list.length) return result;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, SMARTPRINT_PRINTER_NAMES: JSON.stringify(list) }
    });
    const parsed = JSON.parse(stdout.trim() || '[]');
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && typeof item.name === 'string' && typeof item.color === 'boolean' && typeof item.duplex === 'boolean') {
        // Drivers of simplex lasers (HP LaserJet 1020, P1108, M1005 ...) advertise *manual* duplex, which
        // needs someone to turn the paper over. Only an automatic-duplex model counts as two-sided.
        const automaticDuplex = guessCapabilities(item.name).duplex || guessCapabilities(String(item.driver || '')).duplex;
        result.set(item.name, { color: item.color, duplex: item.duplex && automaticDuplex });
      }
    }
  } catch {}
  return result;
}
