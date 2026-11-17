import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  bytesCidCodec,
  directoryCar,
  fileCar,
  sha256Hex,
} from "../src/ipfs-unixfs.ts";
import {
  FakeUploader,
  MAX_PUBLISH_BYTES,
  PublishRefused,
  guardDirectory,
  guardFile,
  guardManifest,
  guardObject,
  holdsRunManifest,
  isRunManifestName,
  publishDirectory,
  publishObject,
  type ArtifactManifest,
  type Candidate,
  type PublishedObject,
  type Uploader,
} from "../src/publish-guard.ts";
import {
  NAMED_OBJECTS,
  type NamedObject,
} from "../src/publish-named-objects.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(JSON.stringify(v, null, 2) + "\n");
const parquetBytes = (fill: number) =>
  new Uint8Array([0x50, 0x41, 0x52, 0x31, fill, fill, 0x50, 0x41, 0x52, 0x31]);

async function entryFor(
  name: string,
  bytes: Uint8Array,
): Promise<PublishedObject> {
  const { cid, codec } = await bytesCidCodec(bytes);
  return { cid, name, size: bytes.length, codec, sha256: sha256Hex(bytes) };
}

/** Two small named "Parquet" objects, standing in for the real ones in every test but the last. */
async function namedFixture() {
  const a = parquetBytes(1);
  const b = parquetBytes(2);
  const named: NamedObject[] = [
    await entryFor("a.parquet", a),
    await entryFor("b.parquet", b),
  ].map(({ cid, name, size, codec, sha256 }) => ({
    name,
    size,
    sha256,
    cid,
    codec,
  }));
  return { named, bytes: { "a.parquet": a, "b.parquet": b } };
}

/** A valid publish folder: coverage.json and an artifact manifest listing it and the named objects. */
async function fixture(
  coverage = json({ run_id: "r", parcels: { total: 3 } }),
) {
  const { named, bytes } = await namedFixture();
  const manifest: ArtifactManifest = {
    objects: [
      await entryFor("coverage.json", coverage),
      ...named.map((n) => ({
        cid: n.cid,
        name: n.name,
        size: n.size,
        codec: n.codec,
        sha256: n.sha256,
      })),
    ],
  };
  const manifestBytes = json(manifest);
  const files: Candidate[] = [
    { name: "artifact-manifest.json", bytes: manifestBytes },
    { name: "coverage.json", bytes: coverage },
  ];
  const car = await directoryCar(files);
  return {
    named,
    objects: bytes,
    manifest,
    manifestBytes,
    files,
    root: car.root,
    car: car.car,
  };
}

/** A folder with the artifact manifest replaced (and the CAR rebuilt to match). */
async function withManifest(
  f: Awaited<ReturnType<typeof fixture>>,
  manifest: unknown,
  extra: Candidate[] = [],
) {
  const files = [
    ...f.files.map((c) =>
      c.name === "artifact-manifest.json" ? { ...c, bytes: json(manifest) } : c,
    ),
    ...extra,
  ];
  const car = await directoryCar(files);
  return { files, root: car.root, car: car.car };
}

const reasons = (r: { name: string; reason: string }[]) =>
  r.map((x) => `${x.name}: ${x.reason}`);

/** The shape of a recorded run manifest (its keys; values shortened). */
const RUN_MANIFEST = {
  run_id: "2026-01-02T03-04-05-678Z-b0",
  run_name: "synthetic",
  generated_at: "2026-01-02T03:04:05.678Z",
  readiness: { overall: "PASS" },
  sources: [{ name: "roll" }],
  row_counts: { parquet: 3 },
  files: [],
  limitations: [],
  rebuild: [],
};

