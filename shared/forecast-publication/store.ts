import {
  ARTIFACT_DOMAIN,
  canonicalPublicationJson,
  importPublicationSigningKey,
  POINTER_DOMAIN,
  type PointerStatement,
  type PublicationEnvironment,
  publicationCandidate,
  publicationHash,
  signPublication,
} from "../forecastPublication.ts";
import type { SupplyForecastCandidate } from "../supplyForecastCandidate.ts";

// Only the D1 operations this backend consumes. A local structural boundary avoids importing
// Worker-global declarations into Node typechecks or depending on the browser's D1 placeholder.
type PublicationStatement = {
  bind(...values: unknown[]): PublicationStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
};
export type PublicationDatabase = {
  prepare(query: string): PublicationStatement;
  batch(statements: PublicationStatement[]): Promise<
    {
      results: unknown[];
      meta: { changes: number };
    }[]
  >;
};

export const REVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
export type PublicationAction = "approve" | "rollback" | "off";
export type ActiveRow = {
  environment: PublicationEnvironment;
  sequence: number;
  candidate_id: string | null;
  operation_id: string | null;
  signed_pointer_json: string | null;
};
export type ReviewRow = {
  review_id: string;
  environment: PublicationEnvironment;
  action: PublicationAction;
  candidate_id: string | null;
  payload_hash: string | null;
  expected_sequence: number;
  previous_candidate_id: string | null;
  expires_at: number;
};
type CommandRow = {
  request_hash: string;
  state: "pending" | "failed" | "applied";
  result_sequence: number | null;
};
export type CommandInput = {
  interactionId: string;
  reviewId: string;
  environment: PublicationEnvironment;
  actorId: string;
  messageId: string;
  channelId: string;
};

export async function initializePublication(
  db: PublicationDatabase,
  environment: PublicationEnvironment,
) {
  await db
    .prepare(`INSERT INTO forecast_runtime_active(singleton,environment,sequence)
    SELECT 1,?,0 WHERE NOT EXISTS(SELECT 1 FROM forecast_runtime_active)`)
    .bind(environment)
    .run();
  return readActive(db, environment);
}

export async function readActive(
  db: PublicationDatabase,
  environment: PublicationEnvironment,
): Promise<ActiveRow> {
  const row = await db
    .prepare("SELECT * FROM forecast_runtime_active WHERE singleton=1")
    .first<ActiveRow>();
  if (!row || row.environment !== environment) throw new Error("publication_environment_mismatch");
  return row;
}

export async function sealCandidate(db: PublicationDatabase, candidateId: string, now: number) {
  const existing = await db
    .prepare("SELECT candidate_id FROM forecast_runtime_versions WHERE candidate_id=?")
    .bind(candidateId)
    .first<{ candidate_id: string }>();
  if (existing) return readSealedCandidate(db, candidateId);
  const row = await db
    .prepare("SELECT payload_json,payload_hash FROM forecast_candidates WHERE candidate_id=?")
    .bind(candidateId)
    .first<{ payload_json: string; payload_hash: string }>();
  if (!row) throw new Error("publication_candidate_missing");
  const candidate = publicationCandidate(JSON.parse(row.payload_json));
  if (
    candidate.candidateId !== candidateId ||
    (await publicationHash(candidate)) !== row.payload_hash
  )
    throw new Error("publication_candidate_hash");
  await db
    .prepare(`INSERT INTO forecast_runtime_versions
    (candidate_id,payload_hash,rules_version,payload_version,snapshot_version,payload_bytes,sealed_at)
    SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM forecast_runtime_versions WHERE candidate_id=?)`)
    .bind(
      candidateId,
      row.payload_hash,
      candidate.rulesVersion,
      candidate.payloadVersion,
      candidate.certifiedSnapshot!.version,
      new TextEncoder().encode(row.payload_json).length,
      now,
      candidateId,
    )
    .run();
  return { candidate, hash: row.payload_hash };
}

export async function readSealedCandidate(db: PublicationDatabase, candidateId: string) {
  const row = await db
    .prepare(`SELECT c.payload_json,c.payload_hash,v.payload_hash AS sealed_hash
    FROM forecast_candidates c JOIN forecast_runtime_versions v ON v.candidate_id=c.candidate_id
    WHERE c.candidate_id=?`)
    .bind(candidateId)
    .first<{ payload_json: string; payload_hash: string; sealed_hash: string }>();
  if (!row) throw new Error("publication_candidate_unsealed");
  // The seal attests full validation and 0022 prevents every artifact mutation.
  // Deserialize that trusted type only after checking its canonical content hash.
  const candidate: SupplyForecastCandidate = JSON.parse(row.payload_json);
  if (
    candidate.candidateId !== candidateId ||
    row.payload_hash !== row.sealed_hash ||
    (await publicationHash(candidate)) !== row.sealed_hash
  )
    throw new Error("publication_candidate_hash");
  return { candidate, hash: row.sealed_hash };
}

