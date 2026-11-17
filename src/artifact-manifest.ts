/**
 * artifact-manifest.json of a run: its own published file beside the publish folder, never inside it.
 * It lists every published object of the run except itself, each with cid (UnixFS CIDv1, base32), name,
 * size, codec ("file" or "directory", the IPFS codec in the assignment's sense), ipld_codec (the CID's
 * codec, "raw" or "dag-pb") and sha256, in that key order:
 *   first the publish folder as the one directory root ("publish", dag-pb, its CID; size and sha256 of
 *   its CAR, see publish-guard.ts), then the files sorted by name: the run's coverage.json and the
 *   named Parquet objects (publish-named-objects.ts).
 *
 * Nothing else is published: not the run manifest, the schema, a CSV, a raw page or any other file of
 * the run (the publish guard refuses them).
 */
import { bytesCidCodec, sha256Hex } from "./ipfs-unixfs.ts";
import type { NamedObject } from "./publish-named-objects.ts";
import {
  PUBLISH_FOLDER_NAME,
  type ArtifactManifest,
  type PublishedObject,
} from "./publish-guard.ts";

export type { ArtifactManifest, PublishedObject };

export async function objectOf(
  name: string,
  bytes: Uint8Array,
): Promise<PublishedObject> {
  const { cid, codec } = await bytesCidCodec(bytes);
  return {
    cid,
    name,
    size: bytes.length,
    codec: "file",
    ipld_codec: codec,
    sha256: sha256Hex(bytes),
  };
}

export function namedObjectEntry(n: NamedObject): PublishedObject {
  return {
    cid: n.cid,
    name: n.name,
    size: n.size,
    codec: "file",
    ipld_codec: n.ipld_codec,
    sha256: n.sha256,
  };
}

/** The publish folder's entry: its CID, and the size and sha256 of its CAR. */
export function folderEntry(folder: {
  root: string;
  car: Uint8Array;
}): PublishedObject {
  return {
    cid: folder.root,
    name: PUBLISH_FOLDER_NAME,
    size: folder.car.length,
    codec: "directory",
    ipld_codec: "dag-pb",
    sha256: sha256Hex(folder.car),
  };
}

/** The folder first, then the files sorted by name. */
export function buildArtifactManifest(
  folder: PublishedObject,
  files: PublishedObject[],
): ArtifactManifest {
  const sorted = [...files].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return {
    objects: [folder, ...sorted].map((o) => ({
      cid: o.cid,
      name: o.name,
      size: o.size,
      codec: o.codec,
      ipld_codec: o.ipld_codec,
      sha256: o.sha256,
    })),
  };
}

/** Deterministic JSON bytes: 2-space indent, trailing newline, key order as built. */
export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}
