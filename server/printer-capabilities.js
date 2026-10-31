import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Asks each Windows printer driver whether it can print colour and duplex (DeviceCapabilities via
// System.Drawing.Printing.PrinterSettings). Names travel through an environment variable, never the
// command text. Printers the driver cannot describe are left out: callers must treat them as unknown.
const script = [
  'Add-Type -AssemblyName System.Drawing',
  '$names = $env:SMARTPRINT_PRINTER_NAMES | ConvertFrom-Json',
  '$out = @(foreach ($n in $names) { $s = New-Object System.Drawing.Printing.PrinterSettings; $s.PrinterName = [string]$n;',
  'if ($s.IsValid) { [pscustomobject]@{ name = [string]$n; color = [bool]$s.SupportsColor; duplex = [bool]$s.CanDuplex } } })',
  'ConvertTo-Json -Compress -InputObject $out'
].join('\n');

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
        result.set(item.name, { color: item.color, duplex: item.duplex });
      }
    }
  } catch {}
  return result;
}
