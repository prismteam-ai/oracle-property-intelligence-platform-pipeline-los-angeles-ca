/**
 * artifact-manifest.json of a run's publish folder: every published object of the run, each with its
 * CID (UnixFS CIDv1, base32), name, size, codec ("file" or "directory", the IPFS codec in the
 * assignment's sense; every listed object is a file), ipld_codec (the CID's codec, "raw" or "dag-pb")
 * and sha256, in that key order. The objects are the
 * run's coverage.json and the named Parquet objects (publish-named-objects.ts), sorted by name. It does
 * not list itself, and the folder's CID is recorded next to the folder (directory.json), not in it.
 *
 * Nothing else is published: not the run manifest, the schema, a CSV, a raw page or any other file of
 * the run (the publish guard refuses them).
 */
import { bytesCidCodec, sha256Hex } from "./ipfs-unixfs.ts";
import type { NamedObject } from "./publish-named-objects.ts";
import type { ArtifactManifest, PublishedObject } from "./publish-guard.ts";

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

export function buildArtifactManifest(
  objects: PublishedObject[],
): ArtifactManifest {
  const sorted = [...objects].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return {
    objects: sorted.map((o) => ({
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
