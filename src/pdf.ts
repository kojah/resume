import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResumeStore } from "./store.ts";

const maxOutput = 8 * 1024 * 1024;
export async function compilePdf(
  store: ResumeStore,
  id: string,
  signal: AbortSignal,
): Promise<{ id: string; sourceHash: string; pdf: string }> {
  const document = await store.read(id);
  signal.throwIfAborted();
  const directory = await mkdtemp(join(await store.workDirectory(), "build-"));
  let keep = false;
  try {
    await writeFile(join(directory, "resume.tex"), document.source, {
      mode: 0o600,
    });
    // Compile a snapshot, never the working source. Kpathsea's paranoid modes
    // disallow absolute/parent reads and writes; shell escape stays disabled.
    for (let pass = 0; pass < 2; pass++) {
      signal.throwIfAborted();
      const child = Bun.spawn(
        [
          "pdflatex",
          "-no-shell-escape",
          "-halt-on-error",
          "-interaction=batchmode",
          "resume.tex",
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            openin_any: "p",
            openout_any: "p",
            max_print_line: "1000",
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const stop = () => child.kill();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, 30_000);
      signal.addEventListener("abort", stop, { once: true });
      try {
        if (signal.aborted) stop();
        const code = await child.exited;
        signal.throwIfAborted();
        if (timedOut)
          throw new Error("PDF compilation timed out after 30 seconds.");
        if (code !== 0) {
          const log = await readFile(
            join(directory, "resume.log"),
            "utf8",
          ).catch(() => "No compiler log available.");
          throw new Error(`LaTeX compilation failed. ${log.slice(-4000)}`);
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    }
    const pdf = join(directory, "resume.pdf");
    const info = await stat(pdf);
    if (info.size > maxOutput) throw new Error("PDF exceeds 8 MiB.");
    keep = true;
    return { id, sourceHash: document.hash, pdf };
  } finally {
    if (!keep) await rm(directory, { recursive: true, force: true });
  }
}
