/**
 * Artifact manifest of a recorded run, and the run's publishable directory.
 *
 * Rule: only artifacts without records are ever published. The publishable
 * directory of a run holds exactly four files:
 *   run_manifest.json       the recorded runs/<run_id>/run_manifest.json, byte for byte
 *   coverage.json           counts only, with the source attribution and the source limitations
 *   schema.json             the Parquet column names and types, labelled lexicon / not lexicon
 *   artifact-manifest.json  every file of the run with size, sha256 and UnixFS CID; the data files
 *                           are listed with published: false and the reason
 * The directory's own CID cannot be inside artifact-manifest.json (it depends on that file); it is
 * recorded next to the directory (see build-ipfs-artifacts.ts).
 *
 * "Every file of the run" means every file under the run's folders: runs/<run_id>/,
 * data/out/<run_id>/ and data/raw/<county>/<source>/<run_id>/. Files the run manifest lists outside
 * those folders (caches, the shared seed path) are listed under referenced_inputs with the size and
 * sha256 the run manifest recorded, not hashed again. data/work/<run_id>/ is build scratch and is
 * named under excluded.
 *
 * Nothing here writes to the run folders; they are read only.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { UNIXFS_PARAMS, type FileDigest } from "./ipfs-unixfs.ts";

export const PUBLISHABLE_FILES = [
  "artifact-manifest.json",
  "coverage.json",
  "run_manifest.json",
  "schema.json",
] as const;
export type PublishableName = (typeof PUBLISHABLE_FILES)[number];

/** The publish limit: 1 MB (1,000,000 bytes) per file, and for the directory's CAR. */
export const MAX_PUBLISH_BYTES = 1_000_000;

const RIGHTS =
  "republication rights unverified (docs/los-angeles-county-findings.md, section 7)";
const RECORDS_RULE =
  "holds records; only artifacts without records are published";

export type ArtifactEntry = {
  name: string;
  role: string;
  size: number;
  sha256: string;
  cid: string;
  codec: "file" | "directory";
  published: boolean;
  not_published_reason: string | null;
  same_bytes_as?: string;
};

export type ReferencedInput = {
  name: string;
  role: string | null;
  recorded_size: number | null;
  recorded_sha256: string | null;
  note: string;
};

export type ArtifactManifest = {
  artifact_manifest_version: 1;
  run_id: string;
  cid_kind: string;
  unixfs: typeof UNIXFS_PARAMS;
  publish_rule: string;
  publishable_directory: {
    files: string[];
    cid_note: string;
  };
  files: ArtifactEntry[];
  referenced_inputs: ReferencedInput[];
  excluded: string[];
};

/** Repo-relative paths (posix) of every file under the run's folders, sorted. */
export function listRunFiles(root: string, runId: string): string[] {
  const dirs = [`runs/${runId}`, `data/out/${runId}`];
  const raw = join(root, "data/raw");
  if (existsSync(raw))
    for (const county of readdirSync(raw).sort())
      for (const source of readdirSync(join(raw, county)).sort()) {
        const d = `data/raw/${county}/${source}/${runId}`;
        if (existsSync(join(root, d))) dirs.push(d);
      }
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const p = posix.join(rel, name);
      const st = statSync(join(root, p));
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
      else throw new Error(`${p}: not a regular file or directory`);
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) walk(d);
  return out.sort();
}

/** Role and publication decision for one run file (by its repo-relative path). */
export function classifyRunFile(
  path: string,
  runId: string,
): { role: string; published: boolean; reason: string | null } {
  const base = posix.basename(path);
  if (path === `runs/${runId}/run_manifest.json`)
    return {
      role: "run manifest (tool record; copied byte for byte into the publishable directory)",
      published: true,
      reason: null,
    };
  if (path.startsWith(`data/out/${runId}/`)) {
    if (base.endsWith(".parquet")) {
      const contractor = base.includes("contractor");
      return {
        role: "data table (Parquet)",
        published: false,
        reason: [RECORDS_RULE, RIGHTS]
          .concat(
            contractor
              ? ["personal-data adjacency (sole-proprietor business names)"]
              : [],
          )
          .join("; "),
      };
    }
    if (base.endsWith(".csv"))
      return {
        role: "runtime seed CSV (parcel IDs and situs addresses)",
        published: false,
        reason: `${RECORDS_RULE}; ${RIGHTS}`,
      };
    if (base === "radius-query-result.json")
      return {
        role: "radius query result (parcel rows)",
        published: false,
        reason: `${RECORDS_RULE}; ${RIGHTS}`,
      };
  }
  if (path.startsWith("data/raw/")) {
    if (/^page-\d+\.json$/.test(base))
      return {
        role: "raw source page (byte-preserved)",
        published: false,
        reason: `${RECORDS_RULE}; ${RIGHTS}`,
      };
    return {
      role: "raw download record (request URLs, counts, hashes)",
      published: false,
      reason:
        "not in the publishable set (run manifest, coverage, schema, artifact manifest)",
    };
  }
  return {
    role: "run file",
    published: false,
    reason:
      "not in the publishable set (run manifest, coverage, schema, artifact manifest)",
  };
}

