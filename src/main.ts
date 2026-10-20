import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";
import { ResumeStore } from "./store.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { repo: { type: "string" }, help: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.error("Usage: bun run src/main.ts --repo /absolute/path/to/resume");
    return;
  }
  const root = values.repo ?? process.env.RESUME_REPO;
  if (!root)
    throw new Error("Pass --repo or set RESUME_REPO to your résumé checkout.");
  const server = createServer(await ResumeStore.open(root));
  const shutdown = () => {
    server.close().catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Shutdown failed.",
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.server.onclose = () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  };
  await server.connect(new StdioServerTransport());
}
await main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unable to start résumé MCP.",
  );
  process.exitCode = 1;
});
