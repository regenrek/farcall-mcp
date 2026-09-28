import { build } from "esbuild";
import { chmod, mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { dependencyNotices } from "./notices.mjs";

const root = path.resolve(import.meta.dirname, "..");
const options = {
  absWorkingDir: root,
  metafile: true,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: false,
  legalComments: "eof",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
};
const result = await build({
  ...options,
  entryPoints: [path.join(root, "src/cli.mjs")],
  outfile: path.join(root, "dist/cli.mjs"),
});
await chmod(path.join(root, "dist/cli.mjs"), 0o755);
for (const provider of ["claude", "codex"]) {
  await build({
    ...options,
    stdin: {
      contents: `import { startServer } from './src/transport/server.mjs'; await startServer('${provider}');`,
      resolveDir: root,
      sourcefile: `${provider}-entry.mjs`,
    },
    outfile: path.join(root, `plugins/${provider}-worker/server.mjs`),
  });
}
// Preserve dependency notices with every distributable bundle.
const notices = await dependencyNotices(result.metafile.inputs, root);
for (const folder of [
  "dist",
  "plugins/claude-worker",
  "plugins/codex-worker",
]) {
  await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, folder, "THIRD-PARTY-NOTICES.txt"), notices);
}

for (const provider of ["claude", "codex"]) {
  await copyFile(
    path.join(root, "LICENSE"),
    path.join(root, `plugins/${provider}-worker/LICENSE`),
  );
}
