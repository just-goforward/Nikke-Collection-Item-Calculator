import { request } from 'node:http';
import { HEX, fail } from './operational-policy.mjs';

// Unlike CLI `docker wait`, retain and reject the Engine WaitResponse.Error.
// The address/method/API version are fixed host-control operations, never
// selected by report data. No Docker socket is mounted into either container.
export function waitForContainerExit({ id, ledger, deadline, requestImpl = request }) {
  if (!HEX.test(id ?? '') || !Number.isSafeInteger(deadline) || deadline <= Date.now()) fail('ADMISSION_BLOCKED');
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(code);
    };
    const req = requestImpl({
      socketPath: '/var/run/docker.sock', method: 'POST', maxHeaderSize: 4096,
      path: `/v1.48/containers/${id}/wait?condition=not-running`,
      headers: { 'Content-Length': '0' }, agent: false,
    }, response => {
      if (response.statusCode !== 200) {
        finish(new Error('INCOMPLETE')); response.destroy(); return;
      }
      response.on('data', bytes => {
        size += bytes.length;
        if (!ledger.capture('S15', 'stdout', bytes) || size > 8192) {
          chunks = []; finish(new Error('OVERFLOW')); response.destroy(); req.destroy();
        } else chunks.push(bytes);
      });
      response.once('aborted', () => finish(new Error('INCOMPLETE')));
      response.once('error', () => finish(new Error('INCOMPLETE')));
      response.once('end', () => {
        try {
          const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!result || !Number.isInteger(result.StatusCode) || result.StatusCode < 0 || result.StatusCode > 255 ||
              Object.keys(result).some(key => !['StatusCode', 'Error'].includes(key)) ||
              (result.Error !== undefined && result.Error !== null)) fail('INCOMPLETE');
          finish(null, result.StatusCode);
        } catch { finish(new Error('INCOMPLETE')); }
      });
    });
    const timer = setTimeout(() => { finish(new Error('TIMEOUT')); req.destroy(); },
      Math.max(1, Math.min(30000, deadline - Date.now())));
    req.once('error', () => finish(new Error('INCOMPLETE')));
    req.end();
  });
}
