// Entry point.

import { createApp } from "./app.js";
import { readEnv } from "./config.js";

const env = readEnv();

async function main() {
  const app = await createApp(env);
  await app.git.start();
  const port = await app.listen();
  const notes = [...app.brain.index.files.values()].filter((f) => f.md).length;
  console.log(`[brain] listening on http://${env.host}:${port}  vault=${env.vaultDir}  data=${env.dataDir}  notes=${notes}`);
  if (!app.cfg.setupComplete) console.log(`[brain] FIRST-RUN SETUP: open the web UI and enter setup code: ${app.cfg.setupCode}`);

  const shutdown = async (sig: string) => {
    console.log(`[brain] ${sig}: shutting down`);
    try {
      await app.git.commitPending("Commit pending changes on shutdown");
    } catch (e) {
      console.warn("[brain] final commit failed:", (e as Error).message);
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("[brain] fatal:", e);
  process.exit(1);
});
