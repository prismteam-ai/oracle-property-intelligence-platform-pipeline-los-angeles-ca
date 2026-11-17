import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildArtifactManifest,
  jsonBytes,
  namedObjectEntry,
  objectOf,
} from "../src/artifact-manifest.ts";
import { buildPublication } from "../src/build-ipfs-artifacts.ts";
import { bytesCidCodec, directoryCar, sha256Hex } from "../src/ipfs-unixfs.ts";
import { guardDirectory, guardObject } from "../src/publish-guard.ts";
import type { NamedObject } from "../src/publish-named-objects.ts";
import {
  NotRecorded,
  buildCoverage,
  pagesSha256,
  type RunManifestLike,
} from "../src/publishable-docs.ts";
import { loadRunConfig } from "../src/run-config.ts";

const RUN = "2026-01-02T03-04-05-678Z-b0123456789ab";
const config = loadRunConfig("config/la-county-permits-run.json");
const hex = (c: string) => c.repeat(64);

/** A synthetic run manifest with the recorded shape, including keys coverage.json must not copy. */
function runManifest(files: unknown[] = []) {
  return {
    run_id: RUN,
    run_name: config.run_name,
    generated_at: "2026-01-02T04:00:00.000Z",
    county: "Los Angeles",
    state: "CA",
    roll_year: "2026",
    sources: [
      {
        name: config.source.name,
        terms_of_use: config.source.terms_of_use,
        hub_page: "https://example.invalid/hub",
      },
      {
        name: config.permit_sources!.permits.name,
        datasets: config.permit_sources!.permits.datasets,
        terms_of_use: "https://example.invalid/permit-terms",
      },
      {
        name: config.permit_sources!.contractors.name,
        datasets: ["8guu-8f5m"],
      },
    ],
    cache: {
      summary: { generated_at: "2026-01-01T02:00:00.000Z", total_rows: 3 },
      pages: [
        {
          page: 0,
          request_url: "https://example.invalid/q?o=0",
          fetched_at: "2026-01-01T01:00:00.000Z",
          body_sha256: hex("a"),
        },
        {
          page: 1,
          request_url: "https://example.invalid/q?o=1",
          fetched_at: "2026-01-01T01:59:59.000Z",
          body_sha256: hex("b"),
        },
      ],
    },
    permit_caches: {
      permits: {
        generated_at: "2026-01-02T03:00:00.000Z",
        pages: [
          {
            retrieved_at: "2026-01-02T02:59:00.000Z",
            json_sha256: hex("c"),
            gz_sha256: hex("d"),
          },
        ],
      },
      contractors: { generated_at: "2026-01-02T03:04:05.678Z", pages: [] },
    },
    row_counts: { parquet: 3, raw_pages: 2 },
    coverage: {
      with_coordinates: 2,
      with_year_built: 1,
      permit_data: { parcels_with_permits: 1 },
    },
    permits: { contractors: { rows: 1 } },
    delta: { previous_run_id: null, added: 3, removed: 0 },
    run_kind: "new data",
    rebuild_of: null,
    build_digest: hex("e"),
    files,
    limitations: ["Synthetic limitation."],
  };
}

