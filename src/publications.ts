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

/** The public gateway the Explorer links a run's artifact manifest to (path form, one gateway). */
export const gatewayUrl = (manifestCid: string) =>
  `https://ipfs.io/ipfs/${manifestCid}`;

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
