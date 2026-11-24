// Runs the test files sequentially from the tests/ directory.
//   BACKEND=cf    wrangler dev --local (Cloudflare Worker + D1)
//   BACKEND=node  selfhost/server.mjs (Node + node:sqlite)
//   unset         both, one after the other
// test3.mjs (self-host admin login / proxy header auth) only runs on the node backend.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const backends = process.env.BACKEND ? [process.env.BACKEND] : ["cf", "node"];
for (const backend of backends) {
  for (const f of ["test.mjs", "test2.mjs", "test3.mjs"]) {
    if (f === "test3.mjs" && backend !== "node") continue;
    console.log(`\n=== ${f} [${backend}] ===`);
    const r = spawnSync(process.execPath, [path.join(here, f)], { cwd: here, stdio: "inherit", env: { ...process.env, BACKEND: backend } });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}
