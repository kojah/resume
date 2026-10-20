import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compilePdf } from "./pdf.ts";
import type { ResumeStore } from "./store.ts";

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .default("main");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function result(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
async function attempt(action: () => Promise<Record<string, unknown>>) {
  try {
    return result(await action());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            error instanceof Error ? error.message : "Résumé operation failed.",
        },
      ],
    };
  }
}
export function createServer(store: ResumeStore): McpServer {
  const server = new McpServer(
    { name: "resume", version: "1.0.0" },
    {
      instructions:
        "Read the main résumé as the factual source. Never invent experience, qualifications, or metrics. Create a separate variant for a job-specific résumé. Read its hash before saving. Saving does not commit or push. LaTeX is executable input: compile only trusted local résumé content.",
    },
  );
  server.registerTool(
    "list_resumes",
    {
      description:
        "List the main résumé and tailored variants with hashes and section names.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => attempt(async () => ({ resumes: await store.list() })),
  );
  server.registerTool(
    "read_resume",
    {
      description:
        "Read LaTeX source, sections, and the hash required for editing.",
      inputSchema: z.object({ id }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => attempt(async () => ({ ...(await store.read(id)) })),
  );
  server.registerTool(
    "save_resume",
    {
      description:
        "Save complete LaTeX source after verifying its current hash. Prefer a variant for job-specific edits; never invent facts. Does not commit or push.",
      inputSchema: z.object({
        id,
        expectedHash: hash,
        source: z.string().max(256 * 1024),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, expectedHash, source }) =>
      attempt(async () => {
        const saved = await store.save(id, expectedHash, source);
        return { id: saved.id, hash: saved.hash, sections: saved.sections };
      }),
  );
  server.registerTool(
    "create_variant",
    {
      description:
        "Copy a résumé to a new named variant without changing the main source. Existing variants are never overwritten.",
      inputSchema: z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        from: id,
        expectedHash: hash,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, from, expectedHash }) =>
      attempt(async () => ({
        ...(await store.create(id, from, expectedHash)),
      })),
  );
  server.registerTool(
    "diff_resume",
    {
      description:
        "Compare a variant's LaTeX with another résumé (main by default).",
      inputSchema: z.object({ id, against: id }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, against }) =>
      attempt(async () => ({ ...(await store.diff(id, against)) })),
  );
  server.registerTool(
    "compile_resume",
    {
      description:
        "Compile a source snapshot to PDF with pdflatex. Returns a local PDF path and source hash; leaves the checked-in resume.pdf untouched. Requires a local TeX installation.",
      inputSchema: z.object({ id }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id }, context) =>
      attempt(async () => ({
        ...(await compilePdf(store, id, context.mcpReq.signal)),
      })),
  );
  server.registerTool(
    "export_resume_pdf",
    {
      description:
        "Compile and return a PDF as an embedded MCP resource, plus its local path and source hash. Up to 8 MiB.",
      inputSchema: z.object({ id }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id }, context) => {
      try {
        const compiled = await compilePdf(store, id, context.mcpReq.signal);
        const blob = (await readFile(compiled.pdf)).toString("base64");
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(compiled) },
            {
              type: "resource" as const,
              resource: {
                uri: pathToFileURL(compiled.pdf).href,
                mimeType: "application/pdf",
                blob,
              },
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof Error ? error.message : "PDF export failed.",
            },
          ],
        };
      }
    },
  );
  return server;
}
