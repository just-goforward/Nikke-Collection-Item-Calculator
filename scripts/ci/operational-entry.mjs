import { runOperational } from './operational-main.mjs';

runOperational({ output: process.env.OPERATIONAL_PUBLIC_RESULT })
  .then(code => { process.exitCode = code; })
  .catch(() => { process.exitCode = 1; });
