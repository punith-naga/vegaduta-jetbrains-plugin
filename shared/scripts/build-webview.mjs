#!/usr/bin/env node
// Bundles the chat webview into dist/webview/ for all three hosts:
//   chat.js    - esbuild bundle of src/webview/chat/main.ts (esm, single file)
//   index.html - copied verbatim
//   chat.css   - copied verbatim
//
// splitting stays OFF so the lazy `import("../engineHost")` in main.ts is
// inlined into chat.js - every host loads exactly one script file (JBCef's
// resource handler and VS Code's asWebviewUri both get simpler that way).
// If a future esbuild version stops inlining dynamic imports without
// splitting, the fallback is: add engineHost.ts as a second entry point with
// outdir (not outfile) + splitting:true and ship both emitted files.
//
// engineHost.ts is owned by another workstream (M2) and may not exist yet;
// in that case the import is aliased to a stub so this build still succeeds
// and the chat UI degrades to "engine unavailable" (main.ts already catches
// the stub's throw and reports engine.status accordingly).

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chatDir = join(root, "src", "webview", "chat");
const outDir = join(root, "dist", "webview");

const engineHostExists = existsSync(join(root, "src", "webview", "engineHost.ts"));

/** Resolves `../engineHost` to an in-memory stub when the real module is
 * absent, so the bundle builds before M2 lands. */
const engineHostStubPlugin = {
  name: "enginehost-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\.\.\/engineHost$/ }, () => ({
      path: "engineHost-stub",
      namespace: "enginehost-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "enginehost-stub" }, () => ({
      loader: "js",
      contents: `export function createEngineHost() {
  throw new Error("Local engine is not included in this build.");
}
`,
    }));
  },
};

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(chatDir, "main.ts")],
  outfile: join(outDir, "chat.js"),
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  sourcemap: false,
  logLevel: "info",
  plugins: engineHostExists ? [] : [engineHostStubPlugin],
});

copyFileSync(join(chatDir, "index.html"), join(outDir, "index.html"));
copyFileSync(join(chatDir, "chat.css"), join(outDir, "chat.css"));

console.log(
  `webview built -> ${outDir}${engineHostExists ? "" : " (engineHost stubbed - src/webview/engineHost.ts not present yet)"}`
);
