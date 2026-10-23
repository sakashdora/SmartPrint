import { connect } from 'node:net';
export function scan(bytes) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: process.env.CLAMAV_HOST || 'clamav', port: 3310 });
    let output = '';
    socket.setTimeout(60000, () => socket.destroy(new Error('Malware scan timed out.')));
    socket.on('error', () => reject(new Error('Malware scanner unavailable. Upload was not accepted.')));
    socket.on('data', data => { output += data.toString(); if (output.length > 4096) socket.destroy(); if (output.includes('\0')) { socket.end(); if (output.includes(' FOUND')) reject(new Error('Unsafe file detected. Upload was rejected.')); else if (/^stream: OK\0/.test(output)) resolve(); else reject(new Error('Unable to verify file safety.')); } });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); socket.write(size); socket.write(bytes); socket.write(Buffer.alloc(4));
    });
    socket.on('end', () => { if (!output.includes('\0')) reject(new Error('Incomplete malware scan.')); });
  });
}
