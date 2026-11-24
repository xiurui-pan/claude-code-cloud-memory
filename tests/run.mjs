// Runs the test files sequentially from the tests/ directory.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ["test.mjs", "test2.mjs"]) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { cwd: here, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}
