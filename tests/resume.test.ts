import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { compilePdf } from "../src/pdf.ts";
import { createServer } from "../src/server.ts";
import { ResumeStore } from "../src/store.ts";

const source =
  "\\documentclass{article}\n\\begin{document}\n\\section*{Experience}\nEngineer\n\\end{document}\n";
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "resume-mcp-test-"));
  directories.push(root);
  await writeFile(join(root, "resume.tex"), source);
  return ResumeStore.open(root);
}

test("variants, stale hashes, invalid documents, and diffs preserve the main résumé", async () => {
  const store = await fixture();
  const main = await store.read("main");
  expect(main.sections).toEqual(["Experience"]);
  await store.create("backend", "main", main.hash);
  await expect(store.create("backend", "main", main.hash)).rejects.toThrow();
  const variant = await store.save(
    "backend",
    main.hash,
    source.replace("Engineer", "Backend engineer"),
  );
  await expect(store.save("backend", main.hash, source)).rejects.toThrow(
    "changed",
  );
  await expect(
    store.save("backend", variant.hash, "not latex"),
  ).rejects.toThrow("complete");
  expect((await store.read("main")).source).toBe(source);
  expect((await store.diff("backend", "main")).diff).toContain(
    "+Backend engineer",
  );
  expect((await store.list()).map((item) => item.id)).toEqual([
    "main",
    "backend",
  ]);
});

test("concurrent writers cannot both overwrite a snapshot", async () => {
  const store = await fixture();
  const main = await store.read("main");
  const outcomes = await Promise.allSettled([
    store.save("main", main.hash, source.replace("Engineer", "A")),
    store.save("main", main.hash, source.replace("Engineer", "B")),
  ]);
  expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
  expect(await readdir(await store.workDirectory())).not.toContain(
    "write-lock",
  );
});

test("paths and symlinks cannot select unrelated files", async () => {
  const store = await fixture();
  const main = await store.read("main");
  await expect(store.create("../escape", "main", main.hash)).rejects.toThrow();
  await expect(store.create("main", "main", main.hash)).rejects.toThrow();
  await symlink(store.root, join(store.root, "variants"));
  await expect(store.list()).rejects.toThrow("symlink");
  await expect(store.create("unsafe", "main", main.hash)).rejects.toThrow(
    "symlink",
  );
});

test("PDF compilation produces an artifact and cleans failed or cancelled work", async () => {
  const store = await fixture();
  const compiled = await compilePdf(
    store,
    "main",
    new AbortController().signal,
  );
  expect((await readFile(compiled.pdf)).subarray(0, 5).toString()).toBe(
    "%PDF-",
  );
  expect((await store.read("main")).source).toBe(source);
  const before = await readdir(await store.workDirectory());
  const controller = new AbortController();
  controller.abort();
  await expect(compilePdf(store, "main", controller.signal)).rejects.toThrow();
  const current = await store.read("main");
  await store.save(
    "main",
    current.hash,
    source.replace("Engineer", "\\unknownResumeCommand"),
  );
  await expect(
    compilePdf(store, "main", new AbortController().signal),
  ).rejects.toThrow("compilation failed");
  expect(await readdir(await store.workDirectory())).toEqual(before);
}, 30_000);

test("MCP initialization, schemas, edits, and errors work through the protocol", async () => {
  const store = await fixture();
  const server = createServer(store);
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toHaveLength(7);
    const read = await client.callTool({ name: "read_resume", arguments: {} });
    const data = z
      .object({ hash: z.string(), source: z.string() })
      .parse(read.structuredContent);
    expect(data.source).toBe(source);
    const save = await client.callTool({
      name: "save_resume",
      arguments: {
        id: "main",
        expectedHash: data.hash,
        source: source.replace("Engineer", "Edited"),
      },
    });
    expect(save.isError).not.toBe(true);
    const stale = await client.callTool({
      name: "save_resume",
      arguments: { id: "main", expectedHash: data.hash, source },
    });
    expect(stale.isError).toBe(true);
    const exported = await client.callTool({
      name: "export_resume_pdf",
      arguments: { id: "main" },
    });
    expect(exported.isError).not.toBe(true);
    const content = z.array(z.unknown()).parse(exported.content);
    const embedded = content
      .map((item) =>
        z
          .object({
            type: z.literal("resource"),
            resource: z.object({
              mimeType: z.literal("application/pdf"),
              blob: z.string(),
            }),
          })
          .safeParse(item),
      )
      .find((item) => item.success);
    if (!embedded?.success) throw new Error("Missing embedded PDF resource");
    expect(
      Buffer.from(embedded.data.resource.blob, "base64")
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
  } finally {
    await client.close();
    await server.close();
  }
});

test("Bun stdio process serves tools without contaminating stdout", async () => {
  const store = await fixture();
  const client = new Client({ name: "stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../src/main.ts"), "--repo", store.root],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "list_resumes",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(
      z
        .object({ resumes: z.array(z.object({ id: z.string() })) })
        .parse(result.structuredContent).resumes,
    ).toEqual([expect.objectContaining({ id: "main" })]);
  } finally {
    await client.close();
  }
});
