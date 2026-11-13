/**
 * UnixFS CIDs and CARs, computed locally (no IPFS node, no network). The only module that imports
 * ipfs-car; everything else uses the functions below, so the encoder can be swapped without touching
 * the manifest, the guard or the tests' expectations.
 *
 * Settings: ipfs-car 3.1.0's defaults (its unixfs.js), which cannot be changed without importing
 * @ipld/unixfs directly. They are recorded in every artifact manifest (UNIXFS_PARAMS) so a third party
 * can rebuild each CID. For files they equal the IPIP-0499 profile "unixfs-v1-2025"
 * (https://specs.ipfs.tech/ipips/ipip-0499/): CIDv1, sha2-256, fixed 1 MiB chunks, balanced layout
 * of width 1024, raw leaves. Directories are plain dag-pb UnixFS directories; ipfs-car shards a
 * directory only above 1,000 entries (IPIP-0499 shards by block size above 256 KiB), which never
 * applies to the four-file publishable directory.
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
  car: "CARv1, header roots = [directory CID], blocks in encoder order (leaves first, root last)",
} as const;

export type Digest = { size: number; sha256: string };
export type FileDigest = Digest & { cid: string };
export type DirectoryEntry = { name: string; bytes: Uint8Array };
export type DirectoryCar = {
  root: string;
  car: Uint8Array;
  car_sha256: string;
};

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

/**
 * A CAR of a flat directory, with the directory CID as its only root (so `dag import` pins it).
 * Two passes: the first finds the root CID, the second writes the CAR with that root in the header.
 */
export async function directoryCar(
  entries: DirectoryEntry[],
): Promise<DirectoryCar> {
  const root = (await lastBlock(directoryStream(entries))).cid;
  const parts: Uint8Array[] = [];
  const encoder = new CAREncoderStream([root]);
  await directoryStream(entries)
    .pipeThrough(encoder)
    .pipeTo(
      new WritableStream({ write: (p: Uint8Array) => void parts.push(p) }),
    );
  if (encoder.finalBlock?.cid.toString() !== root.toString())
    throw new Error("the CAR's last block is not the directory root");
  const car = new Uint8Array(Buffer.concat(parts));
  return { root: root.toString(), car, car_sha256: sha256Hex(car) };
}
