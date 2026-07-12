export type StatsEventKind = "kit_result" | "solver_diagnostic" | "solver_recovery";

export type StatsSubmissionEvent = Record<string, unknown> & {
  kind: StatsEventKind;
};

export interface StatsSubmissionEnvelope {
  eventId: string;
  clientTime: string;
  sourceHost: string;
  event: StatsSubmissionEvent;
}

export class StatsSubmissionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "StatsSubmissionError";
    this.retryable = retryable;
  }
}

type SubmitAttempt = (envelope: StatsSubmissionEnvelope) => Promise<void>;

function keepQueueAliveAfterFailure() {
  // The enqueue result still rejects; only the internal tail recovers so later events can run.
}

export class StatsSubmissionQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly submitAttempt: SubmitAttempt) {}

  enqueue(envelope: StatsSubmissionEnvelope): Promise<void> {
    const result = this.tail.then(() => this.submitWithRetry(envelope));
    this.tail = result.catch(keepQueueAliveAfterFailure);
    return result;
  }

  private async submitWithRetry(envelope: StatsSubmissionEnvelope): Promise<void> {
    try {
      await this.submitAttempt(envelope);
    } catch (error) {
      if (!(error instanceof StatsSubmissionError) || !error.retryable) throw error;
      await this.submitAttempt(envelope);
    }
  }
}
