import fc from "fast-check";

/** Test-only fixed-seed runner for the S1/S2 property suites (Node and workerd).
 * Lives in shared/ because shared and Worker tests may only import shared/.
 * Interruption policy: fast-check 4.10.2 plugin form
 * `fc.interruptAfterTimeLimit(ms, { failOnInterrupt: true })`; the deprecated
 * `markInterruptAsFailure` parameter is not used. Every failure record carries
 * the seed, replay path, fast-check version, generator-source hash and the
 * identity of the code under test, so a CI failure can be replayed exactly. */
const PROPERTY_SEED = 20_260_720;

export type PropertyIdentity = {
  /** Path of the file that owns the generators. */
  file: string;
  /** Exact text of that file (hashed as the generator-source identity). */
  generatorSource: string;
  /** Code under test: path -> exact source text. */
  sources: Readonly<Record<string, string>>;
  /** Extra identities such as the committed WASM hash. */
  extra?: Readonly<Record<string, string>>;
};

type PropertyOptions = {
  name: string;
  numRuns: number;
  timeLimitMs: number;
  identity: PropertyIdentity;
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function identityRecord(identity: PropertyIdentity) {
  const sources: Record<string, string> = {};
  for (const [path, text] of Object.entries(identity.sources)) sources[path] = await sha256(text);
  return {
    generatorFile: identity.file,
    generatorSourceSha256: await sha256(identity.generatorSource),
    sourceSha256: sources,
    ...(identity.extra ?? {}),
  };
}

async function failureRecord(options: PropertyOptions, details: fc.RunDetails<unknown>) {
  return {
    property: options.name,
    seed: details.seed,
    path: details.counterexamplePath,
    numRuns: details.numRuns,
    numShrinks: details.numShrinks,
    interrupted: details.interrupted,
    counterexample: details.counterexample === null ? null : fc.stringify(details.counterexample),
    error: details.errorInstance === null ? null : String(details.errorInstance),
    fastCheckVersion: fc.__version,
    ...(await identityRecord(options.identity)),
  };
}

async function run<T>(property: fc.IRawProperty<T>, options: PropertyOptions) {
  return await fc.check(property, {
    seed: PROPERTY_SEED,
    numRuns: options.numRuns,
    plugins: [fc.interruptAfterTimeLimit(options.timeLimitMs, { failOnInterrupt: true })],
  });
}

/** Contract property: any counterexample or interruption fails the test. */
export async function assertProperty<T>(
  property: fc.IRawProperty<T>,
  options: PropertyOptions,
): Promise<void> {
  const details = await run(property, options);
  if (details.failed || details.interrupted)
    throw new Error(`property_failed ${JSON.stringify(await failureRecord(options, details))}`);
}

/** Known-defect property for `it.fails`: throws the failure record only when a
 * counterexample exists. A run that passes, or is interrupted before finding a
 * counterexample, returns normally so the surrounding `it.fails` turns red;
 * interruption is therefore never mistaken for the expected defect. */
export async function expectDefectProperty<T>(
  property: fc.IRawProperty<T>,
  options: PropertyOptions,
): Promise<void> {
  const details = await run(property, options);
  const record = await failureRecord(options, details);
  if (details.failed && details.counterexample !== null) {
    console.info(`[defect-witness] ${JSON.stringify(record)}`);
    throw new Error(`known_defect_reproduced ${JSON.stringify(record)}`);
  }
  console.error(`[defect-not-reproduced] ${JSON.stringify(record)}`);
}
