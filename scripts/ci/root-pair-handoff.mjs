import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertContext } from '../site-release.mjs';
import { checkRehearsal } from './root-switch-policy.mjs';

export function recordHandoff(env) {
  assertContext(env, env.GITHUB_SHA); assert.equal(env.GITHUB_REF_PROTECTED, 'true');
  const out = join(env.RUNNER_TEMP, 'root-pair'), dest = join(out, 'receipt');
  const digests = JSON.parse(readFileSync(join(out, 'digests.json'))), directions = {};
  for (const role of ['rollback', 'forward']) {
    const id = env[`${role.toUpperCase()}_ID`], archive = env[`${role.toUpperCase()}_DIGEST`];
    assert(/^[1-9][0-9]*$/.test(id), `missing ${role} artifact ID`); assert(/^[0-9a-f]{64}$/.test(archive), `missing ${role} archive digest`);
    const release = join(env.RUNNER_TEMP, 'root-roundtrip', role);
    execFileSync(process.execPath, [resolve(import.meta.dirname, '../root-release-sealed-check.mjs'), role,
      join(out, 'private-root-pair.json'), join(out, 'private-canary.json'), release,
      env.GITHUB_SHA, digests[role], env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT], { stdio: 'inherit' });
    directions[role] = { artifactId: id, artifactSha256: archive, manifestSha256: digests[role] };
  }
  for (const field of ['artifactId', 'artifactSha256', 'manifestSha256']) assert.notEqual(directions.rollback[field], directions.forward[field], `duplicate ${field}`);
  const packet = readFileSync(join(out, 'private-root-pair.json')), canary = readFileSync(join(out, 'private-canary.json'));
  assert.equal(JSON.parse(canary).packetSha256, hash('sha256', packet));
  const review = join(env.RUNNER_TEMP, 'root-input/public-review.json');
  assert.equal(hash('sha256', readFileSync(review)), env.ROOT_PAIR_REVIEW_SHA256);
  mkdirSync(dest); copyFileSync(review, join(dest, 'public-review.json'));
  copyFileSync(join(out, 'private-root-pair.json'), join(dest, 'private-root-pair.json'));
  copyFileSync(join(out, 'private-canary.json'), join(dest, 'private-canary.json'));
  const rehearsal = join(dest,'sealed-rehearsal.json');
  execFileSync(process.execPath,[resolve(import.meta.dirname,'../root-release-canary.mjs'),join(out,'private-root-pair.json'),rehearsal,join(env.RUNNER_TEMP,'root-roundtrip')],{stdio:'inherit'});
  const rehearsalSha256=hash('sha256',readFileSync(rehearsal));
  checkRehearsal(JSON.parse(readFileSync(rehearsal)),JSON.parse(packet),hash('sha256',packet),env.GITHUB_SHA);
  writeFileSync(join(dest, 'handoff.json'), JSON.stringify({ profile: 'production-root-pair-handoff-v1',
    repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    reviewRun: env.REVIEW_RUN, reviewArtifact: env.REVIEW_ARTIFACT, reviewSha256: env.ROOT_PAIR_REVIEW_SHA256,
    rehearsalSha256,
    packetSha256: hash('sha256', packet), canarySha256: hash('sha256', canary), directions, deployed: false }, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) recordHandoff(process.env);
