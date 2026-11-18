import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { folderEntry } from "../src/artifact-manifest.ts";
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
  guardManifestFile,
  guardObject,
  holdsRunManifest,
  isRunManifestName,
  publishDirectory,
  publishManifest,
  publishObject,
  type ArtifactManifest,
  type Candidate,
  type PublishedObject,
  type Uploader,
} from "../src/publish-guard.ts";
import {
  NAMED_OBJECTS,
  PUBLISHED_SAMPLE,
  type NamedObject,
} from "../src/publish-named-objects.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(JSON.stringify(v, null, 2) + "\n");
const parquetBytes = (fill: number) =>
  new Uint8Array([0x50, 0x41, 0x52, 0x31, fill, fill, 0x50, 0x41, 0x52, 0x31]);
const blob = (b: Uint8Array) => new Blob([new Uint8Array(b)]);

async function entryFor(
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

/** Two small named "Parquet" objects, standing in for the real ones in every test but the last. */
async function namedFixture() {
  const a = parquetBytes(1);
  const b = parquetBytes(2);
  const named: NamedObject[] = [
    await entryFor("a.parquet", a),
    await entryFor("b.parquet", b),
  ].map(({ cid, name, size, ipld_codec, sha256 }) => ({
    name,
    size,
    sha256,
    cid,
    ipld_codec,
  }));
  return { named, bytes: { "a.parquet": a, "b.parquet": b } };
}

const namedEntries = (named: NamedObject[]): PublishedObject[] =>
  named.map((n) => ({
    cid: n.cid,
    name: n.name,
    size: n.size,
    codec: "file" as const,
    ipld_codec: n.ipld_codec,
    sha256: n.sha256,
  }));

/** The manifest as its own published file: bytes, CID and CAR. */
async function manifestFile(manifest: unknown) {
  const bytes = json(manifest);
  const car = await fileCar(blob(bytes));
  return {
    name: "artifact-manifest.json",
    bytes,
    root: car.root,
    car: car.car,
  };
}

/**
 * A valid publication of one run: the publish folder (coverage.json only) with its CAR, and the
 * artifact manifest beside it listing the folder first, then coverage.json and the named objects.
 */
async function fixture(
  coverage = json({ run_id: "r", parcels: { total: 3 } }),
) {
  const { named, bytes } = await namedFixture();
  const files: Candidate[] = [{ name: "coverage.json", bytes: coverage }];
  const car = await directoryCar(files);
  const manifest: ArtifactManifest = {
    objects: [
      folderEntry(car),
      await entryFor("coverage.json", coverage),
      ...namedEntries(named),
    ],
  };
  const mf = await manifestFile(manifest);
  return {
    named,
    objects: bytes,
    manifest,
    manifestBytes: mf.bytes,
    manifestFile: mf,
    files,
    root: car.root,
    car: car.car,
  };
}

/** A folder with other files, its CAR rebuilt, and a manifest whose directory entry matches it. */
async function withFolder(
  f: Awaited<ReturnType<typeof fixture>>,
  files: Candidate[],
) {
  const car = await directoryCar(files);
  const manifest = {
    objects: [folderEntry(car), ...f.manifest.objects.slice(1)],
  };
  return { files, root: car.root, car: car.car, manifestBytes: json(manifest) };
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

describe("guardFile (a publish-folder file)", () => {
  test("accepts coverage.json listed in the run's artifact manifest with its bytes", async () => {
    const f = await fixture();
    expect(guardFile(f.files[0], f.manifest)).toEqual([]);
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
        guardFile({ name, bytes: enc("{}") }, f.manifest).map((r) => r.reason),
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
        guardFile({ name: "coverage.json", bytes }, f.manifest).map(
          (r) => r.reason,
        ),
      ).toContain("holds a run manifest; a run manifest is never published");
    }
    // coverage.json and the artifact manifest share run_id or other words, never the run-manifest keys.
    expect(holdsRunManifest(f.files[0].bytes)).toBe(false);
    expect(
      holdsRunManifest(
        json({
          run_id: "r",
          run_kind: "rebuild",
          rebuild_of: "q",
          sample: { rows: 1 },
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
        guardFile({ name: "coverage.json", bytes }, f.manifest).map(
          (r) => r.reason,
        ),
      ).toContain("holds a run manifest; a run manifest is never published");
    }
  });

  test("refuses Parquet in the folder by name or by magic bytes, also a named object's exact bytes", async () => {
    const f = await fixture();
    const a = f.objects["a.parquet"];
    expect(
      reasons(guardFile({ name: "a.parquet", bytes: a }, f.manifest)),
    ).toEqual([
      "a.parquet: not a publish-folder file (only coverage.json)",
      "a.parquet: Parquet is never in a publish folder (only as a named object)",
    ]);
    const trailer = new Uint8Array([123, 125, 0x50, 0x41, 0x52, 0x31]);
    expect(
      guardFile({ name: "coverage.json", bytes: trailer }, f.manifest).map(
        (r) => r.reason,
      ),
    ).toContain(
      "Parquet is never in a publish folder (only as a named object)",
    );
  });

  test("refuses a file over 1 MB (1,000,000 bytes) even when the manifest lists it; 1,000,000 bytes pass", async () => {
    const big = new Uint8Array(MAX_PUBLISH_BYTES + 1).fill(32);
    const f = await fixture(big);
    expect(
      reasons(guardFile({ name: "coverage.json", bytes: big }, f.manifest)),
    ).toEqual(["coverage.json: over 1 MB (1000001 bytes > 1000000)"]);
    const atLimit = new Uint8Array(MAX_PUBLISH_BYTES).fill(32);
    const g = await fixture(atLimit);
    expect(
      guardFile({ name: "coverage.json", bytes: atLimit }, g.manifest),
    ).toEqual([]);
  });

  test("refuses the artifact manifest or another file in the folder, and coverage not listed or with changed bytes", async () => {
    const f = await fixture();
    expect(
      reasons(
        guardFile(
          { name: "artifact-manifest.json", bytes: f.manifestBytes },
          f.manifest,
        ),
      ),
    ).toEqual([
      "artifact-manifest.json: not a publish-folder file (only coverage.json)",
    ]);
    expect(
      reasons(guardFile({ name: "schema.json", bytes: enc("{}") }, f.manifest)),
    ).toEqual(["schema.json: not a publish-folder file (only coverage.json)"]);
    expect(
      reasons(
        guardFile(
          { name: "coverage.json", bytes: enc('{"run_id":"s"}\n') },
          f.manifest,
        ),
      ),
    ).toEqual([
      "coverage.json: bytes differ from the artifact manifest's size and sha256",
    ]);
    expect(reasons(guardFile(f.files[0], { objects: [] }))).toEqual([
      "coverage.json: not listed in the artifact manifest",
    ]);
  });
});

describe("guardManifest", () => {
  test("accepts the folder first, then coverage.json and every named object with its exact values", async () => {
    const f = await fixture();
    expect(guardManifest(f.manifest, f.named)).toEqual([]);
    expect(f.manifest.objects[0]).toEqual({
      cid: f.root,
      name: "publish",
      size: f.car.length,
      codec: "directory",
      ipld_codec: "dag-pb",
      sha256: sha256Hex(f.car),
    });
  });

  test("refuses an entry for a run manifest, for itself, for any other object, and a duplicate", async () => {
    const f = await fixture();
    const extra = (name: string): PublishedObject => ({
      cid: "bafkrei-x",
      name,
      size: 1,
      codec: "file",
      ipld_codec: "raw",
      sha256: "0".repeat(64),
    });
    const m: ArtifactManifest = {
      objects: [
        ...f.manifest.objects,
        extra("run_manifest.json"),
        extra("artifact-manifest.json"),
        extra("schema.json"),
        f.manifest.objects[1],
      ],
    };
    expect(reasons(guardManifest(m, f.named))).toEqual([
      "artifact-manifest.json objects[4] (run_manifest.json): a run manifest is never published",
      "artifact-manifest.json objects[5] (artifact-manifest.json): the artifact manifest lists itself",
      "artifact-manifest.json objects[6] (schema.json): not a publishable object (coverage.json or a named object)",
      "artifact-manifest.json objects[7] (coverage.json): listed more than once",
    ]);
  });

  test("refuses no directory, two directories, a directory not first or not the publish folder", async () => {
    const f = await fixture();
    const [dir, ...rest] = f.manifest.objects;
    expect(reasons(guardManifest({ objects: rest }, f.named))).toEqual([
      "artifact-manifest.json: must list exactly one directory (the publish folder); lists 0",
    ]);
    expect(
      reasons(guardManifest({ objects: [...rest, dir] }, f.named)),
    ).toEqual([
      "artifact-manifest.json objects[3] (publish): the folder must be listed first",
    ]);
    expect(
      reasons(
        guardManifest(
          { objects: [dir, ...rest, { ...dir, name: "other" }] },
          f.named,
        ),
      ),
    ).toEqual([
      "artifact-manifest.json objects[4] (other): the folder must be listed first",
      'artifact-manifest.json objects[4] (other): the one directory is the publish folder ("publish", ipld_codec dag-pb)',
      "artifact-manifest.json: must list exactly one directory (the publish folder); lists 2",
    ]);
    expect(
      reasons(
        guardManifest(
          { objects: [{ ...dir, ipld_codec: "raw" }, ...rest] },
          f.named,
        ),
      ),
    ).toEqual([
      'artifact-manifest.json objects[0] (publish): the one directory is the publish folder ("publish", ipld_codec dag-pb)',
    ]);
  });

  test("refuses a named object's entry that differs in CID, size, IPLD codec or sha256", async () => {
    const f = await fixture();
    const changes: Partial<PublishedObject>[] = [
      { cid: f.named[1].cid },
      { size: 11 },
      { ipld_codec: "dag-pb" },
      { sha256: "0".repeat(64) },
    ];
    for (const change of changes) {
      const m: ArtifactManifest = {
        objects: f.manifest.objects.map((o) =>
          o.name === "a.parquet" ? { ...o, ...change } : o,
        ),
      };
      expect(reasons(guardManifest(m, f.named))).toEqual([
        "artifact-manifest.json objects[2] (a.parquet): not the named object's exact CID, size, IPLD codec and sha256",
      ]);
    }
  });

  test('refuses a file entry whose codec is neither "file" nor "directory"', async () => {
    const f = await fixture();
    const m = {
      objects: f.manifest.objects.map((o) =>
        o.name === "coverage.json" ? { ...o, codec: "raw" } : o,
      ),
    } as unknown as ArtifactManifest;
    expect(reasons(guardManifest(m, f.named))).toEqual([
      'artifact-manifest.json objects[1] (coverage.json): codec must be "file" or "directory"',
    ]);
  });

  test("refuses a manifest that leaves out coverage.json or a named object, or an entry with other keys", async () => {
    const f = await fixture();
    expect(
      reasons(
        guardManifest(
          { objects: [f.manifest.objects[0], f.manifest.objects[2]] },
          f.named,
        ),
      ),
    ).toEqual([
      "artifact-manifest.json: does not list coverage.json",
      "artifact-manifest.json: does not list b.parquet",
    ]);
    const withRole = {
      objects: f.manifest.objects.map((o, i) =>
        i === 1 ? { ...o, role: "x" } : o,
      ),
    } as unknown as ArtifactManifest;
    expect(reasons(guardManifest(withRole, f.named))).toEqual([
      "artifact-manifest.json objects[1] (coverage.json): keys must be exactly cid, name, size, codec, ipld_codec, sha256",
      "artifact-manifest.json: does not list coverage.json",
    ]);
  });
});

describe("guardManifestFile and publishManifest (the manifest as its own published file)", () => {
  test("a valid manifest with its CAR passes and reaches the (fake) uploader once", async () => {
    const f = await fixture();
    expect(await guardManifestFile(f.manifestFile, f.named)).toEqual([]);
    const up = new FakeUploader();
    expect(await publishManifest(f.manifestFile, up, f.named)).toEqual({
      root: f.manifestFile.root,
    });
    expect(up.imported).toEqual([
      {
        root: f.manifestFile.root,
        car_sha256: sha256Hex(f.manifestFile.car),
        bytes: f.manifestFile.car.length,
      },
    ]);
  });

  test("refuses another name, a run manifest, malformed JSON, the manifest rules, and a wrong root or CAR", async () => {
    const f = await fixture();
    expect(
      reasons(
        await guardManifestFile({ ...f.manifestFile, name: "m.json" }, f.named),
      ),
    ).toEqual(["m.json: an artifact manifest is named artifact-manifest.json"]);
    const rm = await manifestFile(RUN_MANIFEST);
    expect(reasons(await guardManifestFile(rm, f.named))).toEqual([
      "artifact-manifest.json: holds a run manifest; a run manifest is never published",
      "artifact-manifest.json: must be { objects: [...] }",
    ]);
    const bad = { ...f.manifestFile, bytes: enc("{") };
    const badCar = await fileCar(blob(bad.bytes));
    expect(
      reasons(
        await guardManifestFile(
          { ...bad, root: badCar.root, car: badCar.car },
          f.named,
        ),
      ),
    ).toEqual(["artifact-manifest.json: not valid JSON"]);
    const noDir = await manifestFile({ objects: f.manifest.objects.slice(1) });
    expect(reasons(await guardManifestFile(noDir, f.named))).toEqual([
      "artifact-manifest.json: must list exactly one directory (the publish folder); lists 0",
    ]);
    expect(
      reasons(
        await guardManifestFile(
          { ...f.manifestFile, root: noDir.root },
          f.named,
        ),
      ),
    ).toEqual(["(car): root is not the CID of these bytes"]);
    const up = new FakeUploader();
    await expect(
      publishManifest({ ...f.manifestFile, car: noDir.car }, up, f.named),
    ).rejects.toBeInstanceOf(PublishRefused);
    expect(up.imported).toEqual([]);
  });
});

describe("guardDirectory and publishDirectory", () => {
  test("a valid folder passes and reaches the (fake) uploader once, with the CAR and its root", async () => {
    const f = await fixture();
    expect(await guardDirectory(f, f.manifestBytes)).toEqual([]);
    const up = new FakeUploader();
    expect(await publishDirectory(f, f.manifestBytes, up)).toEqual({
      root: f.root,
    });
    expect(up.imported).toEqual([
      { root: f.root, car_sha256: sha256Hex(f.car), bytes: f.car.length },
    ]);
  });

  test("refuses a folder holding a run manifest, and the uploader is never called", async () => {
    const f = await fixture();
    const d = await withFolder(f, [
      ...f.files,
      { name: "run_manifest.json", bytes: json(RUN_MANIFEST) },
    ]);
    const up = new FakeUploader();
    const err = await publishDirectory(d, d.manifestBytes, up).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishRefused);
    expect(reasons((err as PublishRefused).refusals)).toEqual([
      "(directory): files must be exactly coverage.json; got coverage.json, run_manifest.json",
      "run_manifest.json: a run manifest is never published",
      "run_manifest.json: not a publish-folder file (only coverage.json)",
    ]);
    expect(up.imported).toEqual([]);
  });

  test("refuses the artifact manifest inside the folder (the earlier two-file layout)", async () => {
    const f = await fixture();
    const d = await withFolder(f, [
      { name: "artifact-manifest.json", bytes: f.manifestBytes },
      ...f.files,
    ]);
    expect(reasons(await guardDirectory(d, d.manifestBytes))).toEqual([
      "(directory): files must be exactly coverage.json; got artifact-manifest.json, coverage.json",
      "artifact-manifest.json: not a publish-folder file (only coverage.json)",
    ]);
  });

  test("refuses a folder whose manifest's directory entry is another folder or another CAR", async () => {
    const f = await fixture();
    const other = await directoryCar([
      { name: "coverage.json", bytes: enc("{}") },
    ]);
    const m = (dir: PublishedObject) =>
      json({ objects: [dir, ...f.manifest.objects.slice(1)] });
    const dir = f.manifest.objects[0];
    for (const changed of [
      { ...dir, cid: other.root },
      { ...dir, size: dir.size + 1 },
      { ...dir, sha256: other.car_sha256 },
    ])
      expect(reasons(await guardDirectory(f, m(changed)))).toEqual([
        "(directory): the artifact manifest's directory is not this folder (CID, CAR size and sha256)",
      ]);
  });

  test("refuses a malformed manifest and still checks the folder's files", async () => {
    const f = await fixture();
    expect(reasons(await guardDirectory(f, enc("{")))).toEqual([
      "artifact-manifest.json: not valid JSON",
      "coverage.json: not listed in the artifact manifest",
    ]);
    expect(
      reasons(await guardDirectory(f, json({ ...f.manifest, run_id: "r" }))),
    ).toEqual([
      "artifact-manifest.json: must be { objects: [...] }",
      "coverage.json: not listed in the artifact manifest",
    ]);
  });

  test("refuses coverage.json listed with the right size and sha256 but another CID", async () => {
    const f = await fixture();
    const m = json({
      objects: f.manifest.objects.map((o) =>
        o.name === "coverage.json" ? { ...o, cid: f.named[0].cid } : o,
      ),
    });
    expect(reasons(await guardDirectory(f, m))).toEqual([
      "coverage.json: CID or IPLD codec differs from the artifact manifest",
    ]);
  });

  test("refuses a CAR or root that is not the deterministic CAR of exactly these files", async () => {
    const f = await fixture();
    const other = await directoryCar([
      { name: "coverage.json", bytes: enc("{}") },
    ]);
    const r = reasons(
      await guardDirectory(
        { files: f.files, root: other.root, car: other.car },
        f.manifestBytes,
      ),
    );
    expect(r).toEqual([
      "(car): root is not the CID of these files",
      "(car): CAR is not the deterministic CAR of these files",
      "(directory): the artifact manifest's directory is not this folder (CID, CAR size and sha256)",
    ]);
  });

  test("refuses the folder's blocks written leaf first (the order before the gateways' root-first CAR), even when the manifest lists that CAR", async () => {
    const f = await fixture();
    // The folder CAR is a header, the root block, then coverage.json's one raw block.
    const section = (at: number) => {
      let len = 0;
      let i = at;
      for (let shift = 1; ; i++, shift *= 128) {
        len += (f.car[i] & 0x7f) * shift;
        if (f.car[i] < 0x80) break;
      }
      return i + 1 + len;
    };
    const rootAt = section(0);
    const leafAt = section(rootAt);
    expect(section(leafAt)).toBe(f.car.length);
    const leafFirst = new Uint8Array(
      Buffer.concat([
        f.car.subarray(0, rootAt),
        f.car.subarray(leafAt),
        f.car.subarray(rootAt, leafAt),
      ]),
    );
    expect(leafFirst.length).toBe(f.car.length);
    const candidate = { files: f.files, root: f.root, car: leafFirst };
    expect(reasons(await guardDirectory(candidate, f.manifestBytes))).toEqual([
      "(car): CAR is not the deterministic CAR of these files",
      "(directory): the artifact manifest's directory is not this folder (CID, CAR size and sha256)",
    ]);
    const listsLeafFirst = json({
      objects: [
        { ...f.manifest.objects[0], sha256: sha256Hex(leafFirst) },
        ...f.manifest.objects.slice(1),
      ],
    });
    expect(reasons(await guardDirectory(candidate, listsLeafFirst))).toEqual([
      "(car): CAR is not the deterministic CAR of these files",
    ]);
  });

  test("refuses a CAR over 1 MB", async () => {
    const f = await fixture(new Uint8Array(MAX_PUBLISH_BYTES).fill(32));
    expect(reasons(await guardDirectory(f, f.manifestBytes))).toEqual([
      expect.stringMatching(/^\(car\): over 1 MB \(\d+ bytes > 1000000\)$/),
    ]);
  });

  test("an uploader that reports another root is an error", async () => {
    const f = await fixture();
    const liar: Uploader = { importCar: async () => ({ root: "bafy-other" }) };
    await expect(publishDirectory(f, f.manifestBytes, liar)).rejects.toThrow(
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
        ipld_codec: (await bytesCidCodec(big)).codec,
      },
    ];
    expect(bigNamed[0].ipld_codec).toBe("dag-pb");
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
        ipld_codec: "dag-pb",
      },
      {
        name: "los-angeles-roll2026-sample-5mi.parquet",
        size: 1878244,
        sha256:
          "861f7f5e79332e86d5bb6d4960561d648cd9955d2ae890c100317c6918201bbc",
        cid: "bafybeidsmehgjsc5f4pzhgrbn6gtihv22cz2wjou46ajqfgt6tg4dwzx5a",
        ipld_codec: "dag-pb",
      },
    ]);
  });

  test("the published sample is the 5-mile sample object: its recorded center and radius, 151,748 rows", () => {
    expect(PUBLISHED_SAMPLE).toEqual({
      object: "los-angeles-roll2026-sample-5mi.parquet",
      center_latitude: 34.20155,
      center_longitude: -118.45361,
      radius_miles: 5,
      rows: 151748,
    });
    expect(NAMED_OBJECTS.map((n) => n.name)).toContain(PUBLISHED_SAMPLE.object);
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
