import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Asks each Windows printer driver whether it can print colour, duplex, paper sizes, and resolution
// (DeviceCapabilities via System.Drawing.Printing.PrinterSettings + System.Printing). Names travel through
// an environment variable, never the command text. Printers the driver cannot describe are left out:
// callers must treat them as unknown.
const script = [
  'Add-Type -AssemblyName System.Drawing',
  'try { Add-Type -AssemblyName System.Printing; $srv = New-Object System.Printing.LocalPrintServer } catch { $srv = $null }',
  '$names = $env:SMARTPRINT_PRINTER_NAMES | ConvertFrom-Json',
  '$out = @(foreach ($n in $names) { try { $s = New-Object System.Drawing.Printing.PrinterSettings; $s.PrinterName = [string]$n;',
  'if ($s.IsValid) { $color = [bool]$s.SupportsColor; $duplex = [bool]$s.CanDuplex;',
  '$papers = @($s.PaperSizes | ForEach-Object { $_.PaperName } | Where-Object { $_ } | Select-Object -Unique | Select-Object -First 20);',
  '$dpi = 0; try { $dpi = ($s.PrinterResolutions | ForEach-Object { [Math]::Max($_.X, $_.Y) } | Measure-Object -Maximum).Maximum } catch {};',
  'if ($srv) { try { $c = $srv.GetPrintQueue([string]$n).GetPrintCapabilities(); $color = @($c.OutputColorCapability | Where-Object { "$_" -eq "Color" }).Count -gt 0;',
  '$duplex = $duplex -and (@($c.DuplexingCapability | Where-Object { "$_" -like "TwoSided*" }).Count -gt 0) } catch {} }',
  '$driver = [string](Get-Printer -Name ([string]$n) -ErrorAction SilentlyContinue).DriverName;',
  '[pscustomobject]@{ name = [string]$n; driver = $driver; color = $color; duplex = $duplex; paperSizes = $papers; maxDpi = [int]$dpi } } } catch {} })',
  'ConvertTo-Json -Compress -InputObject $out'
].join('\n');

// Software printers that accept a job but never put paper out. Picking one of these as the fallback
// printer makes jobs "print" successfully while nothing comes out.
const VIRTUAL_NAME = /OneNote|Fax|XPS|PDF|PaperPort|Image Printer|AnyDesk|TeamViewer|Snagit|Send To|CutePDF|doPDF|novaPDF|Bullzip|PDFCreator|Foxit|Nitro|Print to|Document Writer|ePrint/i;
const VIRTUAL_PORT = /^(nul:?|PORTPROMPT:|FILE:|XPSPort:|SHRFAX:|PDF.*|.*Writer Port.*|AnyDesk.*)$/i;
export function isVirtualPrinter({ name = '', port = '', driver = '' } = {}) {
  return VIRTUAL_NAME.test(name) || VIRTUAL_NAME.test(driver) || VIRTUAL_PORT.test(String(port).trim());
}

const KNOWN_BRANDS = [
  ['Hewlett-Packard', /\b(?:HP|Hewlett[\s-]*Packard)\b/i, 'HP'],
  ['Brother', /\bBrother\b/i, 'Brother'],
  ['Canon', /\bCanon\b/i, 'Canon'],
  ['Epson', /\bEpson\b/i, 'Epson'],
  ['Samsung', /\bSamsung\b/i, 'Samsung'],
  ['Xerox', /\bXerox\b/i, 'Xerox'],
  ['Ricoh', /\bRicoh\b/i, 'Ricoh'],
  ['Kyocera', /\bKyocera\b/i, 'Kyocera'],
  ['Konica Minolta', /\bKonica\s*Minolta\b/i, 'Konica Minolta'],
  ['Lexmark', /\bLexmark\b/i, 'Lexmark'],
  ['Pantum', /\bPantum\b/i, 'Pantum'],
  ['Toshiba', /\bToshiba\b/i, 'Toshiba'],
  ['Microsoft', /\bMicrosoft\b/i, 'Microsoft'],
  ['Adobe', /\bAdobe\b/i, 'Adobe']
];

export function extractManufacturerModel(name = '', driver = '') {
  const source = String(driver || name || '').trim() || String(name || '').trim();
  let manufacturer = '';
  for (const [label, regex] of KNOWN_BRANDS) {
    if (regex.test(source) || regex.test(name)) {
      manufacturer = label === 'Hewlett-Packard' ? 'HP' : label;
      break;
    }
  }
  let model = source
    .replace(/\((?:copy|redirected)\s*\d+\)/gi, '')
    .replace(/\b(?:PCL\s*6|PCL\s*5e?|PS|PostScript|XPS|Class Driver|Universal Print Driver|UPD|V3|V4|Series|Printer)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (manufacturer && model.toLowerCase().startsWith(manufacturer.toLowerCase())) {
    model = model.slice(manufacturer.length).trim();
  }
  return { manufacturer: manufacturer || null, model: model || source || null };
}

// Port naming used by Windows and the vendor port monitors (HP, Brother, Canon, Epson).
export function classifyConnection({ name = '', port = '', driver = '', shared = false, type = '', portHost = '' } = {}) {
  const p = String(port || '').trim();
  if (isVirtualPrinter({ name, port: p, driver })) {
    return { connectionType: 'Virtual / PDF', connectionCode: 'virtual', isWifi: false, isWired: false, isNetwork: false, isShared: false, isVirtual: true };
  }
  if (shared || /^\\\\/.test(name) || /^\\\\/.test(p) || /connection/i.test(String(type))) {
    return { connectionType: 'Shared Network', connectionCode: 'shared', isWifi: true, isWired: false, isNetwork: true, isShared: true, isVirtual: false };
  }
  if (/^(USB|DOT4|LPT|COM)\d*/i.test(p) || /^HPUSB|usb/i.test(p) || /\busb\b/i.test(name)) {
    return { connectionType: 'USB', connectionCode: 'usb', isWifi: false, isWired: true, isNetwork: false, isShared: false, isVirtual: false };
  }
  if (/^(IP_|TCP|Standard TCP)/i.test(p) || /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(p) || Boolean(portHost) || /^https?:/i.test(p)) {
    return { connectionType: 'TCP/IP', connectionCode: 'tcpip', isWifi: true, isWired: false, isNetwork: true, isShared: false, isVirtual: false };
  }
  if (/^(WSD|BRW|EP[0-9A-F]{6})/i.test(p) || /wifi|wireless|wlan/i.test(`${name} ${p}`)) {
    return { connectionType: 'Wi-Fi', connectionCode: 'wifi', isWifi: true, isWired: false, isNetwork: true, isShared: false, isVirtual: false };
  }
  if (/^(NPI|HP[0-9A-F]{6}|BRN|CNB)/i.test(p) || /ethernet|\blan\b|network/i.test(`${name} ${p}`)) {
    return { connectionType: 'Ethernet / LAN', connectionCode: 'ethernet', isWifi: true, isWired: false, isNetwork: true, isShared: false, isVirtual: false };
  }
  return { connectionType: 'Local Spooler', connectionCode: 'other', isWifi: false, isWired: false, isNetwork: false, isShared: false, isVirtual: false };
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
        const paperSizes = Array.isArray(item.paperSizes) ? item.paperSizes.map(p => String(p).trim()).filter(Boolean).slice(0, 20) : [];
        const resolution = Number.isFinite(Number(item.maxDpi)) && Number(item.maxDpi) > 0 ? Number(item.maxDpi) : null;
        result.set(item.name, { color: item.color, duplex: item.duplex && automaticDuplex, paperSizes, resolution });
      }
    }
  } catch {}
  return result;
}
