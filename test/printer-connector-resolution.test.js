import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActivePrinter, checkPrinterStatus } from '../connector/sumatra-helper.js';

test('Printer resolution: identifies offline vs online printers and resolves active USB counterpart', () => {
  const mockPrinters = [
    {
      Name: 'Brother DCP-T820DW Printer',
      PrinterStatus: 128, // Offline
      PortName: 'WSD-c6dcd302-c0fa-4d03-af52-f05f2ff7fc8f',
      DriverName: 'Brother DCP-T820DW Printer',
      Default: false
    },
    {
      Name: 'Brother DCP-T820DW Printer (Copy 1) USB',
      PrinterStatus: 0, // Normal / Ready
      PortName: 'USB001',
      DriverName: 'Brother DCP-T820DW Printer',
      Default: true
    },
    {
      Name: 'Microsoft Print to PDF',
      PrinterStatus: 0,
      PortName: 'PORTPROMPT:',
      DriverName: 'Microsoft Print To PDF',
      Default: false
    }
  ];

  // 1. If configured printer is the offline WSD printer, it should automatically resolve to the online USB counterpart
  const resolved = resolveActivePrinter('Brother DCP-T820DW Printer', mockPrinters);
  assert.equal(resolved.name, 'Brother DCP-T820DW Printer (Copy 1) USB');
  assert.equal(resolved.status, 'Ready');
  assert.equal(resolved.switched, true);
  assert.match(resolved.reason, /offline/i);

  // 2. If configured printer is already online, keep it
  const alreadyOnline = resolveActivePrinter('Brother DCP-T820DW Printer (Copy 1) USB', mockPrinters);
  assert.equal(alreadyOnline.name, 'Brother DCP-T820DW Printer (Copy 1) USB');
  assert.equal(alreadyOnline.switched, false);

  // 3. If configured printer is offline and has NO counterpart, report offline with error
  const soloOffline = [
    { Name: 'Canon G2020', PrinterStatus: 128, PortName: 'USB002', DriverName: 'Canon G2020' }
  ];
  const unresolved = resolveActivePrinter('Canon G2020', soloOffline);
  assert.equal(unresolved.name, 'Canon G2020');
  assert.equal(unresolved.status, 'Offline');
  assert.equal(unresolved.switched, false);
});

test('checkPrinterStatus accurately identifies Windows spooler status codes', () => {
  assert.equal(checkPrinterStatus(0).status, 'Ready');
  assert.equal(checkPrinterStatus(128).status, 'Offline');
  assert.equal(checkPrinterStatus('Normal').status, 'Ready');
  assert.equal(checkPrinterStatus('Offline').status, 'Offline');
  assert.equal(checkPrinterStatus(null).status, 'Unknown');
});
