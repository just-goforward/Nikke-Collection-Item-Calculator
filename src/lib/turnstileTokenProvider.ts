import type { StatsEventKind } from "./statsSubmissionQueue";

export interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

type LoadTurnstile = () => Promise<TurnstileApi>;
type CreateContainer = (kind: StatsEventKind) => HTMLElement;

type PendingToken = {
  kind: StatsEventKind;
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class TurnstileTokenProvider {
  private api: TurnstileApi | null = null;
  private pending: PendingToken | null = null;
  private disposed = false;
  private readonly widgetIds = new Map<StatsEventKind, string>();

  constructor(
    private readonly siteKey: string,
    private readonly loadTurnstile: LoadTurnstile,
    private readonly createContainer: CreateContainer,
    private readonly timeoutMs = 12_000,
  ) {}

  async issueToken(kind: StatsEventKind): Promise<string> {
    if (this.disposed) throw new Error("Turnstile token provider was disposed.");
    if (this.pending) throw new Error("A Turnstile token request is already pending.");
    const api = await this.getApi();
    if (this.disposed) throw new Error("Turnstile token provider was disposed.");
    const widgetId = this.ensureWidget(api, kind);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(kind, new Error("Turnstile timed out."));
      }, this.timeoutMs);
      this.pending = { kind, resolve, reject, timer };
      api.execute(widgetId);
    });
  }

  reset(kind: StatsEventKind): void {
    const widgetId = this.widgetIds.get(kind);
    if (widgetId && this.api) this.api.reset(widgetId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Turnstile submission was disposed."));
      this.pending = null;
    }
    if (this.api) {
      for (const widgetId of this.widgetIds.values()) this.api.remove(widgetId);
    }
    this.widgetIds.clear();
  }

  private async getApi(): Promise<TurnstileApi> {
    if (!this.api) this.api = await this.loadTurnstile();
    return this.api;
  }

  private ensureWidget(api: TurnstileApi, kind: StatsEventKind): string {
    const existing = this.widgetIds.get(kind);
    if (existing) return existing;
    const widgetId = api.render(this.createContainer(kind), {
      sitekey: this.siteKey,
      size: "invisible",
      action: kind,
      execution: "execute",
      callback: (token: string) => this.resolvePending(kind, token),
      "error-callback": () => this.rejectPending(kind, new Error("Turnstile challenge failed.")),
      "expired-callback": () => this.rejectPending(kind, new Error("Turnstile token expired.")),
      "timeout-callback": () =>
        this.rejectPending(kind, new Error("Turnstile challenge timed out.")),
    });
    this.widgetIds.set(kind, widgetId);
    return widgetId;
  }

  private resolvePending(kind: StatsEventKind, token: string): void {
    if (!this.pending || this.pending.kind !== kind) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(token);
  }

  private rejectPending(kind: StatsEventKind, error: Error): void {
    if (!this.pending || this.pending.kind !== kind) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}
