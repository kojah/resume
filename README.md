# Résumé MCP

This private repository holds `resume.tex`, the main résumé, and its checked-in
`resume.pdf`. It also provides a Bun + TypeScript stdio MCP server for reading,
editing, tailoring, comparing, and compiling the résumé.

## Run

Requirements: Bun 1.4 or later and a TeX installation providing `pdflatex` and the
packages used by the résumé (including `geometry`, `enumitem`, `hyperref`,
`xcolor`, and `titlesec`).

```sh
bun install --frozen-lockfile
bun run start --repo /absolute/path/to/resume
```

`RESUME_REPO` can replace `--repo`. The checkout is always explicit; the server
does not search your machine for résumés. It communicates over stdin/stdout and
writes startup errors to stderr. There is no HTTP listener or external AI call.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "resume": {
      "command": "/absolute/path/to/bun",
      "args": [
        "/absolute/path/to/resume/src/main.ts",
        "--repo",
        "/absolute/path/to/resume"
      ]
    }
  }
}
```

For clients on another machine, run this command through `ssh -T` on the machine
holding the checkout and TeX installation. Use absolute paths, with SSH
authentication configured in advance. The PDF path returned by compilation is
on that machine; `export_resume_pdf` transfers its contents through MCP.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_resumes` | List the main résumé and named variants with hashes and sections. |
| `read_resume` | Read complete LaTeX source, section names, and its SHA-256 hash. |
| `save_resume` | Save complete source with an exact `expectedHash` concurrency check. |
| `create_variant` | Copy a source into a new variant; never overwrite an existing one. |
| `diff_resume` | Compare a variant against `main` or another variant. |
| `compile_resume` | Compile a source snapshot and return its PDF path and source hash. |
| `export_resume_pdf` | Compile and return an embedded PDF resource, suitable for remote clients. |

The original résumé has ID `main`. Variants have lowercase IDs such as
`backend-engineer` and are stored as `variants/backend-engineer.tex`. IDs accept
letters, numbers, and hyphens only, with a maximum of 64 characters. Section
names are extracted from simple `\section{Title}` / `\section*{Title}` commands;
they are navigation hints rather than a general LaTeX parser.

A typical workflow:

1. Call `read_resume` for `main` and use its facts as the source of truth.
2. Call `create_variant` with `id`, `from: "main"`, and the returned `expectedHash`.
3. Read the variant, tailor its source, and call `save_resume` with that variant's
   current hash. Do not invent experience, credentials, or metrics.
4. Call `diff_resume` to review changes, then `compile_resume` or
   `export_resume_pdf` to get the result.

Source edits and variant creation use a shared filesystem lock and atomic
publication. Stale edits fail instead of silently overwriting another client's
changes. These protections coordinate MCP instances; external editors do not
participate in the lock. A process crash can leave `.resume-mcp/write-lock`:
remove that directory only after verifying no writer is running.

Tools never commit, push, publish, or send the résumé to a third party. Source
changes remain ordinary working-tree changes for review. The server does not
rewrite the checked-in `resume.pdf`.

## PDF builds

Each build copies the selected source into a fresh ignored
`.resume-mcp/build-*` directory and runs `pdflatex` twice for references. It uses
`-no-shell-escape`, restrictive TeX file-access settings, a 30-second timeout
per pass, and request cancellation. Failed builds are removed. Successful
builds retain their PDF, source snapshot, and logs; delete their directories
when no longer needed. Sources are limited to 256 KiB and returned PDFs to 8 MiB.

Only the selected `.tex` file is copied: external images, custom `.sty` files,
and other relative includes are not currently supported. TeX is executable
input, and these settings are not a general sandbox. Use this local server only
with trusted résumé content and trusted MCP clients. Exporting the PDF exposes
its contents to the connected client.

## Development

```sh
bun run check
bun run lint
bun test
bun run build
```

The project uses strict TypeScript **7.0.2**, executed by `tsc` through the
`@typescript/native` package alias, and Biome for formatting and linting. The
Bun build emits `dist/resume-mcp.js`, runnable with `bun`. Bun is the supported
runtime; there is no Node compatibility claim.

Dependencies are pinned in `package.json` and `bun.lock`. The server uses the
[official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk),
Zod for runtime tool-input validation, and `diff` for unified diffs. Tests cover
store behavior, conflict handling, path restrictions, real TeX compilation,
MCP tool calls, and the Bun stdio entry point. No TypeScript `any` or unsafe
double assertions are used.
