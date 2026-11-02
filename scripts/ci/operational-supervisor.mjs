import { spawn } from 'node:child_process';
import { CaptureLedger } from './operational-results.mjs';
import { assertSealed, fail } from './operational-policy.mjs';

// All bytes are consumed, counted and discarded unless a bounded structured
// response is explicitly requested. This also covers spawn failures.
export class CapturedTransport {
  constructor({ ledger = new CaptureLedger(), spawnImpl = spawn, deadlineMs,
    cleanupReserveMs = 120000 } = {}) {
    this.ledger = ledger;
    this.spawnImpl = spawnImpl;
    this.deadlineMs = deadlineMs;
    this.cleanupReserveMs = cleanupReserveMs;
    this.started = new Set();
  }
  async run(id, executable, args, { cwd, env, durationMs = 60000, signal,
    responseLimit = 0, cleanup = false, terminate = async () => {}, failureCode = 'TEST_FAILED',
    failureCodes = {} } = {}) {
    if (!this.started.has(id)) { this.ledger.begin(id); this.started.add(id); }
    const remaining = Math.min(durationMs, this.deadlineMs - Date.now() -
      (cleanup ? 0 : this.cleanupReserveMs));
    if (signal?.aborted || remaining <= 0) {
      this.ledger.reject(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
      fail(this.ledger.failure);
    }
    return new Promise((resolve, reject) => {
      let child, reason, size = 0, chunks = [], settled = false, stopping;
      const stop = code => {
        reason ??= code;
        this.ledger.reject(code);
        if (!stopping) stopping = Promise.resolve().then(terminate).catch(() => {
          this.ledger.reject('INCOMPLETE');
        }).finally(() => { child?.kill('SIGKILL'); });
      };
      const cancel = () => stop('CANCELLED');
      const timer = setTimeout(() => stop('TIMEOUT'), remaining);
      signal?.addEventListener('abort', cancel, { once: true });
      const finish = async (code, killedSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        await stopping;
        if (code !== 0 || killedSignal) reason ??= failureCodes[code] ?? failureCode;
        if (reason) { this.ledger.reject(reason); reject(new Error(reason)); }
        else resolve(Buffer.concat(chunks, size));
      };
      try {
        child = this.spawnImpl(executable, args, {
          cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        for (const stream of ['stdout', 'stderr']) {
          child[stream].on('data', bytes => {
            if (!this.ledger.capture(id, stream, bytes)) stop('OVERFLOW');
            if (stream === 'stdout' && responseLimit) {
              size += bytes.length;
              if (size > responseLimit) { chunks = []; stop('OVERFLOW'); }
              else if (!reason) chunks.push(bytes);
            }
          });
        }
        child.once('error', () => { reason ??= 'INCOMPLETE'; });
        child.once('close', (code, killedSignal) => { void finish(code, killedSignal); });
      } catch { reason = 'INCOMPLETE'; void finish(null, null); }
    });
  }
}

export class Supervisor {
  #ledger = new CaptureLedger();
  #deadline;
  #cleanup;
  #adapter;
  #ids = new Set();
  #closing;
  #transport;
  constructor({ approvedStageIds, deadlineMs, cleanupReserveMs, adapter, spawnImpl }) {
    if (!Array.isArray(approvedStageIds) || !approvedStageIds.length ||
        approvedStageIds.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id)) ||
        new Set(approvedStageIds).size !== approvedStageIds.length ||
        !Number.isSafeInteger(deadlineMs) || !Number.isSafeInteger(cleanupReserveMs) ||
        cleanupReserveMs <= 0 || deadlineMs <= Date.now() + cleanupReserveMs ||
        !['stop', 'kill', 'remove', 'absent'].every(k => typeof adapter?.[k] === 'function')) {
      throw new Error('ADMISSION_BLOCKED');
    }
    this.#ids = new Set(approvedStageIds);
    this.#deadline = deadlineMs;
    this.#cleanup = cleanupReserveMs;
    this.#adapter = adapter;
    this.#transport = new CapturedTransport({ ledger: this.#ledger, deadlineMs,
      cleanupReserveMs, spawnImpl });
  }
  get failure() { return this.#ledger.failure; }
  reject(code) { return this.#ledger.reject(code); }
  async stage(command, { cwd, env, signal }) {
    assertSealed(command);
    const { id, executable, args, durationMs } = command;
    if (this.#closing || !this.#ids.delete(id) || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new Error('ADMISSION_BLOCKED');
    }
    try {
      if (this.failure) fail(this.failure);
      await this.#transport.run(id, executable, args, { cwd, env, durationMs, signal,
        terminate: () => this.close() });
    } catch (error) {
      this.reject(['TIMEOUT', 'OVERFLOW', 'CANCELLED', 'TEST_FAILED'].includes(error.message)
        ? error.message : 'INCOMPLETE');
      await this.close();
    }
    return !this.failure;
  }
  async close() {
    this.#closing ??= this.#close();
    return this.#closing;
  }
  async #close() {
    const bounded = operation => {
      let timer;
      return Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('INCOMPLETE')),
          Math.max(1, Math.min(10000, this.#deadline - Date.now()))); })
      ]).finally(() => clearTimeout(timer));
    };
    try { await bounded(() => this.#adapter.stop()); } catch { this.reject('INCOMPLETE'); }
    try { await bounded(() => this.#adapter.kill()); } catch { this.reject('INCOMPLETE'); }
    try {
      await bounded(() => this.#adapter.remove());
      if (await bounded(() => this.#adapter.absent()) !== true) this.reject('INCOMPLETE');
    } catch { this.reject('INCOMPLETE'); }
  }
}
