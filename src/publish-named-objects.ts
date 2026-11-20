/**
 * The Parquet objects of the publication, each named by its exact bytes. They are published once, as
 * their own objects (one CAR each, rooted at the file's CID), and listed in every run's artifact
 * manifest. They were built for the publication packet and are given files here, never rebuilt:
 *
 * - los-angeles-roll2026-county.parquet: the County roll extract, every parcel of the 2026 roll;
 * - los-angeles-roll2026-sample-5mi.parquet: the parcels within 5 miles of 34.20155, -118.45361.
 *
 * The publish guard passes a Parquet file only when its name, size and SHA-256 are one of these
 * entries exactly; the CID is the file's UnixFS CIDv1 with ipfs-car 3.1.0's settings (ipfs-unixfs.ts).
 */
import type { Codec } from "./ipfs-unixfs.ts";

export type NamedObject = {
  name: string;
  size: number;
  sha256: string;
  cid: string;
  /** The CID's IPLD codec (dag-pb for a file of more than one 1 MiB chunk). */
  ipld_codec: Codec;
};

export const NAMED_OBJECTS: readonly NamedObject[] = [
  {
    name: "los-angeles-roll2026-county.parquet",
    size: 32_775_616,
    sha256: "e73fb85e87ddeba3dbb973f04a2f97b85749b686b291db5078066575fdade987",
    cid: "bafybeifky42ojoid4c6tm54jpqw5ctwdsmuemtbrs6ebkmesz73knnd3de",
    ipld_codec: "dag-pb",
  },
  {
    name: "los-angeles-roll2026-sample-5mi.parquet",
    size: 1_878_244,
    sha256: "861f7f5e79332e86d5bb6d4960561d648cd9955d2ae890c100317c6918201bbc",
    cid: "bafybeidsmehgjsc5f4pzhgrbn6gtihv22cz2wjou46ajqfgt6tg4dwzx5a",
    ipld_codec: "dag-pb",
  },
];

/** The published sample as coverage.json describes it: its circle and its row count. */
export type SampleSpec = {
  /** The named object it describes. */
  object: string;
  center_latitude: number;
  center_longitude: number;
  radius_miles: number;
  rows: number;
};

/**
 * The 5-mile sample: center and radius as the build that made it bound them (CENTER_LAT 34.20155,
 * CENTER_LON -118.45361, RADIUS_MILES 5, by the data API's own distance rule; that build is not in this
 * repository), and its row count, which `src/build-ipfs-artifacts.ts` checks against the sample Parquet's
 * footer.
 */
export const PUBLISHED_SAMPLE: SampleSpec = {
  object: "los-angeles-roll2026-sample-5mi.parquet",
  center_latitude: 34.20155,
  center_longitude: -118.45361,
  radius_miles: 5,
  rows: 151_748,
};
