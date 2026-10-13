// Resolve extensionless relative product imports (src/certified uses bundler-style
// specifiers) to the .ts source. Resolution only; no source transformation.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || (error.code !== "ERR_MODULE_NOT_FOUND" && error.code !== "ERR_UNSUPPORTED_DIR_IMPORT"))
        throw error;
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
  },
});
