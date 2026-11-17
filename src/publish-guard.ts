/**
 * Publish guard and upload boundary. Nothing in this repository uploads: the only Uploader here is
 * FakeUploader, for tests. A real adapter (for example a pinning service's RPC `dag/import`) is a
 * separate, approved step; it implements Uploader and is called only through publishDirectory or
 * publishObject, so every upload passes the guard first (kit apply-engineering-guidelines,
 * rules/external-dependency-boundaries.md, "Adapter Boundary for Migrations").
 *
 * A publication is, per run, one publish folder, and once, the named Parquet objects
 * (publish-named-objects.ts), each uploaded as its own CAR.
 *
 * The publish folder holds exactly artifact-manifest.json and coverage.json. The guard refuses:
 * - any other file in the folder, and any file over 1 MB (1,000,000 bytes), files and the CAR alike;
 * - a run manifest: by name (run_manifest.json or any name with "run manifest" in it), and wherever it
 *   appears: as a folder file under another name (by its keys, also when embedded as a value or as
 *   escaped text), as an entry of the artifact manifest, or as an object;
 * - any Parquet file in the folder, by name or by its PAR1 magic bytes;
 * - coverage.json when the artifact manifest does not list it with these exact bytes (size, sha256,
 *   CID and codec);
 * - an artifact-manifest.json that is not the folder's own manifest, lists itself, lists an object that
 *   is neither coverage.json nor a named object (with the named object's exact CID, size, codec and
 *   sha256), or leaves out coverage.json or a named object;
 * - a CAR that is not the deterministic CAR of exactly the folder's files with the expected root.
 *
 * An object passes only when its name, size and sha256 are a named object's exactly, and its CAR is
 * the deterministic CAR of those bytes rooted at the named CID. Parquet and the 1 MB limit are lifted
 * for those bytes alone.
 */
import {
  bytesCidCodec,
  directoryCar,
  fileCar,
  sha256Hex,
  type Codec,
} from "./ipfs-unixfs.ts";
import { NAMED_OBJECTS, type NamedObject } from "./publish-named-objects.ts";

/** The publish limit: 1 MB (1,000,000 bytes) per publish-folder file, and for the folder's CAR. */
export const MAX_PUBLISH_BYTES = 1_000_000;

/** The only files a publish folder may hold. */
export const PUBLISH_FOLDER_FILES = [
  "artifact-manifest.json",
  "coverage.json",
] as const;

/** One published object as the artifact manifest lists it, in this key order. */
export type PublishedObject = {
  cid: string;
  name: string;
  size: number;
  codec: Codec;
  sha256: string;
};
export const PUBLISHED_OBJECT_KEYS = [
  "cid",
  "name",
  "size",
  "codec",
  "sha256",
] as const;

/** artifact-manifest.json: every published object of the run except itself. */
export type ArtifactManifest = { objects: PublishedObject[] };

export type Candidate = { name: string; bytes: Uint8Array };
export type Refusal = { name: string; reason: string };

const RUN_MANIFEST_REASON = "a run manifest is never published";

/** A name that says run manifest (run_manifest.json, run-manifest.json, RunManifest.json, ...). */
export function isRunManifestName(name: string): boolean {
  return /run[\s_.-]*manifest/i.test(name);
}

// Every recorded run manifest has run_id and these keys; coverage.json and the artifact manifest
// never use them.
const RUN_MANIFEST_KEYS = [
  "readiness",
  "row_counts",
  "limitations",
  "rebuild",
  "files",
  "scope",
  "cache",
  "permit_caches",
  "build_digest",
];
// The same, on the text, so a run manifest stored as an escaped string value is found too.
const RUN_ID_TEXT = /\\*"run_id\\*"\s*:/;
const RUN_MANIFEST_KEY_TEXT =
  /\\*"(readiness|row_counts|limitations|rebuild|permit_caches|build_digest)\\*"\s*:/;

function hasRunManifestShape(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasRunManifestShape);
  if (!v || typeof v !== "object") return false;
  const keys = Object.keys(v);
  if (
    keys.includes("run_id") &&
    RUN_MANIFEST_KEYS.some((k) => keys.includes(k))
  )
    return true;
  return Object.values(v).some(hasRunManifestShape);
}

