import type { PreviewInvalidation, PreviewReader } from '../lib/previewCalendar';

export type PublicationView<T> =
  | { status: 'checking' | 'unavailable'; value: null }
  | { status: 'current' | 'updating'; value: T };

/** Browsing only. Keep one complete projection, never input to a calculation. */
export function watchPreviewPublication<T>(load: () => Promise<PreviewReader<T>>, show: (view: PublicationView<T>) => void) {
  let disposed = false, poll = 0, active: AbortController | null = null;
  let read: PreviewReader<T> | undefined, release: (() => void) | undefined;
  let view: PublicationView<T> = { status: 'checking', value: null };
  let retriedAdvance = false;
  const publish = (next: PublicationView<T>) => { view = next; show(next); };
  const updating = () => {
    if (view.status === 'current') publish({ status: 'updating', value: view.value });
  };
  const withdraw = () => {
    release?.(); release = undefined;
    if (view.status !== 'unavailable') publish({ status: 'unavailable', value: null });
  };
  const visible = () => document.visibilityState === 'visible';
  const schedule = (delay: number) => {
    window.clearTimeout(poll);
    if (!disposed && visible()) poll = window.setTimeout(refresh, delay);
  };
  const refresh = async () => {
    if (disposed || active || !visible()) return;
    const controller = active = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    let delay = 15_000;
    updating();
    try {
      if (!read) {
        const loaded = await load();
        if (controller !== active) return;
        read = loaded;
      }
      controller.signal.throwIfAborted();
      const { calendar, ttl, observe } = await read(controller.signal);
      if (controller !== active) return;
      controller.signal.throwIfAborted();
      if (ttl <= 0) {
        // A receipt phase can end while the reader builds the projection.
        withdraw();
        if (!retriedAdvance) { retriedAdvance = true; delay = 0; }
        return;
      }

      // subscribe() may synchronously report that B was superseded while it
      // was being verified. Never commit B until registration also succeeds.
      let registering = true, listening = false, duringRegistration: PreviewInvalidation | undefined;
      const invalidate = (reason: PreviewInvalidation) => {
        if (registering) {
          if (duringRegistration !== 'unavailable') duringRegistration = reason;
          return;
        }
        if (!listening) return;
        if (reason === 'superseded') {
          if (view.status === 'updating') return;
          updating();
        } else withdraw();
        if (!active) schedule(0);
      };
      const unsubscribe = observe?.(invalidate);
      registering = false;
      if (duringRegistration) {
        unsubscribe?.();
        if (duringRegistration === 'superseded') throw new Error('preview_source_advanced');
        withdraw(); return;
      }
      const expiry = window.setTimeout(() => invalidate('unavailable'), ttl);
      const detach = () => { listening = false; window.clearTimeout(expiry); unsubscribe?.(); };
      release?.();
      release = detach;
      listening = true;
      retriedAdvance = false;
      publish({ status: 'current', value: calendar });
      delay = observe ? Math.min(ttl, Math.max(5000, ttl - 5000)) : Math.max(5000, Math.min(45_000, ttl - 5000));
    } catch (error) {
      if (controller === active) {
        // An authenticated version/slot race gets one fresh acquisition. Do
        // not treat invalid bytes, revoked grants or failed reads as turnover.
        const advanced = error instanceof Error && error.message === 'preview_source_advanced';
        if (!controller.signal.aborted && advanced && !retriedAdvance) {
          retriedAdvance = true; updating(); delay = 0;
        } else {
          retriedAdvance = false; withdraw();
        }
      }
    } finally {
      window.clearTimeout(timeout);
      if (controller === active) { active = null; schedule(delay); }
    }
  };
  const stopRead = () => {
    window.clearTimeout(poll);
    release?.(); release = undefined;
    active?.abort(); active = null;
    retriedAdvance = false;
  };
  const visibility = () => {
    stopRead();
    publish({ status: visible() ? 'checking' : 'unavailable', value: null });
    void refresh();
  };
  document.addEventListener('visibilitychange', visibility);
  void refresh();
  return () => { disposed = true; stopRead(); document.removeEventListener('visibilitychange', visibility); };
}
