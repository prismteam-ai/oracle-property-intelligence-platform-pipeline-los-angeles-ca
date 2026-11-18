/**
 * runs/publications.jsonl: one line per published run, appended by scripts/record-publication.ts and never
 * rewritten. Each line is {"run_id","manifest_cid","folder_cid","published_at"} in that key order: the run, the CID
 * of its artifact manifest (a published file of its own, outside the folder), the CID of its publish folder, and the
 * UTC date (or time) it was published. No CAR identifier is recorded. The file is
 * tracked and starts empty. The Explorer bundles it at build (its run history's "Published (identifier)" column);
 * the agent and the data API never read it.
 *
 * Pure (no Node imports): the record tool, the Explorer's build check and the Explorer page share it.
 */
import { GATEWAYS, gatewayPathUrl } from "./gateways.ts";

export const PUBLICATION_KEYS = [
  "run_id",
  "manifest_cid",
  "folder_cid",
  "published_at",
] as const;

export interface Publication {
  run_id: string;
  /** The run's artifact manifest (artifact-manifest.json), published as its own file. */
  manifest_cid: string;
  /** The run's publish folder (coverage.json). */
  folder_cid: string;
  /** A UTC date (YYYY-MM-DD) or time (YYYY-MM-DDTHH:MM:SS[.sss]Z). */
  published_at: string;
}

/** A link to a published file on one gateway: the gateway's host (the link's label) and the path-form URL. */
export interface GatewayLink {
  host: string;
  url: string;
}

/**
 * The links the Explorer gives a run's artifact manifest: one per gateway, on the first two gateways of the shared
 * list (src/gateways.ts), in path form, each labelled by its host.
 */
export const manifestLinks = (manifestCid: string): GatewayLink[] =>
  GATEWAYS.slice(0, 2).map((g) => ({
    host: g.host,
    url: gatewayPathUrl(g, manifestCid),
  }));

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding; null when a character is outside the alphabet or the tail is not zero. */
function base32Decode(s: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
    value &= (1 << bits) - 1;
  }
  return bits < 5 && value === 0 ? Uint8Array.from(out) : null;
}

/** An unsigned varint at `at`: [value, next offset], or null (truncated or longer than 9 bytes). */
function varint(b: Uint8Array, at: number): [number, number] | null {
  let v = 0;
  for (let i = 0; i < 9 && at + i < b.length; i++) {
    const byte = b[at + i]!;
    v += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return [v, at + i + 1];
  }
  return null;
}

/**
 * A CIDv1 in multibase base32 ("b", lowercase): version 1, any codec, a sha2-256 multihash (32 bytes) and nothing
 * after it. The CIDs this pipeline builds (UnixFS folders and files, src/ipfs-unixfs.ts) all have this form.
 */
export function isCidV1Base32(s: string): boolean {
  if (!/^b[a-z2-7]+$/.test(s)) return false;
  const b = base32Decode(s.slice(1));
  if (!b) return false;
  const version = varint(b, 0);
  if (!version || version[0] !== 1) return false;
  const codec = varint(b, version[1]);
  if (!codec) return false;
  const hash = varint(b, codec[1]);
  if (!hash || hash[0] !== 0x12) return false;
  const len = varint(b, hash[1]);
  return !!len && len[0] === 32 && b.length - len[1] === 32;
}

const DATE = /^\d{4}-\d\d-\d\d$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;

