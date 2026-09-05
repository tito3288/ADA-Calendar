import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDemoState } from "../../src/lib/fixtures";

/** Replace only the dedicated generated E2E fixture, never the user's .data directory. */
export default async function setup() {
  const directory = path.resolve(process.cwd(), ".data-e2e");
  if (path.basename(directory) !== ".data-e2e") throw new Error("Refusing to initialize a non-test data directory.");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "ada-demo.json"), JSON.stringify(createDemoState()), { mode: 0o600 });
}
