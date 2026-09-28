import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function dependencyNotices(inputs, root) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory.includes("node_modules")) {
      try {
        const metadata = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        );
        if (metadata.name && metadata.version) {
          packages.set(`${metadata.name}@${metadata.version}`, directory);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = path.dirname(directory);
    }
  }
  const notices = [];
  for (const [name, directory] of [...packages.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const files = (await readdir(directory))
      .filter((file) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file))
      .toSorted();
    if (!files.length)
      throw new Error(`Missing bundled dependency license for ${name}`);
    const text = await Promise.all(
      files.map((file) => readFile(path.join(directory, file), "utf8")),
    );
    notices.push(`${name}\n\n${text.join("\n")}`);
  }
  return notices.join("\n\n");
}
