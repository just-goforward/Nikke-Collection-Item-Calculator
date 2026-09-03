const COLLECTOR_CRON = "*/3 * * * *";
const DISPATCHER_CRON = "1-59/3 * * * *";

type CanaryStartIdentity = {
  environment: "staging" | "production";
  deploymentSha: string;
  collectorCron: string;
  dispatcherCron: string;
  collectorVersionId: string;
  dispatcherVersionId: string;
};

type StoredCanaryIdentity = {
  environment: string;
  deployment_sha: string;
  collector_cron: string;
  dispatcher_cron: string;
  collector_version_id: string;
  dispatcher_version_id: string;
  quota_evidence_hash: string;
};

export function validateCanaryStartInput(input: CanaryStartIdentity & { canaryId: string }) {
  if (!/^fc-[0-9a-f]{32}$/.test(input.canaryId)) throw new Error("canary_id_invalid");
  if (!/^[0-9a-f]{40}$/.test(input.deploymentSha)) throw new Error("canary_deployment_sha_invalid");
  if (input.collectorCron !== COLLECTOR_CRON || input.dispatcherCron !== DISPATCHER_CRON) {
    throw new Error("canary_cron_contract_invalid");
  }
  assertVersionId(input.collectorVersionId, "canary_collector_version_id_invalid");
  assertVersionId(input.dispatcherVersionId, "canary_dispatcher_version_id_invalid");
}

export function existingRunConflicts(
  existing: StoredCanaryIdentity,
  input: CanaryStartIdentity,
  quotaEvidenceHash: string,
) {
  return (
    existing.environment !== input.environment ||
    existing.deployment_sha !== input.deploymentSha ||
    existing.collector_cron !== input.collectorCron ||
    existing.dispatcher_cron !== input.dispatcherCron ||
    existing.collector_version_id !== input.collectorVersionId.toLowerCase() ||
    existing.dispatcher_version_id !== input.dispatcherVersionId.toLowerCase() ||
    existing.quota_evidence_hash !== quotaEvidenceHash
  );
}

function assertVersionId(value: string, code: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(code);
  }
}