describe("coverage.json", () => {
  test("pages_sha256 is SHA-256 over each lowercase hex digest plus a line feed, in recorded order", () => {
    const a = hex("a");
    const b = hex("b");
    expect(pagesSha256([a, b])).toBe(
      createHash("sha256").update(`${a}\n${b}\n`).digest("hex"),
    );
    expect(pagesSha256([b, a])).not.toBe(pagesSha256([a, b]));
    expect(() => pagesSha256([a.toUpperCase()])).toThrow(/lowercase hex/);
    expect(() => pagesSha256([])).toThrow(NotRecorded);
  });

  test("holds only the listed values, in a fixed key order, with the roll's terms address from the run config", () => {
    const m = runManifest() as RunManifestLike;
    const cov = buildCoverage(m, config, 5);
    expect(JSON.stringify(cov, null, 2)).toBe(
      JSON.stringify(
        {
          run_id: RUN,
          generated_at: "2026-01-02T04:00:00.000Z",
          run_kind: "new data",
          rebuild_of: null,
          county: "Los Angeles",
          roll_year: "2026",
          parcels: { total: 3, with_coordinates: 2, with_year_built: 1 },
          permits: 5,
          sources: [
            {
              name: config.source.name,
              download_finished_at: "2026-01-01T02:00:00.000Z",
              pages_sha256: pagesSha256([hex("a"), hex("b")]),
              terms_of_use:
                "https://egis-lacounty.hub.arcgis.com/pages/terms-of-use",
            },
            {
              name: "LADBS building permits (City of Los Angeles, data.lacity.org)",
              download_finished_at: "2026-01-02T03:00:00.000Z",
              pages_sha256: pagesSha256([hex("c")]),
            },
          ],
        },
        null,
        2,
      ),
    );
    expect(JSON.stringify(cov)).not.toMatch(
      /contractor|limitation|example\.invalid|request_url|gz_sha256|files|pages"/,
    );
  });

  test("run_kind and rebuild_of are copied exactly, a rebuild included", () => {
    const m = {
      ...runManifest(),
      run_kind: "rebuild",
      rebuild_of: "2026-01-01T00-00-00-000Z",
    } as RunManifestLike;
    expect(buildCoverage(m, config, 5)).toMatchObject({
      run_kind: "rebuild",
      rebuild_of: "2026-01-01T00-00-00-000Z",
    });
  });

  test("stops on a value not in the recorded files, or on files that disagree, instead of filling it in", () => {
    const stops: [string, (m: Record<string, unknown>) => void, RegExp][] = [
      ["run_kind absent", (m) => delete m.run_kind, /run_kind is not recorded/],
      [
        "rebuild_of absent",
        (m) => delete m.rebuild_of,
        /rebuild_of is not recorded/,
      ],
      [
        "with_year_built absent",
        (m) => (m.coverage = { with_coordinates: 2 }),
        /coverage\.with_year_built is not recorded/,
      ],
      [
        "roll summary time absent",
        (m) => ((m.cache as { summary: object }).summary = {}),
        /roll download summary generated_at is not recorded/,
      ],
      [
        "summary before the last page",
        (m) =>
          ((m.cache as { summary: object }).summary = {
            generated_at: "2026-01-01T01:30:00.000Z",
          }),
        /earlier than its last page/,
      ],
      [
        "a page digest absent",
        (m) =>
          delete (
            m.permit_caches as { permits: { pages: Record<string, unknown>[] } }
          ).permits.pages[0].json_sha256,
        /permits page 0 json_sha256 is not recorded/,
      ],
      [
        "permit source absent",
        (m) => (m.sources = (m.sources as unknown[]).slice(0, 1)),
        /records 0 sources named "LADBS building permits/,
      ],
      [
        "terms address differs",
        (m) =>
          ((m.sources as Record<string, unknown>[])[0].terms_of_use =
            "https://example.invalid/other"),
        /terms_of_use differs/,
      ],
      ["another county", (m) => (m.county = "Orange"), /is not this run's/],
    ];
    for (const [, change, error] of stops) {
      const m = structuredClone(runManifest()) as Record<string, unknown>;
      change(m);
      expect(() => buildCoverage(m as RunManifestLike, config, 5)).toThrow(
        error,
      );
    }
    expect(() =>
      buildCoverage(runManifest() as RunManifestLike, config, -1),
    ).toThrow(/permits Parquet row count/);
  });
});

describe("artifact-manifest.json", () => {
  test("lists each object once with cid, name, size, codec and sha256 in that order, sorted by name, not itself", async () => {
    const cov = new TextEncoder().encode('{"run_id":"r"}\n');
    const named: NamedObject = {
      name: "a.parquet",
      size: 7,
      sha256: hex("f"),
      cid: "bafy-a",
      codec: "dag-pb",
    };
    const m = buildArtifactManifest([
      namedObjectEntry(named),
      await objectOf("coverage.json", cov),
    ]);
    const { cid, codec } = await bytesCidCodec(cov);
    expect(new TextDecoder().decode(jsonBytes(m))).toBe(
      JSON.stringify(
        {
          objects: [
            {
              cid: "bafy-a",
              name: "a.parquet",
              size: 7,
              codec: "dag-pb",
              sha256: hex("f"),
            },
            {
              cid,
              name: "coverage.json",
              size: cov.length,
              codec,
              sha256: sha256Hex(cov),
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    expect(codec).toBe("raw");
  });
});

describe("buildPublication (the build-ipfs-artifacts tool)", () => {
  let root = "";
  let objectsDir = "";
  let outDir = "";
  const named: NamedObject[] = [];
  const objectPaths = () => named.map((n) => join(objectsDir, n.name));

  const tree = (d: string) => {
    const out: Record<string, string> = {};
    const walk = (p: string) => {
      for (const n of readdirSync(p)) {
        const f = join(p, n);
        if (statSync(f).isDirectory()) walk(f);
        else out[relative(d, f)] = sha256Hex(new Uint8Array(readFileSync(f)));
      }
    };
    walk(d);
    return out;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "publication-src-"));
    objectsDir = mkdtempSync(join(tmpdir(), "publication-objects-"));
    outDir = mkdtempSync(join(tmpdir(), "publication-out-"));
    const c = await (await DuckDBInstance.create(":memory:")).connect();
    const outFile = (f: string) => join(root, `data/out/${RUN}/${f}`);
    mkdirSync(dirname(outFile("x")), { recursive: true });
    const q = (p: string) => p.replaceAll("'", "''");
    await c.run(
      `COPY (SELECT * FROM (VALUES ('1', 34.1, 1950), ('2', 34.2, NULL), ('3', NULL, NULL)) t(parcel_identifier, latitude, property_structure_built_year)) TO '${q(outFile("los-angeles_property_roll2026.parquet"))}' (FORMAT parquet)`,
    );
    await c.run(
      `COPY (SELECT range::VARCHAR AS permit_number FROM range(5)) TO '${q(outFile("los-angeles_ladbs_permits.parquet"))}' (FORMAT parquet)`,
    );
    for (const [i, name] of ["x-county.parquet", "x-sample.parquet"].entries())
      await c.run(
        `COPY (SELECT ${i} AS n) TO '${q(join(objectsDir, name))}' (FORMAT parquet)`,
      );
    c.closeSync();
    const rec = (name: string, rows: number) => {
      const b = new Uint8Array(readFileSync(outFile(name)));
      return {
        name,
        path: `data/out/${RUN}/${name}`,
        size_bytes: b.length,
        sha256: sha256Hex(b),
        row_count: rows,
      };
    };
    const manifest = runManifest([
      rec("los-angeles_property_roll2026.parquet", 3),
      rec("los-angeles_ladbs_permits.parquet", 5),
    ]);
    mkdirSync(join(root, `runs/${RUN}`), { recursive: true });
    writeFileSync(
      join(root, `runs/${RUN}/run_manifest.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    for (const name of ["x-county.parquet", "x-sample.parquet"]) {
      const b = new Uint8Array(readFileSync(join(objectsDir, name)));
      const { cid, codec } = await bytesCidCodec(b);
      named.push({ name, size: b.length, sha256: sha256Hex(b), cid, codec });
    }
  });
  afterAll(() => {
    for (const d of [root, objectsDir, outDir])
      rmSync(d, { recursive: true, force: true });
  });

  const build = (out = outDir, objects = objectPaths()) =>
    buildPublication({
      source: root,
      out,
      config,
      objects,
      runIds: [RUN],
      named,
    });

  test("writes the folder, its CAR and directory.json, and the objects with their CARs; passes the guard; leaves the source untouched; is deterministic", async () => {
    const before = tree(root);
    expect(await build()).toBe(true);
    const first = tree(outDir);
    expect(tree(root)).toEqual(before);
    expect(Object.keys(first).sort()).toEqual([
      "objects.json",
      "objects/x-county.parquet",
      "objects/x-county.parquet.car",
      "objects/x-sample.parquet",
      "objects/x-sample.parquet.car",
      `runs/${RUN}/directory.car`,
      `runs/${RUN}/directory.json`,
      `runs/${RUN}/publish/artifact-manifest.json`,
      `runs/${RUN}/publish/coverage.json`,
    ]);
    const read = (p: string) => new Uint8Array(readFileSync(join(outDir, p)));
    const coverage = JSON.parse(
      new TextDecoder().decode(read(`runs/${RUN}/publish/coverage.json`)),
    );
    expect(coverage.parcels).toEqual({
      total: 3,
      with_coordinates: 2,
      with_year_built: 1,
    });
    expect(coverage.permits).toBe(5);
    const am = JSON.parse(
      new TextDecoder().decode(
        read(`runs/${RUN}/publish/artifact-manifest.json`),
      ),
    );
    expect(am.objects.map((o: { name: string }) => o.name)).toEqual([
      "coverage.json",
      "x-county.parquet",
      "x-sample.parquet",
    ]);
    const files = [
      {
        name: "artifact-manifest.json",
        bytes: read(`runs/${RUN}/publish/artifact-manifest.json`),
      },
      {
        name: "coverage.json",
        bytes: read(`runs/${RUN}/publish/coverage.json`),
      },
    ];
    const dirJson = JSON.parse(
      new TextDecoder().decode(read(`runs/${RUN}/directory.json`)),
    );
    const car = await directoryCar(files);
    expect(dirJson).toMatchObject({
      run_id: RUN,
      directory_cid: car.root,
      car: { size: car.car.length, sha256: car.car_sha256 },
      publish_guard: { passes: true, refusals: [] },
      scans: { hits: [] },
    });
    expect(sha256Hex(read(`runs/${RUN}/directory.car`))).toBe(car.car_sha256);
    expect(
      await guardDirectory(
        { files, root: car.root, car: read(`runs/${RUN}/directory.car`) },
        named,
      ),
    ).toEqual([]);
    for (const n of named) {
      expect(read(`objects/${n.name}`)).toEqual(
        new Uint8Array(readFileSync(join(objectsDir, n.name))),
      );
      expect(
        await guardObject(
          {
            name: n.name,
            bytes: read(`objects/${n.name}`),
            root: n.cid,
            car: read(`objects/${n.name}.car`),
          },
          named,
        ),
      ).toEqual([]);
    }
    expect(await build()).toBe(true);
    expect(tree(outDir)).toEqual(first);
  });

  test("a given object that is not the named bytes is refused by the guard, and the build reports it", async () => {
    const bad = mkdtempSync(join(tmpdir(), "publication-bad-"));
    const out = mkdtempSync(join(tmpdir(), "publication-out2-"));
    try {
      writeFileSync(join(bad, "x-county.parquet"), "PAR1 changed PAR1");
      const ok = await build(out, [
        join(bad, "x-county.parquet"),
        objectPaths()[1],
      ]);
      expect(ok).toBe(false);
      const rec = JSON.parse(readFileSync(join(out, "objects.json"), "utf8"));
      expect(rec.objects[0].publish_guard.passes).toBe(false);
      expect(rec.objects[1].publish_guard.passes).toBe(true);
    } finally {
      rmSync(bad, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("stops when a recorded Parquet output differs from the run manifest", async () => {
    const p = join(root, `data/out/${RUN}/los-angeles_ladbs_permits.parquet`);
    const original = readFileSync(p);
    const out = mkdtempSync(join(tmpdir(), "publication-out3-"));
    try {
      writeFileSync(p, Buffer.concat([original, Buffer.from(" ")]));
      await expect(build(out)).rejects.toThrow(/is not the recorded file/);
    } finally {
      writeFileSync(p, original);
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("needs every named object and refuses an output folder inside the run folders", async () => {
    await expect(build(outDir, objectPaths().slice(0, 1))).rejects.toThrow(
      /give --object <path to x-sample\.parquet>/,
    );
    await expect(build(join(root, "runs/x"))).rejects.toThrow(
      /must not be inside the run folders/,
    );
  });

  test("the command line needs --config, and builds nothing without the real named objects", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["src/build-ipfs-artifacts.ts", "--source", root, RUN],
        { stdio: "pipe" },
      ),
    ).toThrow(/give --config <run config>/);
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "src/build-ipfs-artifacts.ts",
          "--source",
          root,
          "--config",
          "config/la-county-permits-run.json",
          "--out",
          join(outDir, "cli"),
          RUN,
        ],
        { stdio: "pipe" },
      ),
    ).toThrow(/give --object <path to los-angeles-roll2026-county\.parquet>/);
  });
});
