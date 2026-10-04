export const scripts = {
  collector: "collection-kit-forecast-collector-staging",
  dispatcher: "collection-kit-forecast-dispatcher-staging",
} as const;
export const roles = ["dispatcher", "collector"] as const;
export type Role = (typeof roles)[number];
export type SubmissionAuthority =
  | { origin: "watchdog"; purpose: "budget" | "hold" }
  | { origin: "operator" };
export type Target = { script: string; versionId: string; bundleHash: string };
export type Registry = {
  epoch: number;
  accountId: string;
  maintenanceHold: boolean;
  sourcePin: string;
  registeredAt: string;
  approvalRef: string;
  flags: { COLLECT_ENABLED: "false"; DISPATCH_ENABLED: "false" };
  workers: Record<Role, Target>;
};
export type Version = { id: string; flags: Record<string, string> };
export type Deployment = {
  id: string;
  createdOn: string;
  versions: Array<{ versionId: string; percentage: number }>;
  message: string;
};
export type Attempt = {
  requestId: string;
  role: Role;
  script: string;
  versionId: string;
  epoch: number;
  startedAt: string;
  approvalRef: string;
  message: string;
};
export type Receipt = {
  attempt: Attempt;
  state: "prepared" | "submitted" | "resolved" | "unknown" | "not_submitted";
  deploymentId?: string | undefined;
};
export type Journal = {
  baselineEvidence: "provided" | "unavailable" | "incomplete" | "invalid";
  append(receipt: Receipt): Promise<void>;
  read(): Promise<Receipt[]>;
  markIncomplete(reason: string): Promise<void>;
};
export type EvidenceState = "provided" | "missing" | "invalid" | "incomplete";
export type RoleEvidence = Record<Role, EvidenceState>;
export type Snapshot = {
  registry?: Registry;
  errors: Partial<Record<Role, string>>;
  epochComparison: "unavailable" | "compared";
  budgetStop: boolean;
  priorRequestEvidence?: RoleEvidence;
  evidenceIssues?: Partial<Record<Role, string>>;
  epochIssue?: string | undefined;
  epochBaseline?: number | undefined;
  snapshotMissing?: boolean | undefined;
  fallbackDiagnostics?: string[] | undefined;
};
export type Api = {
  registry(): Promise<unknown>;
  version(registry: Registry, role: Role): Promise<Version>;
  active(registry: Registry, role: Role): Promise<Deployment>;
  history(registry: Registry, role: Role): Promise<Deployment[]>;
  deploy(registry: Registry, role: Role, message: string): Promise<{ id: string }>;
  activeRuns(): Promise<number>;
};
export type WorkerResult = {
  role: Role;
  state: "verified" | "idle" | "failed" | "unknown";
  requestResolved: boolean;
  currentVerified: boolean;
  evidence: "preserved" | "missing" | "not_requested";
  reason: string;
  requestId?: string | undefined;
  corrected?: boolean | undefined;
  purpose?: "budget" | "hold" | "readonly" | undefined;
  historyTrusted?: boolean | undefined;
  priorUnresolved?: boolean | undefined;
  registry?: Registry | undefined;
  epochComparison?: "unavailable" | "compared" | undefined;
  snapshotMissing?: boolean | undefined;
  diagnostics?: string[] | undefined;
};
