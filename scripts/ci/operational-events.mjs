import { spawn } from 'node:child_process';
import { fail } from './operational-policy.mjs';

export const EVENT_FORMAT = '{"type":{{json .Type}},"action":{{json .Action}},"id":{{json .Actor.ID}},"time":{{json (printf "%d" .TimeNano)}},"container":{{json (index .Actor.Attributes "container")}},"exitCode":{{json (index .Actor.Attributes "exitCode")}}}';

// Only the pinned CLI's uninterrupted Engine event stream feeds this object.
// Proc records, caller "reaped" flags and application stdout are not inputs.
export class LifecycleJournal {
  constructor(ids, volumes) {
    this.ids = ids; this.volumes = volumes; this.records = []; this.failure = null;
    this.waiters = new Set();
    this.expectedStops = new Set();
  }
  reject() {
    this.failure ??= 'INCOMPLETE';
    for (const waiter of this.waiters) waiter();
  }
  accept(record) {
    try {
      if (!record || Object.keys(record).sort().join(',') !== 'action,container,exitCode,id,time,type' ||
          !/^[0-9]{1,20}$/.test(record.time) ||
          ![record.container, record.exitCode].every(v => typeof v === 'string') ||
          this.records.length >= 128) fail();
      if (record.type === 'container') {
        if (!Object.values(this.ids).includes(record.id) ||
            !['start', 'die', 'destroy', 'oom', 'restart', 'pause', 'unpause', 'kill', 'stop'].includes(record.action)) fail();
        if (['oom', 'restart', 'pause', 'unpause'].includes(record.action)) fail();
        if (record.action === 'die' && !this.expectedStops.has(record.id)) fail();
        if (['start', 'die', 'destroy'].includes(record.action) &&
            this.records.some(r => r.type === record.type && r.id === record.id && r.action === record.action)) fail();
      } else if (record.type === 'volume') {
        if (!Object.values(this.volumes).includes(record.id) ||
            !['mount', 'unmount', 'destroy'].includes(record.action) ||
            (record.action !== 'destroy' && !Object.values(this.ids).includes(record.container))) fail();
      } else fail();
      this.records.push(Object.freeze({ ...record }));
      for (const waiter of this.waiters) waiter();
    } catch { this.reject(); }
  }
  expectStop(role) { this.expectedStops.add(this.ids[role]); }
  matches(type, id, action, container) {
    return this.records.filter(r => r.type === type && r.id === id && r.action === action &&
      (container === undefined || r.container === container));
  }
  holderContinuous() {
    const id = this.ids.collector;
    return !this.failure && this.matches('container', id, 'start').length === 1 &&
      !this.matches('container', id, 'die').length &&
      Object.values(this.volumes).every(volume =>
        this.matches('volume', volume, 'mount', id).length === 1 &&
        this.matches('volume', volume, 'unmount', id).length === 0 &&
        this.matches('volume', volume, 'destroy').length === 0);
  }
  exited(role, code) {
    const id = this.ids[role], starts = this.matches('container', id, 'start'), dies = this.matches('container', id, 'die');
    return !this.failure && starts.length === 1 && dies.length === 1 &&
      dies[0].exitCode === String(code) && BigInt(dies[0].time) >= BigInt(starts[0].time) &&
      Object.values(this.volumes).every(volume =>
        this.matches('volume', volume, 'mount', id).length === 1 &&
        this.matches('volume', volume, 'unmount', id).length === 1);
  }
  async until(predicate, deadline) {
    if (this.failure) fail(this.failure);
    if (predicate()) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('TIMEOUT')), Math.max(1, deadline - Date.now()));
      const done = error => {
        clearTimeout(timer); this.waiters.delete(check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (this.failure) done(new Error(this.failure));
        else if (predicate()) done();
      };
      this.waiters.add(check); check();
    });
  }
}
export function watchLifecycle({ executable, args, env, ledger, journal, deadline, spawnImpl = spawn }) {
  let buffer = '', stopping = false, closed = false, timer;
  const child = spawnImpl(executable, args, { env, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise(resolve => {
    child.once('error', () => { journal.reject(); });
    child.once('close', () => {
      closed = true; clearTimeout(timer);
      if (!stopping || buffer) journal.reject();
      resolve();
    });
  });
  const reject = () => { journal.reject(); child.kill('SIGKILL'); };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    if (!ledger.capture('S15', stream, bytes)) return reject();
    if (stopping) return;
    if (stream === 'stderr' && bytes.length) return reject();
    if (stream !== 'stdout') return;
    buffer += bytes.toString('utf8');
    if (Buffer.byteLength(buffer) > 65536) return reject();
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { journal.accept(JSON.parse(line)); } catch { reject(); }
      if (journal.failure) return reject();
    }
  });
  timer = setTimeout(reject, Math.max(1, deadline - Date.now()));
  return {
    assertLive() { if (closed || journal.failure) fail('INCOMPLETE'); },
    async stop() {
      stopping = true;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      try { await completion; } finally { clearTimeout(force); clearTimeout(timer); }
      if (journal.failure) fail('INCOMPLETE');
    },
  };
}
