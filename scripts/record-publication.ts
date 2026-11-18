/**
 * Append one published run to runs/publications.jsonl: {"run_id","manifest_cid","folder_cid","published_at"}, in that
 * key order. published_at is the UTC date or time given, or now. Refuses (and writes nothing): a run ID not in
 * runs/run_history.jsonl, a run already recorded, a CID that is not a CIDv1 in base32, a malformed existing file,
 * and identifiers that are not the run's publication record: runs/<run_id>/publication/directory.json must exist,
 * name the run, and hold the manifest CID as artifact_manifest.cid and the folder CID as directory_cid.
 * Append only: after writing it checks that the file's earlier bytes are unchanged and that exactly the new line
 * was added. Prints the line; never commits.
 * Usage: node scripts/record-publication.ts <run_id> <manifest_cid> <folder_cid> [published_at]
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  type PathLike,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readHistory } from "../src/run-history.ts";
import {
  parsePublications,
  publicationLine,
  publicationRecordPath,
  publicationRecordProblem,
  type Publication,
} from "../src/publications.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const PUBLICATIONS_PATH = `${REPO}runs/publications.jsonl`;
export const HISTORY_PATH = `${REPO}runs/run_history.jsonl`;
/** The folder holding runs/<run_id>/publication/directory.json. */
export const RUNS_PATH = `${REPO}runs`;

export interface RecordInput {
  run_id: string;
  /** The CID of the run's artifact-manifest.json. */
  manifest_cid: string;
  /** The CID of the run's publish folder. */
  folder_cid: string;
  /** A UTC date or time; omitted: now (an ISO time). */
  published_at?: string;
}

/** Appends the publication's line and returns it; throws, writing nothing, on any refusal. */
export function recordPublication(
  input: RecordInput,
  paths: { publications: string; history: string; runs: string } = {
    publications: PUBLICATIONS_PATH,
    history: HISTORY_PATH,
    runs: RUNS_PATH,
  },
  now: () => Date = () => new Date(),
): string {
  if (!existsSync(paths.publications))
    throw new Error(
      `${paths.publications} does not exist (it is tracked; nothing is created)`,
    );
  if (!existsSync(paths.history))
    throw new Error(`${paths.history} does not exist`);
  const before = readFileSync(paths.publications);
  const recorded = parsePublications(before.toString("utf8"));
  const runs = new Set(readHistory(paths.history).map((r) => r.run_id));
  if (!runs.has(input.run_id))
    throw new Error(
      `run ${input.run_id} is not in ${paths.history}; nothing appended`,
    );
  if (recorded.some((p) => p.run_id === input.run_id))
    throw new Error(
      `run ${input.run_id} is already recorded in ${paths.publications}; nothing appended`,
    );
  const p: Publication = {
    run_id: input.run_id,
    manifest_cid: input.manifest_cid,
    folder_cid: input.folder_cid,
    published_at: input.published_at ?? now().toISOString(),
  };
  const line = publicationLine(p); // throws on a CID or date that is not valid
  const recordPath = `${paths.runs}/${publicationRecordPath(input.run_id)}`;
  if (!existsSync(recordPath))
    throw new Error(
      `${recordPath} does not exist: the run has no publication record; nothing appended`,
    );
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    throw new Error(`${recordPath}: not JSON; nothing appended`);
  }
  const problem = publicationRecordProblem(p, record);
  if (problem) throw new Error(`${recordPath}: ${problem}; nothing appended`);
  appendFileSync(paths.publications, line);
  verifyAppend(paths.publications, before, line);
  return line;
}

/** The file is the earlier bytes, unchanged, followed by exactly the new line. */
export function verifyAppend(path: PathLike, before: Buffer, line: string) {
  const after = readFileSync(path);
  const added = Buffer.from(line, "utf8");
  if (
    after.length !== before.length + added.length ||
    !after.subarray(0, before.length).equals(before) ||
    !after.subarray(before.length).equals(added)
  )
    throw new Error(
      `${String(path)}: after appending, the earlier bytes or the new line differ (append-only check failed)`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [run_id, manifest_cid, folder_cid, published_at, ...rest] =
    process.argv.slice(2);
  if (!run_id || !manifest_cid || !folder_cid || rest.length) {
    console.error(
      "usage: node scripts/record-publication.ts <run_id> <manifest_cid> <folder_cid> [published_at]",
    );
    process.exit(2);
  }
  try {
    const line = recordPublication({
      run_id,
      manifest_cid,
      folder_cid,
      published_at,
    });
    process.stdout.write(
      `appended to runs/publications.jsonl (not committed):\n${line}`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
