// Only fixed vocabulary crosses the Worker/UI boundary. Never include fetch URLs,
// response bodies, signatures, session identifiers or user inputs in diagnostics.
type Source = 'timed' | 'legacy' | 'joint' | 'admission';
type Reason = 'network' | 'timeout' | 'expired' | 'changed' | 'clock' | 'invalid' | 'missing';
type Boundary = 'acquire' | 'client' | 'worker';
export class PreviewSourceError extends Error {
  constructor(readonly source: Source, readonly reason: Reason, readonly boundary: Boundary = 'acquire') {
    super(`forecast_unavailable:${boundary}:${source}:${reason}`);
  }
  get renewable() { return this.reason === 'network' || this.reason === 'expired' || this.reason === 'timeout'; }
  at(boundary: Boundary) { return new PreviewSourceError(this.source, this.reason, boundary); }
  static fromWire(text: string) {
    const m = /^forecast_unavailable:(acquire|client|worker):(timed|legacy|joint|admission):(network|timeout|expired|changed|clock|invalid|missing)$/.exec(text);
    return m ? new PreviewSourceError(m[2] as Source, m[3] as Reason, m[1] as Boundary) : null;
  }
}
