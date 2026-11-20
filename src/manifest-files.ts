/** Manifest file entries (name, path, size, sha256, row count). Shared by build-outputs.ts and tests. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface FileEntry {
  name: string;
  path: string;
  role: string;
  publishable_after_approval: boolean;
  size_bytes: number;
  sha256: string;
  row_count: number | null;
  copy_of?: string;
  note?: string;
}

export function fileEntry(
  path: string,
  rowCount: number | null,
  role: string,
  publishable: boolean,
): FileEntry {
  const bytes = readFileSync(path);
  return {
    name: basename(path),
    path,
    role,
    publishable_after_approval: publishable,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    row_count: rowCount,
  };
}

/**
 * The per-run seed is the run's artifact. The shared runtime seed path is recorded as a copy
 * of it; it must have the same digest, and the next run overwrites it.
 */
export function seedFileEntries(
  perRunSeedPath: string,
  sharedSeedPath: string,
  rowCount: number,
): [FileEntry, FileEntry] {
  const artifact = fileEntry(
    perRunSeedPath,
    rowCount,
    "runtime seed CSV for this run (parcel_id, source_identifier, situs_address + extras)",
    false,
  );
  const shared = fileEntry(
    sharedSeedPath,
    rowCount,
    "shared runtime seed path read by the ingest feeder",
    false,
  );
  if (shared.sha256 !== artifact.sha256)
    throw new Error(
      `${sharedSeedPath} is not a byte copy of ${perRunSeedPath}`,
    );
  return [
    artifact,
    {
      ...shared,
      copy_of: perRunSeedPath,
      note: "copy of the per-run seed; the next run overwrites this path, so its digest is only valid for this run",
    },
  ];
}

/**
 * The seed entries as the recorded build writes them, without reading the shared path: the per-run
 * seed (already hashed, at its recorded path) and the shared runtime seed path as its byte copy.
 * The build copies the file afterwards and checks the copy's sha256 against this entry; a dry run
 * records the same entries without copying.
 */
export function recordedSeedFileEntries(
  perRun: FileEntry,
  sharedSeedPath: string,
): [FileEntry, FileEntry] {
  return [
    perRun,
    {
      ...perRun,
      name: basename(sharedSeedPath),
      path: sharedSeedPath,
      role: "shared runtime seed path read by the ingest feeder",
      copy_of: perRun.path,
      note: "copy of the per-run seed; the next run overwrites this path, so its digest is only valid for this run",
    },
  ];
}
