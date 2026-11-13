import { describe, expect, test } from "vitest";
import {
  buildArtifactManifest,
  jsonBytes,
  type ArtifactManifest,
} from "../src/artifact-manifest.ts";
import { bytesCid, directoryCar, sha256Hex } from "../src/ipfs-unixfs.ts";
import {
  FakeUploader,
  MAX_PUBLISH_BYTES,
  PublishRefused,
  guardDirectory,
  guardFile,
  publishDirectory,
  type Candidate,
  type Uploader,
} from "../src/publish-guard.ts";

const RUN = "2026-01-02T03-04-05-678Z";
const enc = (s: string) => new TextEncoder().encode(s);
const digest = async (b: Uint8Array) => ({
  size: b.length,
  sha256: sha256Hex(b),
  cid: await bytesCid(b),
});

/** A valid publishable directory, plus a manifest that lists one Parquet as not published. */
async function fixture(runManifestBytes = enc('{"run_id":"r"}\n')) {
  const coverage = enc('{"counts":1}\n');
  const schema = enc('{"tables":[]}\n');
  const parquet = new Uint8Array([
    0x50, 0x41, 0x52, 0x31, 1, 2, 0x50, 0x41, 0x52, 0x31,
  ]);
  const manifest = buildArtifactManifest({
    runId: RUN,
    runFiles: [
      {
        path: `runs/${RUN}/run_manifest.json`,
        digest: await digest(runManifestBytes),
      },
      { path: `data/out/${RUN}/t.parquet`, digest: await digest(parquet) },
    ],
    publishable: [
      { name: "run_manifest.json", digest: await digest(runManifestBytes) },
      { name: "coverage.json", digest: await digest(coverage) },
      { name: "schema.json", digest: await digest(schema) },
    ],
    referenced: [],
  });
  const manifestBytes = jsonBytes(manifest);
  const files: Candidate[] = [
    { name: "artifact-manifest.json", bytes: manifestBytes },
    { name: "coverage.json", bytes: coverage },
    { name: "run_manifest.json", bytes: runManifestBytes },
    { name: "schema.json", bytes: schema },
  ];
  const car = await directoryCar(files);
  return {
    manifest,
    manifestBytes,
    files,
    parquet,
    root: car.root,
    car: car.car,
  };
}

