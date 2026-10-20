import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";

const maxSourceBytes = 256 * 1024;
export function validateId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    throw new Error("Use a lowercase ID of 1–64 letters, digits, or hyphens.");
}
export function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
export function validateSource(source: string): void {
  if (Buffer.byteLength(source) > maxSourceBytes)
    throw new Error("Résumé source exceeds 256 KiB.");
  if (
    !source.includes("\\begin{document}") ||
    !source.includes("\\end{document}")
  )
    throw new Error("Source must contain a complete LaTeX document.");
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Expected a real directory, not a symlink.");
}
export interface ResumeDocument {
  id: string;
  source: string;
  hash: string;
  sections: string[];
}
// Owns a single explicitly selected checkout. Mutation locks are shared across
// MCP processes, and writes replace complete files atomically.
export class ResumeStore {
  private constructor(readonly root: string) {}
  static async open(root: string): Promise<ResumeStore> {
    const store = new ResumeStore(await realpath(root));
    await store.read("main");
    return store;
  }
  private path(id: string): string {
    validateId(id);
    return id === "main"
      ? join(this.root, "resume.tex")
      : join(this.root, "variants", `${id}.tex`);
  }
  async read(id: string): Promise<ResumeDocument> {
    const path = this.path(id);
    if (id !== "main") {
      const parent = await lstat(join(this.root, "variants"));
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error("Variants directory must not be a symlink.");
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxSourceBytes)
      throw new Error("Source must be a regular file under 256 KiB.");
    const source = await readFile(path, "utf8");
    validateSource(source);
    return {
      id,
      source,
      hash: sourceHash(source),
      sections: [...source.matchAll(/\\section\*?\{([^{}]+)\}/g)].map(
        (match) => match[1] ?? "",
      ),
    };
  }
  async list(): Promise<{ id: string; hash: string; sections: string[] }[]> {
    let names: string[] = [];
    try {
      const parent = await lstat(join(this.root, "variants"));
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error("Variants directory must not be a symlink.");
      names = await readdir(join(this.root, "variants"));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const ids = [
      "main",
      ...names
        .filter(
          (name) =>
            /^[a-z0-9][a-z0-9-]{0,63}\.tex$/.test(name) && name !== "main.tex",
        )
        .map((name) => name.slice(0, -4))
        .sort(),
    ];
    const results = [];
    for (const id of ids) {
      const { hash, sections } = await this.read(id);
      results.push({ id, hash, sections });
    }
    return results;
  }
  async workDirectory(): Promise<string> {
    const path = join(this.root, ".resume-mcp");
    await directory(path);
    return path;
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const lock = join(await this.workDirectory(), "write-lock");
    try {
      await mkdir(lock);
    } catch (error) {
      throw new Error(
        "A résumé write is already in progress; retry after it finishes. A crashed process may leave .resume-mcp/write-lock.",
        { cause: error },
      );
    }
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  private async write(id: string, source: string): Promise<ResumeDocument> {
    validateSource(source);
    const path = this.path(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return this.read(id);
  }
  async save(
    id: string,
    expectedHash: string,
    source: string,
  ): Promise<ResumeDocument> {
    return this.locked(async () => {
      const current = await this.read(id);
      if (current.hash !== expectedHash)
        throw new Error("Résumé changed; read it again before saving.");
      return this.write(id, source);
    });
  }
  async create(
    id: string,
    from: string,
    expectedHash: string,
  ): Promise<ResumeDocument> {
    validateId(id);
    if (id === "main")
      throw new Error("A variant cannot replace the main résumé.");
    return this.locked(async () => {
      const base = await this.read(from);
      if (base.hash !== expectedHash)
        throw new Error(
          "Source résumé changed; read it again before creating a variant.",
        );
      await directory(join(this.root, "variants"));
      const temporary = join(this.root, "variants", `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, base.source, { flag: "wx", mode: 0o600 });
        // link publishes the complete snapshot atomically and fails if the
        // destination exists, including when it is a dangling symlink.
        await link(temporary, this.path(id));
      } finally {
        await rm(temporary, { force: true });
      }
      return this.read(id);
    });
  }
  async diff(
    id: string,
    against: string,
  ): Promise<{ diff: string; hash: string; baseHash: string }> {
    const base = await this.read(against);
    const target = await this.read(id);
    return {
      diff: createTwoFilesPatch(
        `${against}.tex`,
        `${id}.tex`,
        base.source,
        target.source,
      ),
      hash: target.hash,
      baseHash: base.hash,
    };
  }
}