/** True when the bytes hold a run manifest, whole or embedded, under any name. */
export function holdsRunManifest(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  if (RUN_ID_TEXT.test(text) && RUN_MANIFEST_KEY_TEXT.test(text)) return true;
  try {
    return hasRunManifestShape(JSON.parse(text));
  } catch {
    return false;
  }
}

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

/** Refusals for one publish-folder file against the folder's artifact manifest (empty when it may be published). */
export function guardFile(
  c: Candidate,
  manifest: ArtifactManifest,
  manifestBytes: Uint8Array,
): Refusal[] {
  const out: Refusal[] = [];
  const refuse = (reason: string) => out.push({ name: c.name, reason });
  if (isRunManifestName(c.name)) refuse(RUN_MANIFEST_REASON);
  else if (holdsRunManifest(c.bytes))
    refuse(`holds a run manifest; ${RUN_MANIFEST_REASON}`);
  if (!(PUBLISH_FOLDER_FILES as readonly string[]).includes(c.name))
    refuse(
      `not a publish-folder file (only ${PUBLISH_FOLDER_FILES.join(" and ")})`,
    );
  if (isParquet(c))
    refuse("Parquet is never in a publish folder (only as a named object)");
  if (c.bytes.length > MAX_PUBLISH_BYTES)
    refuse(`over 1 MB (${c.bytes.length} bytes > ${MAX_PUBLISH_BYTES})`);
  if (c.name === "artifact-manifest.json") {
    if (sha256Hex(c.bytes) !== sha256Hex(manifestBytes))
      refuse("not the folder's artifact manifest");
    return out;
  }
  if (c.name !== "coverage.json") return out;
  const entry = manifest.objects.find((o) => o?.name === c.name);
  if (!entry) refuse("not listed in the artifact manifest");
  else if (entry.size !== c.bytes.length || entry.sha256 !== sha256Hex(c.bytes))
    refuse("bytes differ from the artifact manifest's size and sha256");
  return out;
}

/** Refusals for the artifact manifest's object list (empty when it lists exactly what may be published). */
export function guardManifest(
  manifest: ArtifactManifest,
  named: readonly NamedObject[] = NAMED_OBJECTS,
): Refusal[] {
  const out: Refusal[] = [];
  const at = (o: unknown, i: number) => {
    const n =
      o && typeof o === "object" ? (o as { name?: unknown }).name : null;
    return `artifact-manifest.json objects[${i}]${typeof n === "string" ? ` (${n})` : ""}`;
  };
  const seen = new Set<string>();
  manifest.objects.forEach((o, i) => {
    const where = at(o, i);
    const keys = o && typeof o === "object" ? Object.keys(o) : [];
    if (JSON.stringify(keys) !== JSON.stringify(PUBLISHED_OBJECT_KEYS)) {
      out.push({
        name: where,
        reason: `keys must be exactly ${PUBLISHED_OBJECT_KEYS.join(", ")}`,
      });
      return;
    }
    if (seen.has(o.name))
      out.push({ name: where, reason: "listed more than once" });
    seen.add(o.name);
    if (isRunManifestName(o.name))
      out.push({ name: where, reason: RUN_MANIFEST_REASON });
    else if (o.name === "artifact-manifest.json")
      out.push({ name: where, reason: "the artifact manifest lists itself" });
    else if (o.name === "coverage.json") return;
    else {
      const n = named.find((x) => x.name === o.name);
      if (!n)
        out.push({
          name: where,
          reason: "not a publishable object (coverage.json or a named object)",
        });
      else if (
        o.cid !== n.cid ||
        o.size !== n.size ||
        o.codec !== n.codec ||
        o.sha256 !== n.sha256
      )
        out.push({
          name: where,
          reason: "not the named object's exact CID, size, codec and sha256",
        });
    }
  });
  for (const required of ["coverage.json", ...named.map((n) => n.name)])
    if (!seen.has(required))
      out.push({
        name: "artifact-manifest.json",
        reason: `does not list ${required}`,
      });
  return out;
}

export type DirectoryCandidate = {
  files: Candidate[];
  root: string;
  car: Uint8Array;
};