describe("guardFile", () => {
  test("accepts the published files and the run's own artifact manifest", async () => {
    const f = await fixture();
    for (const c of f.files)
      expect(guardFile(c, f.manifest, f.manifestBytes)).toEqual([]);
  });

  test("refuses a file marked not published (here a data file)", async () => {
    const f = await fixture();
    const r = guardFile(
      { name: `data/out/${RUN}/t.parquet`, bytes: f.parquet },
      f.manifest,
      f.manifestBytes,
    );
    expect(r.map((x) => x.reason)).toEqual([
      "Parquet is never published",
      expect.stringMatching(/^not marked published \(holds records/),
    ]);
  });

  test("refuses Parquet by name, and by magic bytes under another name", async () => {
    const f = await fixture();
    const asJson = guardFile(
      { name: "schema.json", bytes: f.parquet },
      f.manifest,
      f.manifestBytes,
    );
    expect(asJson.map((x) => x.reason)).toContain("Parquet is never published");
    const trailer = new Uint8Array([123, 125, 0x50, 0x41, 0x52, 0x31]);
    expect(
      guardFile(
        { name: "coverage.json", bytes: trailer },
        f.manifest,
        f.manifestBytes,
      ).map((x) => x.reason),
    ).toContain("Parquet is never published");
    const named = guardFile(
      { name: "x.PARQUET", bytes: enc("{}") },
      f.manifest,
      f.manifestBytes,
    );
    expect(named.map((x) => x.reason)).toContain("Parquet is never published");
  });

  test("a file over 1 MB (1,000,000 bytes) is listed as not published, and the guard refuses it", async () => {
    const big = new Uint8Array(MAX_PUBLISH_BYTES + 1).fill(32);
    const f = await fixture(big);
    expect(
      f.manifest.files.find((e) => e.name === "run_manifest.json"),
    ).toMatchObject({
      published: false,
      not_published_reason:
        "over the 1 MB publish limit (1000001 bytes > 1000000)",
    });
    const r = guardFile(
      { name: "run_manifest.json", bytes: big },
      f.manifest,
      f.manifestBytes,
    );
    expect(r.map((x) => x.reason)).toEqual([
      "over 1 MB (1000001 bytes > 1000000)",
      "not marked published (over the 1 MB publish limit (1000001 bytes > 1000000))",
    ]);
    const atLimit = new Uint8Array(MAX_PUBLISH_BYTES).fill(32);
    const g = await fixture(atLimit);
    expect(
      guardFile(
        { name: "run_manifest.json", bytes: atLimit },
        g.manifest,
        g.manifestBytes,
      ),
    ).toEqual([]);
  });

  test("the size check does not depend on the manifest: a manifest that marks a large file published is still refused", async () => {
    const big = new Uint8Array(MAX_PUBLISH_BYTES + 1).fill(32);
    const f = await fixture(big);
    const forged: ArtifactManifest = {
      ...f.manifest,
      files: f.manifest.files.map((e) =>
        e.name === "run_manifest.json"
          ? { ...e, published: true, not_published_reason: null }
          : e,
      ),
    };
    expect(
      guardFile(
        { name: "run_manifest.json", bytes: big },
        forged,
        jsonBytes(forged),
      ),
    ).toEqual([
      {
        name: "run_manifest.json",
        reason: "over 1 MB (1000001 bytes > 1000000)",
      },
    ]);
  });

  test("refuses unlisted files, changed bytes and a foreign artifact manifest", async () => {
    const f = await fixture();
    expect(
      guardFile(
        { name: "notes.json", bytes: enc("{}") },
        f.manifest,
        f.manifestBytes,
      )[0].reason,
    ).toBe("not listed in the artifact manifest");
    expect(
      guardFile(
        { name: "coverage.json", bytes: enc('{"counts":2}\n') },
        f.manifest,
        f.manifestBytes,
      )[0].reason,
    ).toBe("bytes differ from the artifact manifest's sha256");
    expect(
      guardFile(
        { name: "artifact-manifest.json", bytes: enc("{}") },
        f.manifest,
        f.manifestBytes,
      )[0].reason,
    ).toBe("not the run's artifact manifest");
  });
});

describe("guardDirectory and publishDirectory", () => {
  test("a valid directory passes and reaches the (fake) uploader once, with the CAR and its root", async () => {
    const f = await fixture();
    expect(await guardDirectory(f)).toEqual([]);
    const up = new FakeUploader();
    expect(await publishDirectory(f, up)).toEqual({ root: f.root });
    expect(up.imported).toEqual([
      { root: f.root, car_sha256: sha256Hex(f.car), bytes: f.car.length },
    ]);
  });

  test("refuses a directory with an extra file (e.g. a Parquet), and the uploader is never called", async () => {
    const f = await fixture();
    const files = [...f.files, { name: "t.parquet", bytes: f.parquet }];
    const car = await directoryCar(files);
    const up = new FakeUploader();
    const err = await publishDirectory(
      { files, root: car.root, car: car.car },
      up,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefused);
    const reasons = (err as PublishRefused).refusals.map(
      (r) => `${r.name}: ${r.reason}`,
    );
    expect(reasons).toContain(
      "(directory): files must be exactly artifact-manifest.json, coverage.json, run_manifest.json, schema.json; got artifact-manifest.json, coverage.json, run_manifest.json, schema.json, t.parquet",
    );
    expect(reasons).toContain("t.parquet: Parquet is never published");
    expect(up.imported).toEqual([]);
  });

  test("refuses a CAR or root that is not the deterministic CAR of exactly these files", async () => {
    const f = await fixture();
    const other = await directoryCar([
      ...f.files.slice(0, 3),
      { name: "schema.json", bytes: enc("{}") },
    ]);
    const r = await guardDirectory({
      files: f.files,
      root: other.root,
      car: other.car,
    });
    expect(r.map((x) => x.reason)).toEqual([
      "root is not the CID of these files",
      "CAR is not the deterministic CAR of these files",
    ]);
  });

  test("refuses a CAR over 1 MB and a run manifest over 1 MB", async () => {
    const f = await fixture(new Uint8Array(MAX_PUBLISH_BYTES + 10).fill(32));
    const r = await guardDirectory(f);
    expect(r.map((x) => `${x.name}: ${x.reason}`)).toEqual([
      "run_manifest.json: over 1 MB (1000010 bytes > 1000000)",
      "run_manifest.json: not marked published (over the 1 MB publish limit (1000010 bytes > 1000000))",
      expect.stringMatching(/^\(car\): over 1 MB \(\d+ bytes > 1000000\)$/),
    ]);
  });

  test("refuses a manifest that marks a publishable name as not published", async () => {
    const f = await fixture();
    const manifest: ArtifactManifest = {
      ...f.manifest,
      files: f.manifest.files.map((e) =>
        e.name === "coverage.json"
          ? { ...e, published: false, not_published_reason: "test" }
          : e,
      ),
    };
    const files = f.files.map((c) =>
      c.name === "artifact-manifest.json"
        ? { ...c, bytes: jsonBytes(manifest) }
        : c,
    );
    const car = await directoryCar(files);
    const r = await guardDirectory({ files, root: car.root, car: car.car });
    expect(r).toEqual([
      { name: "coverage.json", reason: "not marked published (test)" },
    ]);
  });

  test("an uploader that reports another root is an error", async () => {
    const f = await fixture();
    const liar: Uploader = { importCar: async () => ({ root: "bafy-other" }) };
    await expect(publishDirectory(f, liar)).rejects.toThrow(
      /uploader reported root bafy-other/,
    );
  });
});