describe("guardFile", () => {
  test("accepts coverage.json listed with its bytes and the folder's own artifact manifest", async () => {
    const f = await fixture();
    for (const c of f.files)
      expect(guardFile(c, f.manifest, f.manifestBytes)).toEqual([]);
  });

  test("refuses a run manifest by name, whatever its bytes", async () => {
    const f = await fixture();
    for (const name of [
      "run_manifest.json",
      "run-manifest.json",
      "RunManifest.json",
      "x/run_manifest.json",
    ]) {
      expect(isRunManifestName(name)).toBe(true);
      expect(
        guardFile({ name, bytes: enc("{}") }, f.manifest, f.manifestBytes).map(
          (r) => r.reason,
        ),
      ).toContain("a run manifest is never published");
    }
    expect(isRunManifestName("coverage.json")).toBe(false);
  });

  test("refuses a run manifest under another name: whole, embedded under a key, or as escaped text", async () => {
    const f = await fixture();
    const whole = json(RUN_MANIFEST);
    const embedded = json({ run_id: "r", note: { copy: RUN_MANIFEST } });
    const asText = json({ run_id: "r", note: JSON.stringify(RUN_MANIFEST) });
    const inArray = json([{ x: 1 }, RUN_MANIFEST]);
    for (const bytes of [whole, embedded, asText, inArray]) {
      expect(holdsRunManifest(bytes)).toBe(true);
      expect(
        guardFile(
          { name: "coverage.json", bytes },
          f.manifest,
          f.manifestBytes,
        ).map((r) => r.reason),
      ).toContain("holds a run manifest; a run manifest is never published");
    }
    // coverage.json and the artifact manifest share run_id or other words, never the run-manifest keys.
    expect(holdsRunManifest(f.files[1].bytes)).toBe(false);
    expect(
      holdsRunManifest(
        json({
          run_id: "r",
          run_kind: "rebuild",
          rebuild_of: "q",
          sources: [],
        }),
      ),
    ).toBe(false);
    expect(holdsRunManifest(f.manifestBytes)).toBe(false);
  });

  test("refuses every recorded run manifest of runs/ under the name coverage.json, by its content", async () => {
    const f = await fixture();
    const ids = readdirSync("runs", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    for (const id of ids) {
      const bytes = new Uint8Array(
        readFileSync(join("runs", id, "run_manifest.json")),
      );
      expect(
        guardFile(
          { name: "coverage.json", bytes },
          f.manifest,
          f.manifestBytes,
        ).map((r) => r.reason),
      ).toContain("holds a run manifest; a run manifest is never published");
    }
  });

  test("refuses Parquet in the folder by name or by magic bytes, also a named object's exact bytes", async () => {
    const f = await fixture();
    const a = f.objects["a.parquet"];
    expect(
      reasons(
        guardFile({ name: "a.parquet", bytes: a }, f.manifest, f.manifestBytes),
      ),
    ).toEqual([
      "a.parquet: not a publish-folder file (only artifact-manifest.json and coverage.json)",
      "a.parquet: Parquet is never in a publish folder (only as a named object)",
    ]);
    expect(
      guardFile(
        { name: "coverage.json", bytes: a },
        f.manifest,
        f.manifestBytes,
      ).map((r) => r.reason),
    ).toContain(
      "Parquet is never in a publish folder (only as a named object)",
    );
    const trailer = new Uint8Array([123, 125, 0x50, 0x41, 0x52, 0x31]);
    expect(
      guardFile(
        { name: "coverage.json", bytes: trailer },
        f.manifest,
        f.manifestBytes,
      ).map((r) => r.reason),
    ).toContain(
      "Parquet is never in a publish folder (only as a named object)",
    );
  });

  test("refuses a file over 1 MB (1,000,000 bytes) even when the manifest lists it; 1,000,000 bytes pass", async () => {
    const big = new Uint8Array(MAX_PUBLISH_BYTES + 1).fill(32);
    const f = await fixture(big);
    expect(
      reasons(
        guardFile(
          { name: "coverage.json", bytes: big },
          f.manifest,
          f.manifestBytes,
        ),
      ),
    ).toEqual(["coverage.json: over 1 MB (1000001 bytes > 1000000)"]);
    const atLimit = new Uint8Array(MAX_PUBLISH_BYTES).fill(32);
    const g = await fixture(atLimit);
    expect(
      guardFile(
        { name: "coverage.json", bytes: atLimit },
        g.manifest,
        g.manifestBytes,
      ),
    ).toEqual([]);
  });

  test("refuses another file in the folder, coverage not listed or with changed bytes, and a foreign artifact manifest", async () => {
    const f = await fixture();
    expect(
      reasons(
        guardFile(
          { name: "schema.json", bytes: enc("{}") },
          f.manifest,
          f.manifestBytes,
        ),
      ),
    ).toEqual([
      "schema.json: not a publish-folder file (only artifact-manifest.json and coverage.json)",
    ]);
    expect(
      reasons(
        guardFile(
          { name: "coverage.json", bytes: enc('{"run_id":"s"}\n') },
          f.manifest,
          f.manifestBytes,
        ),
      ),
    ).toEqual([
      "coverage.json: bytes differ from the artifact manifest's size and sha256",
    ]);
    expect(
      reasons(guardFile(f.files[1], { objects: [] }, f.manifestBytes)),
    ).toEqual(["coverage.json: not listed in the artifact manifest"]);
    expect(
      reasons(
        guardFile(
          { name: "artifact-manifest.json", bytes: enc('{"objects":[]}\n') },
          f.manifest,
          f.manifestBytes,
        ),
      ),
    ).toEqual(["artifact-manifest.json: not the folder's artifact manifest"]);
  });
});

describe("guardManifest", () => {
  test("accepts coverage.json and every named object with its exact values", async () => {
    const f = await fixture();
    expect(guardManifest(f.manifest, f.named)).toEqual([]);
  });

  test("refuses an entry for a run manifest, for itself, for any other object, and a duplicate", async () => {
    const f = await fixture();
    const extra = (name: string): PublishedObject => ({
      cid: "bafkrei-x",
      name,
      size: 1,
      codec: "raw",
      sha256: "0".repeat(64),
    });
    const m: ArtifactManifest = {
      objects: [
        ...f.manifest.objects,
        extra("run_manifest.json"),
        extra("artifact-manifest.json"),
        extra("schema.json"),
        f.manifest.objects[0],
      ],
    };
    expect(reasons(guardManifest(m, f.named))).toEqual([
      "artifact-manifest.json objects[3] (run_manifest.json): a run manifest is never published",
      "artifact-manifest.json objects[4] (artifact-manifest.json): the artifact manifest lists itself",
      "artifact-manifest.json objects[5] (schema.json): not a publishable object (coverage.json or a named object)",
      "artifact-manifest.json objects[6] (coverage.json): listed more than once",
    ]);
  });

  test("refuses a named object's entry that differs in CID, size, codec or sha256", async () => {
    const f = await fixture();
    const changes: Partial<PublishedObject>[] = [
      { cid: f.named[1].cid },
      { size: 11 },
      { codec: "dag-pb" },
      { sha256: "0".repeat(64) },
    ];
    for (const change of changes) {
      const m: ArtifactManifest = {
        objects: f.manifest.objects.map((o) =>
          o.name === "a.parquet" ? { ...o, ...change } : o,
        ),
      };
      expect(reasons(guardManifest(m, f.named))).toEqual([
        "artifact-manifest.json objects[1] (a.parquet): not the named object's exact CID, size, codec and sha256",
      ]);
    }
  });

  test("refuses a manifest that leaves out coverage.json or a named object, or an entry with other keys", async () => {
    const f = await fixture();
    expect(
      reasons(
        guardManifest({ objects: f.manifest.objects.slice(1, 2) }, f.named),
      ),
    ).toEqual([
      "artifact-manifest.json: does not list coverage.json",
      "artifact-manifest.json: does not list b.parquet",
    ]);
    const withRole = {
      objects: f.manifest.objects.map((o, i) =>
        i === 0 ? { ...o, role: "x" } : o,
      ),
    } as unknown as ArtifactManifest;
    expect(reasons(guardManifest(withRole, f.named))).toEqual([
      "artifact-manifest.json objects[0] (coverage.json): keys must be exactly cid, name, size, codec, sha256",
      "artifact-manifest.json: does not list coverage.json",
    ]);
  });
});

describe("guardDirectory and publishDirectory", () => {
  test("a valid folder passes and reaches the (fake) uploader once, with the CAR and its root", async () => {
    const f = await fixture();
    expect(await guardDirectory(f, f.named)).toEqual([]);
    const up = new FakeUploader();
    expect(await publishDirectory(f, up, f.named)).toEqual({ root: f.root });
    expect(up.imported).toEqual([
      { root: f.root, car_sha256: sha256Hex(f.car), bytes: f.car.length },
    ]);
  });

  test("refuses a folder holding a run manifest, and the uploader is never called", async () => {
    const f = await fixture();
    const files = [
      ...f.files,
      { name: "run_manifest.json", bytes: json(RUN_MANIFEST) },
    ];
    const car = await directoryCar(files);
    const up = new FakeUploader();
    const err = await publishDirectory(
      { files, root: car.root, car: car.car },
      up,
      f.named,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefused);
    expect(reasons((err as PublishRefused).refusals)).toEqual([
      "(directory): files must be exactly artifact-manifest.json, coverage.json; got artifact-manifest.json, coverage.json, run_manifest.json",
      "run_manifest.json: a run manifest is never published",
      "run_manifest.json: not a publish-folder file (only artifact-manifest.json and coverage.json)",
    ]);
    expect(up.imported).toEqual([]);
  });

  test("refuses a folder with a run manifest listed in its artifact manifest", async () => {
    const f = await fixture();
    const rm = json(RUN_MANIFEST);
    const manifest = {
      objects: [...f.manifest.objects, await entryFor("run_manifest.json", rm)],
    };
    const d = await withManifest(f, manifest);
    expect(reasons(await guardDirectory(d, f.named))).toEqual([
      "artifact-manifest.json objects[3] (run_manifest.json): a run manifest is never published",
    ]);
  });

  test("refuses the earlier four-file folder (run manifest and schema beside coverage and the manifest)", async () => {
    const f = await fixture();
    const d = await withManifest(f, f.manifest, [
      { name: "run_manifest.json", bytes: json(RUN_MANIFEST) },
      { name: "schema.json", bytes: json({ tables: [] }) },
    ]);
    const r = reasons(await guardDirectory(d, f.named));
    expect(r[0]).toMatch(/^\(directory\): files must be exactly/);
    expect(r).toContain("run_manifest.json: a run manifest is never published");
    expect(r).toContain(
      "schema.json: not a publish-folder file (only artifact-manifest.json and coverage.json)",
    );
  });

  test("refuses a folder without its artifact manifest", async () => {
    const f = await fixture();
    const files = [f.files[1]];
    const car = await directoryCar(files);
    expect(
      reasons(
        await guardDirectory({ files, root: car.root, car: car.car }, f.named),
      ),
    ).toEqual([
      "(directory): files must be exactly artifact-manifest.json, coverage.json; got coverage.json",
      "coverage.json: not listed in the artifact manifest",
    ]);
  });

  test("refuses an artifact manifest that is not { objects: [...] }", async () => {
    const f = await fixture();
    const d = await withManifest(f, { ...f.manifest, run_id: "r" });
    expect(reasons(await guardDirectory(d, f.named))).toEqual([
      "artifact-manifest.json: must be { objects: [...] }",
      "coverage.json: not listed in the artifact manifest",
    ]);
  });

  test("refuses coverage.json listed with the right size and sha256 but another CID", async () => {
    const f = await fixture();
    const manifest = {
      objects: f.manifest.objects.map((o) =>
        o.name === "coverage.json" ? { ...o, cid: f.named[0].cid } : o,
      ),
    };
    const d = await withManifest(f, manifest);
    expect(reasons(await guardDirectory(d, f.named))).toEqual([
      "coverage.json: CID or codec differs from the artifact manifest",
    ]);
  });

  test("refuses a CAR or root that is not the deterministic CAR of exactly these files", async () => {
    const f = await fixture();
    const other = await directoryCar([
      f.files[0],
      { name: "coverage.json", bytes: enc("{}") },
    ]);
    expect(
      reasons(
        await guardDirectory(
          { files: f.files, root: other.root, car: other.car },
          f.named,
        ),
      ),
    ).toEqual([
      "(car): root is not the CID of these files",
      "(car): CAR is not the deterministic CAR of these files",
    ]);
  });

  test("refuses a CAR over 1 MB", async () => {
    const f = await fixture(new Uint8Array(MAX_PUBLISH_BYTES).fill(32));
    expect(reasons(await guardDirectory(f, f.named))).toEqual([
      expect.stringMatching(/^\(car\): over 1 MB \(\d+ bytes > 1000000\)$/),
    ]);
  });

  test("an uploader that reports another root is an error", async () => {
    const f = await fixture();
    const liar: Uploader = { importCar: async () => ({ root: "bafy-other" }) };
    await expect(publishDirectory(f, liar, f.named)).rejects.toThrow(
      /uploader reported root bafy-other/,
    );
  });
});

describe("guardObject and publishObject", () => {
  async function object(name: string, bytes: Uint8Array) {
    const car = await fileCar(new Blob([new Uint8Array(bytes)]));
    return { name, bytes, root: car.root, car: car.car };
  }

  test("a named object's exact bytes pass with their CAR (Parquet and over 1 MB alike) and reach the uploader once", async () => {
    const { named, bytes } = await namedFixture();
    const o = await object("a.parquet", bytes["a.parquet"]);
    expect(o.root).toBe(named[0].cid);
    expect(await guardObject(o, named)).toEqual([]);
    // Over 1 MB and over one 1 MiB chunk, so its CID is dag-pb like the real objects'.
    const big = new Uint8Array(1_100_000).fill(7);
    big.set([0x50, 0x41, 0x52, 0x31]);
    const bigNamed: NamedObject[] = [
      {
        name: "big.parquet",
        size: big.length,
        sha256: sha256Hex(big),
        cid: (await bytesCidCodec(big)).cid,
        codec: (await bytesCidCodec(big)).codec,
      },
    ];
    expect(bigNamed[0].codec).toBe("dag-pb");
    const up = new FakeUploader();
    const ob = await object("big.parquet", big);
    expect(await publishObject(ob, up, bigNamed)).toEqual({ root: ob.root });
    expect(up.imported).toEqual([
      { root: ob.root, car_sha256: sha256Hex(ob.car), bytes: ob.car.length },
    ]);
  });

  test("refuses one changed byte, another name, a run manifest, a wrong root and a wrong CAR; the uploader is never called", async () => {
    const { named, bytes } = await namedFixture();
    const changed = new Uint8Array(bytes["a.parquet"]);
    changed[4] = 9;
    expect(
      reasons(await guardObject(await object("a.parquet", changed), named)),
    ).toEqual([
      `a.parquet: bytes are not the named object's (size 10, sha256 ${named[0].sha256})`,
    ]);
    expect(
      reasons(
        await guardObject(await object("c.parquet", bytes["a.parquet"]), named),
      ),
    ).toEqual(["c.parquet: not a named object"]);
    expect(
      reasons(
        await guardObject(
          await object("run_manifest.json", json(RUN_MANIFEST)),
          named,
        ),
      ),
    ).toEqual(["run_manifest.json: a run manifest is never published"]);
    const a = await object("a.parquet", bytes["a.parquet"]);
    const b = await object("b.parquet", bytes["b.parquet"]);
    expect(reasons(await guardObject({ ...a, root: b.root }, named))).toEqual([
      "(car): root is not the named object's CID",
    ]);
    expect(reasons(await guardObject({ ...a, car: b.car }, named))).toEqual([
      "(car): CAR is not the deterministic CAR of these bytes",
    ]);
    const up = new FakeUploader();
    await expect(
      publishObject({ ...a, car: b.car }, up, named),
    ).rejects.toBeInstanceOf(PublishRefused);
    expect(up.imported).toEqual([]);
  });

  test("the named objects are exactly the county extract and the 5-mile sample, by size and SHA-256", () => {
    expect(NAMED_OBJECTS).toEqual([
      {
        name: "los-angeles-roll2026-county.parquet",
        size: 32775616,
        sha256:
          "e73fb85e87ddeba3dbb973f04a2f97b85749b686b291db5078066575fdade987",
        cid: "bafybeifky42ojoid4c6tm54jpqw5ctwdsmuemtbrs6ebkmesz73knnd3de",
        codec: "dag-pb",
      },
      {
        name: "los-angeles-roll2026-sample-5mi.parquet",
        size: 1878244,
        sha256:
          "861f7f5e79332e86d5bb6d4960561d648cd9955d2ae890c100317c6918201bbc",
        cid: "bafybeidsmehgjsc5f4pzhgrbn6gtihv22cz2wjou46ajqfgt6tg4dwzx5a",
        codec: "dag-pb",
      },
    ]);
  });

  test("with the default named list, any other Parquet is refused as an object", async () => {
    const o = await object(
      "los-angeles-roll2026-county.parquet",
      parquetBytes(3),
    );
    expect(reasons(await guardObject(o))).toEqual([
      `los-angeles-roll2026-county.parquet: bytes are not the named object's (size 32775616, sha256 ${NAMED_OBJECTS[0].sha256})`,
    ]);
  });
});
