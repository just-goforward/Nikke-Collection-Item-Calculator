import {
  EPISODE_TTL_MS, MEMORY_RETRY, parseDecisionEnvelope, DECISION_ANALYTICS_VERSION,
} from "../../shared/decisionAnalyticsV3.ts";
import type {
  DecisionEvent, DecisionResponse, Stage, StageData,
} from "../../shared/decisionAnalyticsV3.ts";

// Activation is deliberately independent of legacy statistics and account consent.
export const DECISION_COLLECTION_ENABLED = true;

type Token = Readonly<{ generation: number }>;
type Entry = { event: DecisionEvent; expires: number; attempts: number };
type Episode = {
  token: Token; id: string; expires: number; ordinal: number; stages: Set<Stage>;
  successEventId?: string;
};
export type PresentationEligibility = {
  committed: boolean; loaded: boolean; current: boolean; visible: boolean;
  stale: boolean; inert: boolean;
};
type Options = {
  enabled?: boolean;
  providerReady?: () => boolean;
  now: () => number;
  randomUUID: () => string;
  send: (event: DecisionEvent, signal: AbortSignal) => Promise<DecisionResponse>;
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

/** Transport, clock and crypto are injected; no storage, account or global browser access. */
export function createDecisionClient(options: Options) {
  let enabled = options.enabled ?? DECISION_COLLECTION_ENABLED;
  let episode: Episode | undefined;
  let generation = 0;
  let queue: Entry[] | undefined;
  let draining = false;
  let active: AbortController | undefined;
  let lifetime = 0;
  const now = options.now;
  function configured() {
    if (!enabled) return false;
    try { return options.providerReady?.() === true; } catch { return false; }
  }
  function owns(token: Token | undefined) {
    return configured() && !!episode && episode.token === token && now() < episode.expires;
  }
  function append<K extends Stage>(owner: Episode, stage: K, data: StageData[K]) {
    if (!configured() || now() >= owner.expires || owner.stages.has(stage)) return false;
    queue = queue?.filter(entry => now() < entry.expires) ?? [];
    if (queue.length >= MEMORY_RETRY.maxEvents) return false;
    try {
      const eventId = options.randomUUID();
      const ordinal = owner.ordinal + 1;
      // Shared exact-key validator is also the boundary for programmatic callers.
      const { event } = parseDecisionEnvelope({
        version: DECISION_ANALYTICS_VERSION, kind: "decision_episode", eventId, decisionId: owner.id,
        ordinal, stage, data, turnstileToken: "validation-only-not-a-transport-token",
      });
      const immutable: DecisionEvent = JSON.parse(JSON.stringify(event));
      owner.ordinal = ordinal;
      owner.stages.add(stage);
      queue.push({ event: immutable, expires: Math.min(now() + MEMORY_RETRY.ttlMs, owner.expires), attempts: 0 });
      return eventId;
    } catch {
      return false;
    }
  }
  function retire(token: Token | undefined, reason: StageData["terminal"]["reason"]) {
    if (!owns(token)) {
      if (episode?.token === token) episode = undefined;
      return false;
    }
    const owner = episode!;
    const queued = append(owner, "terminal", { reason });
    episode = undefined;
    return Boolean(queued);
  }
  return {
    /** A successful final solve is only a candidate; server admission defines the denominator. */
    accepted(data: StageData["calculation"]): Token | undefined {
      if (!configured()) return undefined;
      if (episode) retire(episode.token, "superseded");
      try {
        const owner: Episode = {
          token: Object.freeze({ generation: ++generation }),
          id: options.randomUUID(), expires: now() + EPISODE_TTL_MS,
          ordinal: 0, stages: new Set(),
        };
        if (!append(owner, "calculation", data)) return undefined;
        episode = owner;
        return owner.token;
      } catch {
        return undefined;
      }
    },
    presented(token: Token | undefined, eligibility: PresentationEligibility, leaf: "current" | "wait" = "current") {
      if (!owns(token) || !eligibility.committed || !eligibility.loaded || !eligibility.current ||
          !eligibility.visible || eligibility.stale || eligibility.inert) return false;
      return Boolean(append(episode!, leaf === "current" ? "current_presented" : "wait_presented", {}));
    },
    firstAction(token: Token | undefined, action: StageData["first_action"]["action"]) {
      return owns(token) && Boolean(append(episode!, "first_action", { action }));
    },
    confirmOutcome(token: Token | undefined, outcome: StageData["outcome_confirmation"]["outcome"] = "success") {
      if (!owns(token)) return false;
      const id = append(episode!, "outcome_confirmation", { outcome });
      if (id && outcome === "success") episode!.successEventId = id;
      return Boolean(id);
    },
    reportAttempt(token: Token | undefined, attempts: StageData["attempt_self_report"]["attempts"] | null) {
      return attempts !== null && owns(token) && !!episode!.successEventId &&
        Boolean(append(episode!, "attempt_self_report", { attempts, outcomeEventId: episode!.successEventId! }));
    },
    beforeRetire(token: Token | undefined, action: StageData["first_action"]["action"], reason: StageData["terminal"]["reason"]) {
      if (!owns(token)) return false;
      append(episode!, "first_action", { action });
      return retire(token, reason);
    },
    retire,
    disable() {
      enabled = false;
      ++lifetime;
      episode = undefined;
      queue = undefined;
      active?.abort();
    },
    /** One delivery attempt per queued event per explicit flush; retry waits for another flush. */
    async flush() {
      if (!configured()) {
        episode = undefined;
        queue = undefined;
        return;
      }
      if (draining || !queue?.length) return;
      draining = true;
      const owner = lifetime;
      try {
        while (configured() && lifetime === owner && queue?.length) {
          const head = queue[0]!;
          if (now() >= head.expires || head.attempts >= MEMORY_RETRY.maxAttempts) {
            queue.shift();
            continue;
          }
          head.attempts++;
          active = new AbortController();
          const signal = active.signal;
          const abort = () => active?.abort();
          const cancelTimer = options.schedule
            ? options.schedule(abort, head.expires - now())
            : (() => {
                const timer = setTimeout(abort, head.expires - now());
                return () => clearTimeout(timer);
              })();
          let onAbort: () => void = () => undefined;
          let retryable = true;
          try {
            // A transport cannot mutate the retained logical event between attempts.
            const stopped = new Promise<DecisionResponse>(resolve => {
              onAbort = () => resolve({ error: "analytics_unavailable", retryable: false });
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
            });
            const response = await Promise.race([
              options.send(JSON.parse(JSON.stringify(head.event)), signal), stopped,
            ]);
            retryable = "error" in response && response.retryable;
          } catch {
            // Deliberately no raw error/payload logging.
          } finally {
            signal.removeEventListener("abort", onAbort);
            cancelTimer();
          }
          if (!configured() || lifetime !== owner) break;
          if (retryable && head.attempts < MEMORY_RETRY.maxAttempts && now() < head.expires) break;
          queue.shift();
        }
      } finally {
        active = undefined;
        draining = false;
      }
    },
  };
}