export async function createReview(
  db: PublicationDatabase,
  active: ActiveRow,
  action: PublicationAction,
  candidateId: string | null,
  hash: string | null,
  now: number,
  directInteractionId?: string,
): Promise<string> {
  // The epoch bounds renewal and gives concurrent Cron runs a single review identity.
  const epoch = Math.floor(now / REVIEW_TTL_MS);
  const reviewKey = `${active.environment}:${action}:${candidateId ?? "off"}:${active.sequence}:${epoch}:${directInteractionId ?? "cron"}`;
  const reviewId = (await publicationHash(reviewKey)).slice(0, 32);
  const expires = now + REVIEW_TTL_MS;
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_runtime_reviews
      (review_id,review_key,environment,action,candidate_id,payload_hash,expected_sequence,previous_candidate_id,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM forecast_runtime_reviews WHERE review_key=?)`)
      .bind(
        reviewId,
        reviewKey,
        active.environment,
        action,
        candidateId,
        hash,
        active.sequence,
        active.candidate_id,
        expires,
        now,
        reviewKey,
      ),
    db
      .prepare(`INSERT INTO forecast_runtime_outbox
      (outbox_id,environment,kind,review_id,next_attempt_at,state,attempts,lease_token,lease_until)
      SELECT ?,?,'review',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM forecast_runtime_outbox WHERE outbox_id=?)`)
      .bind(
        `review:${reviewId}`,
        active.environment,
        reviewId,
        now,
        directInteractionId ? "sending" : "pending",
        directInteractionId ? 1 : 0,
        directInteractionId ?? null,
        directInteractionId ? now + 60_000 : null,
        `review:${reviewId}`,
      ),
  ]);
  return reviewId;
}

export async function createPreviousRollbackReview(
  db: PublicationDatabase,
  active: ActiveRow,
  now: number,
  directInteractionId?: string,
): Promise<string | null> {
  if (!active.operation_id) return null;
  const previous = await db
    .prepare(`SELECT h.previous_candidate_id,a.payload_hash FROM forecast_runtime_activation_history h
    JOIN forecast_runtime_approvals a ON a.candidate_id=h.previous_candidate_id AND a.environment=h.environment
    WHERE h.operation_id=? AND h.environment=? AND h.sequence=? AND h.candidate_id IS ?`)
    .bind(active.operation_id, active.environment, active.sequence, active.candidate_id)
    .first<{ previous_candidate_id: string; payload_hash: string }>();
  if (!previous || previous.previous_candidate_id === active.candidate_id) return null;
  return createReview(
    db,
    active,
    "rollback",
    previous.previous_candidate_id,
    previous.payload_hash,
    now,
    directInteractionId,
  );
}

export async function bindDirectReviewMessage(
  db: PublicationDatabase,
  input: {
    reviewId: string;
    interactionId: string;
    messageId: string;
    channelId: string;
  },
) {
  const existing = await db
    .prepare("SELECT state,message_id,channel_id FROM forecast_runtime_outbox WHERE outbox_id=?")
    .bind(`review:${input.reviewId}`)
    .first<{ state: string; message_id: string | null; channel_id: string | null }>();
  if (
    existing?.state === "sent" &&
    existing.message_id === input.messageId &&
    existing.channel_id === input.channelId
  )
    return;
  const result = await db
    .prepare(`UPDATE forecast_runtime_outbox SET state='sent',message_id=?,channel_id=?,
    lease_token=NULL,lease_until=NULL,error_code=NULL WHERE outbox_id=? AND state='sending' AND lease_token=?`)
    .bind(input.messageId, input.channelId, `review:${input.reviewId}`, input.interactionId)
    .run();
  if (result.meta.changes !== 1) throw new Error("publication_delivery_lease_lost");
}

export async function readReview(db: PublicationDatabase, input: CommandInput): Promise<ReviewRow> {
  const row = await db
    .prepare(`SELECT r.* FROM forecast_runtime_reviews r
    JOIN forecast_runtime_outbox o ON o.review_id=r.review_id AND o.kind='review'
    WHERE r.review_id=? AND r.environment=? AND o.state='sent' AND o.message_id=? AND o.channel_id=?`)
    .bind(input.reviewId, input.environment, input.messageId, input.channelId)
    .first<ReviewRow>();
  if (!row) throw new Error("publication_review_binding");
  return row;
}

export async function applyPublicationCommand(
  db: PublicationDatabase,
  input: CommandInput,
  signing: { privateKey: string; keyId: string },
  now = Date.now(),
  authorizeApprove?: () => Promise<unknown>,
): Promise<{ sequence: number; duplicate: boolean }> {
  const review = await readReview(db, input);
  const requestHash = await publicationHash(input);
  await db
    .prepare(`INSERT INTO forecast_runtime_commands
    (interaction_id,review_id,request_hash,actor_id,state,created_at,updated_at)
    SELECT ?,?,?,?,'pending',?,? WHERE NOT EXISTS(SELECT 1 FROM forecast_runtime_commands WHERE interaction_id=?)`)
    .bind(
      input.interactionId,
      input.reviewId,
      requestHash,
      input.actorId,
      now,
      now,
      input.interactionId,
    )
    .run();
  const command = await readCommand(db, input.interactionId);
  if (command.request_hash !== requestHash) throw new Error("publication_command_conflict");
  if (command.state === "applied") return { sequence: command.result_sequence!, duplicate: true };
  await db
    .prepare(`UPDATE forecast_runtime_commands SET state='pending',attempts=attempts+1,updated_at=?,error_code=NULL
    WHERE interaction_id=? AND state!='applied'`)
    .bind(now, input.interactionId)
    .run();
  try {
    if (review.action === "approve") await authorizeApprove?.();
    if (review.expires_at <= now) throw new Error("publication_review_expired");
    const active = await readActive(db, input.environment);
    if (
      active.sequence !== review.expected_sequence ||
      active.candidate_id !== review.previous_candidate_id
    )
      throw new Error("publication_review_stale");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(signing.keyId)) throw new Error("publication_key_id");
    const key = await importPublicationSigningKey(signing.privateKey);
    const statements: PublicationStatement[] = [];
    const approval = await prepareArtifactApproval(db, review, input, signing.keyId, key, now);
    if (approval) statements.push(approval);
    const pointer: PointerStatement = {
      domain: POINTER_DOMAIN,
      environment: input.environment,
      keyId: signing.keyId,
      sequence: active.sequence + 1,
      mode: review.action === "off" ? "off" : "active",
      candidateId: review.candidate_id,
      contentHash: review.payload_hash,
      operationId: input.interactionId,
      issuedAt: now,
    };
    if (!Number.isSafeInteger(pointer.sequence)) throw new Error("publication_sequence_exhausted");
    const signedPointer = await signPublication(pointer, key);
    statements.push(
      db
        .prepare(`INSERT INTO forecast_runtime_activation_history
      (operation_id,review_id,environment,action,sequence,previous_candidate_id,candidate_id,actor_id,applied_at,signed_pointer_json)
      VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING operation_id`)
        .bind(
          input.interactionId,
          review.review_id,
          input.environment,
          review.action,
          pointer.sequence,
          active.candidate_id,
          review.candidate_id,
          input.actorId,
          now,
          canonicalPublicationJson(signedPointer),
        ),
    );
    const results = await db.batch(statements);
    // Inserts are unconditional VALUES; stale/zero-row CAS is a trigger ABORT, not success.
    // RETURNING checks direct affected rows; meta.changes also includes trigger effects in D1.
    if (results.some((result) => result.results.length !== 1 || result.meta.changes < 1))
      throw new Error("publication_affected_rows");
    return { sequence: pointer.sequence, duplicate: false };
  } catch (error) {
    const completed = await readCommand(db, input.interactionId);
    if (completed.state === "applied")
      return { sequence: completed.result_sequence!, duplicate: true };
    await db
      .prepare(`UPDATE forecast_runtime_commands SET state='failed',error_code=?,updated_at=?
      WHERE interaction_id=? AND state!='applied'`)
      .bind(publicationErrorCode(error), now, input.interactionId)
      .run();
    throw error;
  }
}

async function prepareArtifactApproval(
  db: PublicationDatabase,
  review: ReviewRow,
  input: CommandInput,
  keyId: string,
  key: CryptoKey,
  now: number,
): Promise<PublicationStatement | null> {
  if (review.action === "rollback") {
    // The immutable target must have been approved in this DB/environment. Rotation requires
    // a consumer trust set containing both keys; this v1 deployment uses one pinned key.
    const approved = await db
      .prepare(`SELECT key_id FROM forecast_runtime_approvals
      WHERE candidate_id=? AND environment=? AND payload_hash=?`)
      .bind(review.candidate_id, input.environment, review.payload_hash)
      .first<{ key_id: string }>();
    if (!approved || approved.key_id !== keyId) throw new Error("publication_rollback_key");
  }
  if (review.action !== "approve") return null;
  // Sealing only attests immutable content. The approval INSERT trigger checks
  // current candidate eligibility in the same atomic write as activation.
  const sealed = await readSealedCandidate(db, review.candidate_id!);
  if (sealed.hash !== review.payload_hash) throw new Error("publication_candidate_hash");
  const artifact = await signPublication(
    {
      domain: ARTIFACT_DOMAIN,
      environment: input.environment,
      keyId,
      candidateId: review.candidate_id!,
      contentHash: review.payload_hash!,
    },
    key,
  );
  return db
    .prepare(`INSERT INTO forecast_runtime_approvals
    (candidate_id,interaction_id,environment,payload_hash,key_id,artifact_signature,actor_id,approved_at)
    VALUES(?,?,?,?,?,?,?,?) RETURNING candidate_id`)
    .bind(
      review.candidate_id,
      input.interactionId,
      input.environment,
      review.payload_hash,
      keyId,
      artifact.signature,
      input.actorId,
      now,
    );
}

function readCommand(db: PublicationDatabase, id: string) {
  return db
    .prepare(
      "SELECT request_hash,state,result_sequence FROM forecast_runtime_commands WHERE interaction_id=?",
    )
    .bind(id)
    .first<CommandRow>()
    .then((row) => {
      if (!row) throw new Error("publication_command_missing");
      return row;
    });
}

export function publicationErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message.match(/(?:publication|runtime)_[a-z_]+/)?.[0] ?? "publication_operation_failed";
}