type RecordedFile = {
  name?: string;
  path?: string;
  role?: string;
  size_bytes?: number;
  sha256?: string;
};

/** Files the run manifest lists outside the run folders (caches, the shared seed path). */
export function referencedInputs(
  runManifest: { files?: RecordedFile[] },
  runFiles: string[],
): ReferencedInput[] {
  const inRun = new Set(runFiles);
  return (runManifest.files ?? [])
    .filter((f) => f.path && !inRun.has(f.path))
    .map((f) => ({
      name: f.path as string,
      role: f.role ?? null,
      recorded_size: f.size_bytes ?? null,
      recorded_sha256: f.sha256 ?? null,
      note:
        f.path === "data/seeds/los-angeles.csv"
          ? "shared runtime path, overwritten by each later run; the per-run seed copy is in the files list"
          : "outside the run folders (a cache directory); recorded by the run manifest, not hashed again here",
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function buildArtifactManifest(args: {
  runId: string;
  runFiles: { path: string; digest: FileDigest }[];
  publishable: {
    name: Exclude<PublishableName, "artifact-manifest.json">;
    digest: FileDigest;
  }[];
  referenced: ReferencedInput[];
}): ArtifactManifest {
  const { runId } = args;
  const files: ArtifactEntry[] = [];
  const recordedManifest = `runs/${runId}/run_manifest.json`;
  for (const p of args.publishable) {
    const fromRun = p.name === "run_manifest.json";
    files.push({
      name: p.name,
      role:
        p.name === "run_manifest.json"
          ? "run manifest (the recorded tool record, byte for byte)"
          : p.name === "coverage.json"
            ? "coverage: counts only, source attribution and limitations"
            : "schema: Parquet column names and types, lexicon labels",
      ...p.digest,
      codec: "file",
      // A publishable file over the limit is listed as not published, so the manifest says what the
      // publish guard will do.
      published: p.digest.size <= MAX_PUBLISH_BYTES,
      not_published_reason:
        p.digest.size <= MAX_PUBLISH_BYTES
          ? null
          : `over the 1 MB publish limit (${p.digest.size} bytes > ${MAX_PUBLISH_BYTES})`,
      ...(fromRun ? { same_bytes_as: recordedManifest } : {}),
    });
  }
  for (const f of args.runFiles) {
    if (f.path === recordedManifest) continue; // listed once, as the publishable run_manifest.json
    const c = classifyRunFile(f.path, runId);
    files.push({
      name: f.path,
      role: c.role,
      ...f.digest,
      codec: "file",
      published: c.published,
      not_published_reason: c.reason,
    });
  }
  const manifestDigest = args.publishable.find(
    (p) => p.name === "run_manifest.json",
  )?.digest;
  const recorded = args.runFiles.find(
    (f) => f.path === recordedManifest,
  )?.digest;
  if (!manifestDigest || !recorded || manifestDigest.sha256 !== recorded.sha256)
    throw new Error(
      "the publishable run_manifest.json must be the recorded file, byte for byte",
    );
  return {
    artifact_manifest_version: 1,
    run_id: runId,
    cid_kind:
      "UnixFS CIDv1 of each file's raw bytes (not lexicon CIDs); rebuild with the unixfs settings below",
    unixfs: UNIXFS_PARAMS,
    publish_rule:
      "Only artifacts without records are published: the run manifest, coverage, schema and this manifest. Every data file is listed with published: false and the reason.",
    publishable_directory: {
      files: [...PUBLISHABLE_FILES],
      cid_note:
        "This file is inside the publishable directory, so the directory CID and its CAR are recorded next to it, not in it.",
    },
    files,
    referenced_inputs: args.referenced,
    excluded: [
      `data/work/${runId}/ (build scratch: staging files and the DuckDB database; not an output of the run)`,
    ],
  };
}

/** Deterministic JSON bytes: 2-space indent, trailing newline, key order as built. */
export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}
