import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertServiceH14Node, serviceH14BaseURL, serviceH14Environment, serviceH14Root, serviceH14Run } from './service-h14-paths.ts';

export function serviceH14Commands(outdir) {
  return [
    { stage: 'certified-pin', args: ['scripts/build-certified-wasm.ts'] },
    { stage: 'legacy-pin', args: ['scripts/build-solver-wasm.ts'] },
    { stage: 'core', args: ['scripts/service-h14-build.ts', '--core'] },
    { stage: 'native', args: ['scripts/service-h14-native-build.ts'] },
    { stage: 'identity', args: ['scripts/service-h14-build.ts', '--identity'] },
    { stage: 'vite', args: ['node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native', '--config', 'scripts/service-h14.vite.config.ts'] },
    { stage: 'package', args: ['--input-type=module', '-e', "const {buildSiteProduction}=await import('./scripts/build-site-production.ts'); await buildSiteProduction(process.argv[1]); await buildSiteProduction(process.argv[1],true);", outdir] },
  ];
}

/** Only the native stage sees the caller's standard Rust locations; it resolves the pinned toolchain itself. */
export function serviceH14StageEnvironment(stage, env, caller = process.env) {
  if (stage !== 'native') return env;
  const rust = Object.fromEntries(['CARGO_HOME', 'RUSTUP_HOME'].filter(name => caller[name]).map(name => [name, caller[name]]));
  return { ...env, ...rust };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertServiceH14Node();
  const root = serviceH14Root(), run = serviceH14Run(root), outdir = join(run, 'dist');
  const commands = serviceH14Commands(outdir);
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--from')) throw new Error('Usage: node scripts/build-service-h14.mjs [--from failed-stage]');
  const start = args.length ? commands.findIndex(command => command.stage === args[1]) : 0;
  if (start < 0) throw new Error('service_h14_unknown_resume_stage');
  if (start === 0 && existsSync(outdir)) throw new Error('service_h14_output_exists_preserve_previous_run');
  const attempt = mkdtempSync(join(run, 'build.')), env = serviceH14Environment(root, run), executed = [];
  for (const { stage, args: command } of commands.slice(start)) {
    const result = spawnSync(process.execPath, command, { cwd: root, env: serviceH14StageEnvironment(stage, env), encoding: 'utf8', timeout: stage === 'native' ? 270000 : 240000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(attempt, `${stage}.stdout`), result.stdout ?? '', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(attempt, `${stage}.stderr`), result.stderr ?? '', { flag: 'wx', mode: 0o600 });
    executed.push({ stage, command: [process.execPath, ...command], status: result.status, signal: result.signal, error: result.error?.message ?? null });
    writeFileSync(join(attempt, 'execution.json'), JSON.stringify({ status: 'NONDEPLOYABLE_SERVICE_CANDIDATE', root, run, outdir, executed, publicationApproved: false, analyticsProviderApproved: false }, null, 2), { mode: 0o600 });
    if (result.error || result.status !== 0) throw new Error(`service_h14_build_failed:${stage}; preserve ${attempt}; after fixing resume with --from ${stage}`);
  }
  console.log(JSON.stringify({ outdir, attempt, preview: serviceH14BaseURL().origin, status: 'NONDEPLOYABLE_SERVICE_CANDIDATE', publicationApproved: false, analyticsProviderApproved: false }));
}
