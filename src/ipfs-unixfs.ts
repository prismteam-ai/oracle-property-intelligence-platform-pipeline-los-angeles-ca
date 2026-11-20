/**
 * UnixFS CIDs and CARs, computed locally (no IPFS node, no network). The only module that imports
 * ipfs-car; everything else uses the functions below, so the encoder can be swapped without touching
 * the manifest, the guard or the tests' expectations.
 *
 * Settings: ipfs-car 3.1.0's defaults (its unixfs.js), which cannot be changed without importing
 * @ipld/unixfs directly. They are listed in UNIXFS_PARAMS (and in the publication README) so a third party
 * can rebuild each CID. For files they equal the IPIP-0499 profile "unixfs-v1-2025"
 * (https://specs.ipfs.tech/ipips/ipip-0499/): CIDv1, sha2-256, fixed 1 MiB chunks, balanced layout
 * of width 1024, raw leaves. Directories are plain dag-pb UnixFS directories; ipfs-car shards a
 * directory only above 1,000 entries (IPIP-0499 shards by block size above 256 KiB), which never
 * applies to the two-file publish folder.
 *
 * These are UnixFS CIDs of the raw bytes, not lexicon (dag-json) CIDs.
 */
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import {
  CAREncoderStream,
  createDirectoryEncoderStream,
  createFileEncoderStream,
} from "ipfs-car";
import type { Block, BlobLike } from "ipfs-car";

export const UNIXFS_PARAMS = {
  tool: "ipfs-car 3.1.0 (createFileEncoderStream / createDirectoryEncoderStream with their default settings)",
  cid_version: 1,
  multibase: "base32",
  hash: "sha2-256",
  leaves: "raw (codec 0x55)",
  chunker: "fixed-size, 1048576 bytes (1 MiB)",
  file_layout: "balanced, at most 1024 links per node",
  directory:
    "dag-pb UnixFS directory, entries sorted by name, not sharded (ipfs-car shards above 1000 entries)",
  profile:
    "files: IPIP-0499 unixfs-v1-2025 (https://specs.ipfs.tech/ipips/ipip-0499/)",
  car: "CARv1, header roots = [the directory CID, or the file CID for a single file]; a directory CAR's blocks in depth-first order from the root (root first, links in order, each block once), as a gateway's ?format=car of the folder (order=dfs, dups=n); a file CAR's blocks in encoder order (leaves first, root last)",
} as const;

export type Digest = { size: number; sha256: string };
export type FileDigest = Digest & { cid: string };
export type DirectoryEntry = { name: string; bytes: Uint8Array };
export type DirectoryCar = {
  root: string;
  car: Uint8Array;
  car_sha256: string;
};
export type FileCar = DirectoryCar;
/** The CID's codec: raw (0x55) for a file of one chunk, dag-pb (0x70) for a chunked file or a directory. */
export type Codec = "raw" | "dag-pb";

function codecName(code: number): Codec {
  if (code === 0x55) return "raw";
  if (code === 0x70) return "dag-pb";
  throw new Error(`unexpected CID codec 0x${code.toString(16)}`);
}

/** Consumes an encoder stream and returns its last block (the root, in ipfs-car's block order). */
async function lastBlock(stream: ReadableStream<Block>): Promise<Block> {
  let last: Block | null = null;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    last = value;
  }
  if (!last) throw new Error("the UnixFS encoder produced no block");
  return last;
}

/** CID of one file's bytes (a Blob or anything with stream()). Reads the bytes once. */
export async function fileCid(blob: BlobLike): Promise<string> {
  return (await lastBlock(createFileEncoderStream(blob))).cid.toString();
}

export function bytesCid(bytes: Uint8Array): Promise<string> {
  return fileCid(new Blob([new Uint8Array(bytes)]));
}

/** CID and codec of one file's bytes. */
export async function bytesCidCodec(
  bytes: Uint8Array,
): Promise<{ cid: string; codec: Codec }> {
  const { cid } = await lastBlock(
    createFileEncoderStream(new Blob([new Uint8Array(bytes)])),
  );
  return { cid: cid.toString(), codec: codecName(cid.code) };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** size, sha256 and CID of a file on disk, streamed (never loaded whole into memory). */
export async function digestFile(path: string): Promise<FileDigest> {
  const blob = await openAsBlob(path);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of blob.stream()) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  if (size !== blob.size)
    throw new Error(`${path}: size changed while reading`);
  return { size, sha256: hash.digest("hex"), cid: await fileCid(blob) };
}

function directoryStream(entries: DirectoryEntry[]): ReadableStream<Block> {
  const names = entries.map((e) => e.name);
  for (const n of names)
    if (!n || n.includes("/") || n === "." || n === "..")
      throw new Error(`directory entry name must be a plain file name: "${n}"`);
  if (new Set(names).size !== names.length)
    throw new Error("duplicate directory entry name");
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return createDirectoryEncoderStream(
    sorted.map((e) =>
      Object.assign(new Blob([new Uint8Array(e.bytes)]), { name: e.name }),
    ),
  );
}

/** CID of a flat directory of files. */
export async function directoryCid(entries: DirectoryEntry[]): Promise<string> {
  return (await lastBlock(directoryStream(entries))).cid.toString();
}

