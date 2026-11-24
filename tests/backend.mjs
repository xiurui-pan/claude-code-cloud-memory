// Starts the server under test. BACKEND=cf (default): wrangler dev --local. BACKEND=node: selfhost/server.mjs.
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
export const BACKEND = process.env.BACKEND || "cf";
if (BACKEND !== "cf" && BACKEND !== "node") throw new Error("BACKEND must be cf or node");

// vars: plain object of environment-style settings (TOKEN_SHA256, ACCESS_AUD, ...).
// Returns {proc, sql(query) -> rows, stop()}. The state dir is wiped first.
export function start({ port, state, vars }) {
  fs.rmSync(state, { recursive: true, force: true });
  let proc, sql;
  if (BACKEND === "cf") {
    spawnSync("npx", ["wrangler", "d1", "execute", "memsync-test", "--local", "--persist-to", state, "--file", path.join(ROOT, "worker", "schema.sql")], { cwd: HERE, stdio: "ignore" });
    const args = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
    proc = spawn("npx", ["wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(port + 100), "--persist-to", state, ...args], { cwd: HERE, detached: true, stdio: ["ignore", "ignore", "inherit"] });
    sql = (q) => JSON.parse(spawnSync("npx", ["wrangler", "d1", "execute", "memsync-test", "--local", "--persist-to", state, "--json", "--command", q], { cwd: HERE, encoding: "utf8" }).stdout)[0].results;
  } else {
    const db = path.join(state, "memory.db");
    fs.mkdirSync(state, { recursive: true });
    proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "selfhost", "server.mjs")], {
      cwd: HERE, detached: true, stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DB_PATH: db, ...vars },
    });
    sql = (q) => { const d = new DatabaseSync(db); try { d.exec("PRAGMA busy_timeout = 5000"); return d.prepare(q).all().map((r) => ({ ...r })); } finally { d.close(); } };
  }
  const stop = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} };
  return { proc, sql, stop };
}

export async function up(port) {
  for (let i = 0; i < 120; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("server did not start");
}
