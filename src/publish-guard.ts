/**
 * Publish guard and upload boundary. Nothing in this repository uploads: the only Uploader here is
 * FakeUploader, for tests. A real adapter (for example a pinning service's RPC `dag/import`) is a
 * separate, approved step; it implements Uploader and is called only through publishDirectory, so
 * every upload passes the guard first (kit apply-engineering-guidelines,
 * rules/external-dependency-boundaries.md, "Adapter Boundary for Migrations").
 *
 * The guard refuses:
 * - any file not marked published: true in the run's artifact manifest
 *   (artifact-manifest.json itself is accepted only when it is that same manifest);
 * - any Parquet file, by name or by its PAR1 magic bytes;
 * - anything over 1 MB (1,000,000 bytes), files and the CAR alike;
 * - a directory whose file set is not exactly the four publishable files;
 * - a CAR that is not the deterministic CAR of exactly those files with the expected root.
 */
import {
  MAX_PUBLISH_BYTES,
  PUBLISHABLE_FILES,
  type ArtifactManifest,
} from "./artifact-manifest.ts";
import { directoryCar, sha256Hex } from "./ipfs-unixfs.ts";

export { MAX_PUBLISH_BYTES };

export type Candidate = { name: string; bytes: Uint8Array };
export type Refusal = { name: string; reason: string };

function isParquet(c: Candidate): boolean {
  if (/\.parquet$/i.test(c.name)) return true;
  const b = c.bytes;
  const magic = (o: number) =>
    b.length >= o + 4 &&
    b[o] === 0x50 &&
    b[o + 1] === 0x41 &&
    b[o + 2] === 0x52 &&
    b[o + 3] === 0x31;
  return magic(0) || magic(b.length - 4);
}

/** Refusals for one file against the manifest (empty when it may be published). */
export function guardFile(
  c: Candidate,
  manifest: ArtifactManifest,
  manifestBytes: Uint8Array,
): Refusal[] {
  const out: Refusal[] = [];
  if (isParquet(c))
    out.push({ name: c.name, reason: "Parquet is never published" });
  if (c.bytes.length > MAX_PUBLISH_BYTES)
    out.push({
      name: c.name,
      reason: `over 1 MB (${c.bytes.length} bytes > ${MAX_PUBLISH_BYTES})`,
    });
  if (c.name === "artifact-manifest.json") {
    if (sha256Hex(c.bytes) !== sha256Hex(manifestBytes))
      out.push({ name: c.name, reason: "not the run's artifact manifest" });
    return out;
  }
  const entry = manifest.files.find((f) => f.name === c.name);
  if (!entry)
    out.push({ name: c.name, reason: "not listed in the artifact manifest" });
  else {
    if (entry.published !== true)
      out.push({
        name: c.name,
        reason: `not marked published (${entry.not_published_reason ?? "no reason"})`,
      });
    if (entry.sha256 !== sha256Hex(c.bytes))
      out.push({
        name: c.name,
        reason: "bytes differ from the artifact manifest's sha256",
      });
  }
  return out;
}

export type DirectoryCandidate = {
  files: Candidate[];
  root: string;
  car: Uint8Array;
};

/** Every refusal for a publishable directory and its CAR (empty when it may be uploaded). */
export async function guardDirectory(
  d: DirectoryCandidate,
): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const names = d.files.map((f) => f.name).sort();
  const expected = [...PUBLISHABLE_FILES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    out.push({
      name: "(directory)",
      reason: `files must be exactly ${expected.join(", ")}; got ${names.join(", ")}`,
    });
  const mf = d.files.find((f) => f.name === "artifact-manifest.json");
  if (!mf) return out;
  let manifest: ArtifactManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(mf.bytes),
    ) as ArtifactManifest;
  } catch {
    return [...out, { name: mf.name, reason: "not valid JSON" }];
  }
  if (!Array.isArray(manifest.files))
    return [...out, { name: mf.name, reason: "no files list" }];
  for (const f of d.files) out.push(...guardFile(f, manifest, mf.bytes));
  if (d.car.length > MAX_PUBLISH_BYTES)
    out.push({
      name: "(car)",
      reason: `over 1 MB (${d.car.length} bytes > ${MAX_PUBLISH_BYTES})`,
    });
  const rebuilt = await directoryCar(d.files);
  if (rebuilt.root !== d.root)
    out.push({ name: "(car)", reason: "root is not the CID of these files" });
  if (rebuilt.car_sha256 !== sha256Hex(d.car))
    out.push({
      name: "(car)",
      reason: "CAR is not the deterministic CAR of these files",
    });
  return out;
}

/** The upload boundary. Implementations import a CAR and report the root the service saw. */
export interface Uploader {
  importCar(car: Uint8Array, expectedRoot: string): Promise<{ root: string }>;
}

/** Test double: records what it was given; never touches the network. */
export class FakeUploader implements Uploader {
  readonly imported: { root: string; car_sha256: string; bytes: number }[] = [];
  async importCar(
    car: Uint8Array,
    expectedRoot: string,
  ): Promise<{ root: string }> {
    this.imported.push({
      root: expectedRoot,
      car_sha256: sha256Hex(car),
      bytes: car.length,
    });
    return { root: expectedRoot };
  }
}

export class PublishRefused extends Error {
  readonly refusals: Refusal[];
  constructor(refusals: Refusal[]) {
    super(
      `publish refused: ${refusals.map((r) => `${r.name}: ${r.reason}`).join("; ")}`,
    );
    this.refusals = refusals;
  }
}

/** The only way to call an Uploader: the guard runs first, and the service's root must match. */
export async function publishDirectory(
  d: DirectoryCandidate,
  uploader: Uploader,
): Promise<{ root: string }> {
  const refusals = await guardDirectory(d);
  if (refusals.length) throw new PublishRefused(refusals);
  const res = await uploader.importCar(d.car, d.root);
  if (res.root !== d.root)
    throw new Error(`uploader reported root ${res.root}, expected ${d.root}`);
  return res;
}