/** Reads every block of an encoder stream, in the encoder's order (the root last). */
async function allBlocks(stream: ReadableStream<Block>): Promise<Block[]> {
  const out: Block[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  if (!out.length) throw new Error("the UnixFS encoder produced no block");
  return out;
}

function readVarint(b: Uint8Array, at: number): [number, number] {
  let n = 0;
  for (let shift = 1, i = at; i < b.length; i++, shift *= 128) {
    n += (b[i] & 0x7f) * shift;
    if (b[i] < 0x80) return [n, i + 1];
  }
  throw new Error("dag-pb: truncated varint");
}

/** The length-delimited fields of one protobuf message, as [field number, payload]. */
function pbFields(b: Uint8Array): [number, Uint8Array][] {
  const out: [number, Uint8Array][] = [];
  for (let at = 0; at < b.length;) {
    const [tag, afterTag] = readVarint(b, at);
    if ((tag & 7) === 0) {
      at = readVarint(b, afterTag)[1];
      continue;
    }
    if ((tag & 7) !== 2)
      throw new Error(`dag-pb: unexpected wire type ${tag & 7}`);
    const [len, start] = readVarint(b, afterTag);
    if (start + len > b.length) throw new Error("dag-pb: truncated field");
    out.push([Math.floor(tag / 8), b.subarray(start, start + len)]);
    at = start + len;
  }
  return out;
}

/** The CIDs (as bytes) a dag-pb block links to, in link order (dag-pb spec: PBNode.Links = field 2, PBLink.Hash = field 1). */
function dagPbLinks(block: Uint8Array): Uint8Array[] {
  return pbFields(block)
    .filter(([field]) => field === 2)
    .map(([, link]) => {
      const hash = pbFields(link).find(([field]) => field === 1);
      if (!hash) throw new Error("dag-pb: a link without a Hash");
      return hash[1];
    });
}

const cidKey = (cid: Uint8Array) => Buffer.from(cid).toString("hex");

/**
 * The blocks in depth-first order from the root: the root first, then each link's subtree in link
 * order, a block seen before not written again. This is the order a trustless gateway writes a CAR in
 * (IPIP-412: order=dfs, dups=n), so the folder's CAR fetched from a gateway has the bytes we list.
 * Every block must be reachable from the root and every link must resolve to a block we have.
 */
function depthFirst(root: Block, blocks: Block[]): Block[] {
  const byCid = new Map(blocks.map((b) => [cidKey(b.cid.bytes), b]));
  const seen = new Set<string>();
  const out: Block[] = [];
  const visit = (block: Block) => {
    const key = cidKey(block.cid.bytes);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(block);
    if (codecName(block.cid.code) === "raw") return;
    for (const link of dagPbLinks(block.bytes)) {
      const child = byCid.get(cidKey(link));
      if (!child)
        throw new Error(
          "the directory links to a block the encoder did not produce",
        );
      visit(child);
    }
  };
  visit(root);
  if (seen.size !== byCid.size)
    throw new Error(
      "the encoder produced a block the directory does not reach",
    );
  return out;
}

/**
 * A CAR of a flat directory, with the directory CID as its only root (so `dag import` pins it), its
 * blocks root first in depth-first order (see depthFirst). One pass collects the blocks; the root is the
 * encoder's last block.
 */
export async function directoryCar(
  entries: DirectoryEntry[],
): Promise<DirectoryCar> {
  const blocks = await allBlocks(directoryStream(entries));
  const root = blocks[blocks.length - 1];
  const ordered = depthFirst(root, blocks);
  const parts: Uint8Array[] = [];
  const encoder = new CAREncoderStream([root.cid]);
  await new ReadableStream<Block>({
    start(controller) {
      for (const b of ordered) controller.enqueue(b);
      controller.close();
    },
  })
    .pipeThrough(encoder)
    .pipeTo(
      new WritableStream({ write: (p: Uint8Array) => void parts.push(p) }),
    );
  if (ordered[0] !== root)
    throw new Error("the CAR's first block is not the directory root");
  const car = new Uint8Array(Buffer.concat(parts));
  return { root: root.cid.toString(), car, car_sha256: sha256Hex(car) };
}

/**
 * A CAR of one file, with the file's CID as its only root, so importing the CAR keeps that CID exactly.
 * Two passes: the first finds the root CID, the second writes the CAR with that root in the header. Its
 * blocks stay in encoder order (leaves first, root last): this path does not share directoryCar's
 * depth-first ordering, so the published file CARs (the Parquet objects and the manifest) keep their bytes.
 */
export async function fileCar(blob: BlobLike): Promise<FileCar> {
  const root = (await lastBlock(createFileEncoderStream(blob))).cid;
  const parts: Uint8Array[] = [];
  const encoder = new CAREncoderStream([root]);
  await createFileEncoderStream(blob)
    .pipeThrough(encoder)
    .pipeTo(
      new WritableStream({ write: (p: Uint8Array) => void parts.push(p) }),
    );
  if (encoder.finalBlock?.cid.toString() !== root.toString())
    throw new Error("the CAR's last block is not the file's root");
  const car = new Uint8Array(Buffer.concat(parts));
  return { root: root.toString(), car, car_sha256: sha256Hex(car) };
}
