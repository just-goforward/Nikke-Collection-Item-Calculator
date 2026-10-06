import type AxeBuilder from "@axe-core/playwright";
import type { TestInfo } from "@playwright/test";

export type AxeResult = Awaited<ReturnType<AxeBuilder["analyze"]>>;

export interface RequestedTarget {
  key: string;
  expected: string;
  element: Element | null;
}

interface AnimationEvidence {
  id: string;
  kind: string;
  name: string | null;
  property: string | null;
  playState: AnimationPlayState;
  pending: boolean;
  currentTime: unknown;
  startTime: unknown;
  playbackRate: number;
  timing: Record<string, unknown> | null;
}

interface ElementEvidence {
  selector: string;
  className: string | null;
  computed: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  animations: AnimationEvidence[];
}

export interface FontCheck {
  key: string;
  specification: string | null;
  available: boolean | null;
  error?: string;
}

interface FontEvidence {
  status: FontFaceSetLoadStatus;
  faces: { family: string; style: string; weight: string; stretch: string; status: string }[];
  checks: FontCheck[];
}

interface ModalSnapshot {
  timeOrigin: number;
  startedAt: number;
  completedAt: number;
  url: string;
  userAgent: string;
  devicePixelRatio: number;
  reducedMotion: boolean;
  targetsComplete: boolean;
  animationIdle: boolean;
  entranceOpaque: boolean;
  targets: {
    key: string;
    expected: string;
    selector: string | null;
    text: string | null;
    ancestors: string[];
  }[];
  elements: ElementEvidence[];
  fonts: FontEvidence;
}

export interface BrowserSample {
  state: "OBSERVED" | "SETTLED" | "NOT_SETTLED";
  snapshot: ModalSnapshot;
  timeline: { at: number; same: boolean; ready: boolean; frame: boolean }[];
  signature: string;
  ready: boolean;
}

export interface Sample extends BrowserSample {
  rpcStartedAt: number;
  rpcCompletedAt: number;
}

export interface BrowserRegistry {
  document: Document;
  timeOrigin: number;
  url: string;
  installed: boolean;
  helpers: Partial<{
    identify: (element: Element) => string;
    element: (element: Element) => ElementEvidence;
    fonts: (targets: RequestedTarget[]) => FontEvidence;
    capture: () => ModalSnapshot;
    sample: (settle: boolean) => Promise<BrowserSample>;
  }>;
}

export type RegistryKey = `__nikkeModalContrast_${string}`;

declare global {
  interface Window {
    [key: RegistryKey]: BrowserRegistry | undefined;
  }
}

export type PhaseName =
  | "installation"
  | "initialBefore"
  | "initialAxe"
  | "initialAfter"
  | "settlement"
  | "stableBefore"
  | "stableAxe"
  | "stableAfter";

export interface Phase {
  status: "NOT_STARTED" | "RUNNING" | "COMPLETE" | "ERROR" | "MISSING";
  started: number;
  finished: number;
  resultObtained: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface Artifact {
  name: string;
  path: string;
  attached: boolean;
}

export interface DiagnosticContext {
  testInfo: TestInfo;
  key: RegistryKey;
  metadata: Record<string, unknown>;
  errors: string[];
  artifacts: Artifact[];
  phases: Record<PhaseName, Phase>;
  initial: AxeResult | null;
  stable: AxeResult | null;
  initialRawSaved: boolean;
  stableRawSaved: boolean;
  stableEndpointsUnchanged: boolean | null;
}
