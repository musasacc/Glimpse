import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A "show me N versions of this element" request: the agent writes candidates, the human picks one. */
export interface VariantJob {
  id: string;
  /** Where the element starts in the source ("file:line:col"), when known. */
  src?: string;
  /** Human-readable element label, e.g. `button "Order now"`. */
  label: string;
  count: number;
  hint?: string;
  createdAt: string;
  /** Variants (1-based) whose folder has at least one file. */
  ready: number[];
  /** The handoff that asked the agent for them. */
  seq?: number;
}

export const VARIANT_COUNTS = [2, 3, 4] as const;

/**
 * Variant jobs, persisted in `.glimpse/variants/jobs.json`. The agent writes
 * variant k of job v1 into `.glimpse/variants/v1/<k>/`, mirroring the project's
 * relative paths; files it doesn't write there come from the project.
 */
export class Variants {
  readonly root: string;
  private jobs: VariantJob[] = [];
  /** Ids are never reused, so a late write for a discarded job can't leak into a new one. */
  private next = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.root = join(dir, ".glimpse", "variants");
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(join(this.root, "jobs.json"), "utf8")) as { next?: number; jobs?: VariantJob[] };
      this.jobs = (raw.jobs ?? []).filter((j) => typeof j?.id === "string" && /^v\d+$/.test(j.id));
      this.next = Math.max(Number(raw.next) || 1, ...this.jobs.map((j) => Number(j.id.slice(1)) + 1));
    } catch {
      // no jobs yet
    }
    // The agent may have written variants while Glimpse wasn't running.
    for (const job of this.jobs) await this.refreshReady(job.id);
  }

  list(): VariantJob[] {
    return [...this.jobs];
  }

  get(id: string): VariantJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  create(input: { src?: string; label: string; count: number; hint?: string }): Promise<VariantJob> {
    return this.exclusive(async () => {
      const job: VariantJob = { id: `v${this.next++}`, ...input, createdAt: new Date().toISOString(), ready: [] };
      // Empty folders up front, for agents whose write tools don't create directories.
      for (let k = 1; k <= job.count; k++) await mkdir(this.dir(job.id, k), { recursive: true });
      this.jobs.push(job);
      await this.save();
      return job;
    });
  }

  update(id: string, patch: Partial<Pick<VariantJob, "seq">>): Promise<void> {
    return this.exclusive(async () => {
      const job = this.get(id);
      if (!job) return;
      Object.assign(job, patch);
      await this.save();
    });
  }

  /** Recompute which variants have files. Resolves true when `ready` changed. */
  refreshReady(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const job = this.get(id);
      if (!job) return false;
      const ready: number[] = [];
      for (let k = 1; k <= job.count; k++) if ((await this.files(id, k, 1)).length > 0) ready.push(k);
      if (ready.join() === job.ready.join()) return false;
      job.ready = ready;
      await this.save();
      return true;
    });
  }

  /** Drop a job and its folder (after it was chosen or discarded). */
  remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const i = this.jobs.findIndex((j) => j.id === id);
      if (i < 0) return false;
      this.jobs.splice(i, 1);
      await this.save();
      // Retries: on Windows the file watcher can briefly hold the folder open.
      await rm(join(this.root, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return true;
    });
  }

  /** Folder of variant k of job `id`. */
  dir(id: string, k: number): string {
    return join(this.root, id, String(k));
  }

  /** Files the agent wrote for variant k, as project-relative paths with forward slashes. */
  async files(id: string, k: number, limit = Infinity): Promise<string[]> {
    const out: string[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (out.length >= limit) return;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(abs, entry.name), path);
        else if (entry.isFile()) out.push(path);
      }
    };
    await walk(this.dir(id, k), "");
    return out;
  }

  private async save(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, "jobs.json"), JSON.stringify({ next: this.next, jobs: this.jobs }, null, 2));
  }

  /** Resolves once every queued operation has finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * Split a path inside `.glimpse/variants/` (forward slashes) into job id,
 * variant number and the project-relative file path ("" for the folders themselves).
 */
export function parseVariantPath(rel: string): { id: string; k: number; path: string } | null {
  const m = /^(v\d+)\/(\d+)(?:\/(.*))?$/.exec(rel);
  return m ? { id: m[1]!, k: Number(m[2]), path: m[3] ?? "" } : null;
}

/** The instructions the agent gets for a variants job. */
export function variantsPrompt(job: VariantJob, project: { dir: string; entry: string }): string {
  const file = (job.src && /^(.+):\d+:\d+$/.exec(job.src)?.[1]) || project.entry;
  const where = job.src ? ` at ${job.src}` : "";
  const folder = `.glimpse/variants/${job.id}`;
  const abs = project.dir.split("\\").join("/").replace(/\/$/, "");
  return [
    `The human wants to compare design variants in Glimpse.`,
    "",
    `Create ${job.count} different design variants of ${job.label}${where}. Only that element and its styles may differ; keep everything else as it is.`,
    job.hint ? `Hint from the human: ${job.hint}` : "",
    "",
    `For each variant k = 1..${job.count}, write every file it changes into ${folder}/<k>/ using the same relative path as in the project,`,
    `e.g. ${folder}/2/${file} (absolute: ${abs}/${folder}/2/${file}). Write whole files, not diffs; files you don't write there are taken from the project.`,
    "Never modify the real project files. Glimpse shows the variants side by side as you write them; the human picks one and Glimpse copies it into the project.",
    "When you're done, wait for the human again (glimpse wait / glimpse_wait_for_done).",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n")
    .trim();
}