/** Every refusal for a publish folder and its CAR (empty when it may be uploaded). */
export async function guardDirectory(
  d: DirectoryCandidate,
  named: readonly NamedObject[] = NAMED_OBJECTS,
): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const names = d.files.map((f) => f.name).sort();
  const expected = [...PUBLISH_FOLDER_FILES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    out.push({
      name: "(directory)",
      reason: `files must be exactly ${expected.join(", ")}; got ${names.join(", ")}`,
    });
  const mf = d.files.find((f) => f.name === "artifact-manifest.json");
  if (!mf) {
    for (const f of d.files)
      out.push(...guardFile(f, { objects: [] }, new Uint8Array()));
    return out;
  }
  // A malformed manifest is refused, and the other files are still checked on their own.
  const malformed = (reason: string) => {
    out.push({ name: mf.name, reason });
    for (const f of d.files)
      if (f !== mf) out.push(...guardFile(f, { objects: [] }, mf.bytes));
    return out;
  };
  let manifest: ArtifactManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(mf.bytes),
    ) as ArtifactManifest;
  } catch {
    return malformed("not valid JSON");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    JSON.stringify(Object.keys(manifest)) !== JSON.stringify(["objects"]) ||
    !Array.isArray(manifest.objects)
  )
    return malformed("must be { objects: [...] }");
  out.push(...guardManifest(manifest, named));
  for (const f of d.files) out.push(...guardFile(f, manifest, mf.bytes));
  const coverage = d.files.find((f) => f.name === "coverage.json");
  const entry = manifest.objects.find((o) => o?.name === "coverage.json");
  if (coverage && entry) {
    const { cid, codec } = await bytesCidCodec(coverage.bytes);
    if (entry.cid !== cid || entry.codec !== codec)
      out.push({
        name: "coverage.json",
        reason: "CID or codec differs from the artifact manifest",
      });
  }
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

export type ObjectCandidate = {
  name: string;
  bytes: Uint8Array;
  root: string;
  car: Uint8Array;
};

/** Every refusal for one object and its CAR (empty only for a named object's exact bytes). */
export async function guardObject(
  o: ObjectCandidate,
  named: readonly NamedObject[] = NAMED_OBJECTS,
): Promise<Refusal[]> {
  if (isRunManifestName(o.name))
    return [{ name: o.name, reason: RUN_MANIFEST_REASON }];
  const n = named.find((x) => x.name === o.name);
  if (!n) return [{ name: o.name, reason: "not a named object" }];
  if (o.bytes.length !== n.size || sha256Hex(o.bytes) !== n.sha256)
    return [
      {
        name: o.name,
        reason: `bytes are not the named object's (size ${n.size}, sha256 ${n.sha256})`,
      },
    ];
  const out: Refusal[] = [];
  if (o.root !== n.cid)
    out.push({ name: "(car)", reason: "root is not the named object's CID" });
  const rebuilt = await fileCar(new Blob([new Uint8Array(o.bytes)]));
  if (rebuilt.root !== n.cid)
    out.push({ name: o.name, reason: "bytes do not give the named CID" });
  if (rebuilt.car_sha256 !== sha256Hex(o.car))
    out.push({
      name: "(car)",
      reason: "CAR is not the deterministic CAR of these bytes",
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

async function importChecked(
  car: Uint8Array,
  root: string,
  uploader: Uploader,
): Promise<{ root: string }> {
  const res = await uploader.importCar(car, root);
  if (res.root !== root)
    throw new Error(`uploader reported root ${res.root}, expected ${root}`);
  return res;
}

/** The only way to upload a publish folder: the guard runs first, and the service's root must match. */
export async function publishDirectory(
  d: DirectoryCandidate,
  uploader: Uploader,
  named: readonly NamedObject[] = NAMED_OBJECTS,
): Promise<{ root: string }> {
  const refusals = await guardDirectory(d, named);
  if (refusals.length) throw new PublishRefused(refusals);
  return importChecked(d.car, d.root, uploader);
}

/** The only way to upload an object: the guard runs first, and the service's root must match. */
export async function publishObject(
  o: ObjectCandidate,
  uploader: Uploader,
  named: readonly NamedObject[] = NAMED_OBJECTS,
): Promise<{ root: string }> {
  const refusals = await guardObject(o, named);
  if (refusals.length) throw new PublishRefused(refusals);
  return importChecked(o.car, o.root, uploader);
}