/** A real UTC date (YYYY-MM-DD) or time (YYYY-MM-DDTHH:MM:SS[.sss]Z); no offsets, no local times. */
export function isUtcDateOrTime(s: string): boolean {
  if (DATE.test(s)) {
    const t = Date.parse(`${s}T00:00:00.000Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }
  if (TIME.test(s)) {
    const full = s.includes(".") ? s : s.replace("Z", ".000Z");
    const t = Date.parse(full);
    return !Number.isNaN(t) && new Date(t).toISOString() === full;
  }
  return false;
}

const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]*$/;

/** One line's fields, checked: why it is not a publication line, or null when it is one. */
export function publicationProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "not a JSON object";
  const keys = Object.keys(value);
  if (keys.join(",") !== PUBLICATION_KEYS.join(","))
    return `keys must be exactly ${PUBLICATION_KEYS.join(", ")} in that order (got ${keys.join(", ") || "none"})`;
  const p = value as Record<string, unknown>;
  for (const k of PUBLICATION_KEYS)
    if (typeof p[k] !== "string") return `${k} is not a string`;
  const { run_id, manifest_cid, folder_cid, published_at } =
    p as unknown as Publication;
  if (!RUN_ID.test(run_id)) return `run_id "${run_id}" is not a run ID`;
  if (!isCidV1Base32(manifest_cid))
    return `manifest_cid "${manifest_cid}" is not a CIDv1 in base32 (sha2-256)`;
  if (!isCidV1Base32(folder_cid))
    return `folder_cid "${folder_cid}" is not a CIDv1 in base32 (sha2-256)`;
  if (!isUtcDateOrTime(published_at))
    return `published_at "${published_at}" is not a UTC date (YYYY-MM-DD) or time (YYYY-MM-DDTHH:MM:SS[.sss]Z)`;
  return null;
}

/** Where a run's publication record is, relative to runs/: <run_id>/publication/directory.json. */
export const publicationRecordPath = (runId: string) =>
  `${runId}/publication/directory.json`;

/**
 * Why a publication's identifiers do not match the run's publication record (runs/<run_id>/publication/
 * directory.json, as src/build-ipfs-artifacts.ts writes it), or null when they match: its run_id, its
 * artifact_manifest.cid (the manifest_cid) and its directory_cid (the folder_cid).
 */
export function publicationRecordProblem(
  p: Pick<Publication, "run_id" | "manifest_cid" | "folder_cid">,
  record: unknown,
): string | null {
  if (typeof record !== "object" || record === null || Array.isArray(record))
    return "directory.json is not a JSON object";
  const r = record as {
    run_id?: unknown;
    directory_cid?: unknown;
    artifact_manifest?: { cid?: unknown } | null;
  };
  if (r.run_id !== p.run_id)
    return `directory.json's run_id is ${JSON.stringify(r.run_id)}, not ${p.run_id}`;
  const manifestCid = r.artifact_manifest?.cid;
  if (typeof manifestCid !== "string")
    return "directory.json has no artifact_manifest.cid";
  if (typeof r.directory_cid !== "string")
    return "directory.json has no directory_cid";
  if (p.manifest_cid !== manifestCid)
    return `manifest_cid ${p.manifest_cid} is not directory.json's artifact_manifest.cid ${manifestCid}`;
  if (p.folder_cid !== r.directory_cid)
    return `folder_cid ${p.folder_cid} is not directory.json's directory_cid ${r.directory_cid}`;
  return null;
}

/**
 * Why a gateway-check proof (src/gateway-verify.ts, gateway-check-<run_id>.json) does not allow recording this
 * publication, or null when it does: it must be a PASS (verdict "PASS", passes true) with the manifest fetched, not
 * made with the test-only local-gateway flag, name who pinned the content, and name the same run_id, manifest_cid and
 * directory_cid (the folder CID) as the publication.
 */
export function publicationProofProblem(
  p: Pick<Publication, "run_id" | "manifest_cid" | "folder_cid">,
  proof: unknown,
): string | null {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof))
    return "the proof is not a JSON object";
  const r = proof as Record<string, unknown>;
  if (r.verdict !== "PASS" || r.passes !== true)
    return `the proof is not a PASS (verdict ${JSON.stringify(r.verdict)})`;
  if (r.manifest_fetched !== true)
    return "the proof did not fetch the manifest";
  if (r.test_only_local_gateways !== false)
    return "the proof was made with the test-only local gateways";
  if (
    !Array.isArray(r.pinned_by) ||
    !r.pinned_by.length ||
    !r.pinned_by.every((x) => typeof x === "string" && x.trim())
  )
    return "the proof does not name who pins the content (pinned_by)";
  if (r.run_id !== p.run_id)
    return `the proof's run_id is ${JSON.stringify(r.run_id)}, not ${p.run_id}`;
  if (r.manifest_cid !== p.manifest_cid)
    return `the proof's manifest_cid is ${JSON.stringify(r.manifest_cid)}, not ${p.manifest_cid}`;
  if (r.directory_cid !== p.folder_cid)
    return `the proof's directory_cid is ${JSON.stringify(r.directory_cid)}, not the folder_cid ${p.folder_cid}`;
  return null;
}

/** The line for a publication: fixed key order, one JSON object, a newline. */
export function publicationLine(p: Publication): string {
  const line = JSON.stringify({
    run_id: p.run_id,
    manifest_cid: p.manifest_cid,
    folder_cid: p.folder_cid,
    published_at: p.published_at,
  });
  const problem = publicationProblem(JSON.parse(line));
  if (problem) throw new Error(`not a publication line: ${problem}`);
  return `${line}\n`;
}

/**
 * The file's publications, in order. Throws on anything malformed: a line that is not exactly one publication, a
 * blank line, a missing final newline, or a run recorded twice. An empty file has none.
 */
export function parsePublications(text: string): Publication[] {
  if (text === "") return [];
  if (!text.endsWith("\n"))
    throw new Error("runs/publications.jsonl: the last line has no newline");
  const out: Publication[] = [];
  const seen = new Set<string>();
  text
    .slice(0, -1)
    .split("\n")
    .forEach((line, i) => {
      const where = `runs/publications.jsonl line ${i + 1}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${where}: not JSON`);
      }
      const problem = publicationProblem(value);
      if (problem) throw new Error(`${where}: ${problem}`);
      const p = value as Publication;
      if (line !== JSON.stringify(p))
        throw new Error(
          `${where}: not in the written form (one compact JSON object)`,
        );
      if (seen.has(p.run_id))
        throw new Error(`${where}: run ${p.run_id} is already recorded`);
      seen.add(p.run_id);
      out.push(p);
    });
  return out;
}
