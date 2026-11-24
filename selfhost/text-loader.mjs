// Node module hook: import .py and .html files as default-exported strings.
// On Cloudflare the same imports are Text modules (see the [[rules]] in the wrangler config
// that deploy.sh uploads); this hook gives worker/*.js the identical behaviour on plain Node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && (url.endsWith(".py") || url.endsWith(".html"))) {
    const text = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
