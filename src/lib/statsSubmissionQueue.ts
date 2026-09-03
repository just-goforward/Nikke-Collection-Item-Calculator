import type {
  DeliveryFailureClass,
  StatsDeliveryEventKind,
  StatsDeliveryHealth,
} from "../../shared/solverRecoveryContract";

export type StatsEventKind = StatsDeliveryEventKind;

export type StatsSubmissionEvent = Record<string, unknown> & {
  kind: StatsEventKind;
};

export interface StatsSubmissionEnvelope {
  eventId: string;
  clientTime?: string;
  sourceHost?: string;
  deliveryHealth?: StatsDeliveryHealth;
  event: StatsSubmissionEvent;
}

export class StatsSubmissionError extends Error {
  readonly retryable: boolean;
  declare readonly failureClass: DeliveryFailureClass;
  declare attempts: number;

  constructor(message: string, retryable = false, failureClass: DeliveryFailureClass = "unknown") {
    super(message);
    this.name = "StatsSubmissionError";
    this.retryable = retryable;
    if (__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
      this.failureClass = failureClass;
      this.attempts = 1;
    }
  }
}

type SubmitAttempt = (envelope: StatsSubmissionEnvelope) => Promise<void>;

export type StatsSubmissionResult = {
  attempts: number;
  lastFailureClass: DeliveryFailureClass | null;
};

function keepQueueAliveAfterFailure() {
  // The enqueue result still rejects; only the internal tail recovers so later events can run.
}

export class StatsSubmissionQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly submitAttempt: SubmitAttempt) {}

  enqueue(envelope: StatsSubmissionEnvelope): Promise<StatsSubmissionResult | undefined> {
    const result = this.tail.then(() => this.submitWithRetry(envelope));
    this.tail = result.then(() => undefined, keepQueueAliveAfterFailure);
    return result;
  }

  private async submitWithRetry(
    envelope: StatsSubmissionEnvelope,
  ): Promise<StatsSubmissionResult | undefined> {
    try {
      await this.submitAttempt(envelope);
      return __STATS_DELIVERY_HEALTH_EMIT_ENABLED__
        ? { attempts: 1, lastFailureClass: null }
        : undefined;
    } catch (error) {
      if (!(error instanceof StatsSubmissionError) || !error.retryable) throw error;
      try {
        await this.submitAttempt(envelope);
        return __STATS_DELIVERY_HEALTH_EMIT_ENABLED__
          ? { attempts: 2, lastFailureClass: error.failureClass }
          : undefined;
      } catch (retryError) {
        if (!__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) throw retryError;
        if (!(retryError instanceof StatsSubmissionError)) throw retryError;
        retryError.attempts = 2;
        throw retryError;
      }
    }
  }
}
