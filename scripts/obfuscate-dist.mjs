import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JavaScriptObfuscator = require("javascript-obfuscator");

const projectRoot = process.cwd();
const assetsDir = path.join(projectRoot, "dist", "assets");

const sharedOptions = {
  compact: true,
  sourceMap: false,
  target: "browser",
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: "mangled",
  log: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: [],
  unicodeEscapeSequence: false,
  renameProperties: false,
};

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function assertNoSourceMaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoSourceMaps(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".map")) {
      throw new Error(`Unexpected sourcemap generated: ${path.relative(projectRoot, fullPath)}`);
    }
  }
}

async function main() {
  try {
    const info = await stat(assetsDir);
    if (!info.isDirectory()) throw new Error();
  } catch {
    throw new Error("dist/assets was not found. Run the Vite build before obfuscation.");
  }

  const jsFiles = await collectJavaScriptFiles(assetsDir);
  if (!jsFiles.length) throw new Error("No JavaScript files found in dist/assets.");

  for (const file of jsFiles) {
    const source = await readFile(file, "utf8");
    const result = JavaScriptObfuscator.obfuscate(source, sharedOptions);
    await writeFile(file, result.getObfuscatedCode(), "utf8");
    console.log(`obfuscated ${path.relative(projectRoot, file)}`);
  }

  await assertNoSourceMaps(path.join(projectRoot, "dist"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
