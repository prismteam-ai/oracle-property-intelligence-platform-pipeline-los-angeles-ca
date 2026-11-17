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
  PUBLISHABLE_FILES,
  buildArtifactManifest,
  classifyRunFile,
  listRunFiles,
  referencedInputs,
  type ArtifactManifest,
} from "../src/artifact-manifest.ts";
import { bytesCid, digestFile, sha256Hex } from "../src/ipfs-unixfs.ts";
import { buildCoverage, buildSchema } from "../src/publishable-docs.ts";

const RUN = "2026-01-02T03-04-05-678Z";
const OTHER = "2026-01-01T00-00-00-000Z";

/** A synthetic run in the repository layout, written at setup (no binary file is tracked). */
const runManifest = {
  run_id: RUN,
  run_name: "synthetic",
  county: "Los Angeles",
  state: "CA",
  fips: "06037",
  roll_year: "2026",
  scope: { increment: 0, permits_harvested: true },
  sources: [
    {
      name: "LA County Assessor - Assessor Parcel Data Roll 2026",
      hub_page: "https://data.lacounty.gov/datasets/x",
      terms_of_use: "https://egis-lacounty.hub.arcgis.com/pages/terms-of-use",
      request_urls: "one per page in cache.pages",
    },
    {
      name: "LADBS building permits",
      datasets: ["pi9x-tg5x"],
      terms_of_use: "https://data.lacity.org/terms-of-use",
      license:
        "none stated in the dataset metadata; the portal's terms of use (May 2014) apply",
      attribution: "LADBS",
      request_urls: [
        "https://data.lacity.org/resource/pi9x-tg5x.json?$offset=0",
      ],
    },
    {
      name: "LADBS roofing permits, contractor view",
      datasets: ["8guu-8f5m"],
      license: "CC BY 4.0",
      attribution: "LADBS",
    },
  ],
  permit_caches: { contractors: { exact_duplicate_rows: 3 } },
  cache: {
    pages: [
      {
        path: "pages/p-0.json.gz",
        request_url: "https://x/query?resultOffset=0",
        sha256: "ab",
      },
    ],
  },
  row_counts: { parquet: 3 },
  coverage: { with_coordinates: 2 },
  permits: { status_classes: { closed: 1 } },
  delta: { previous_run_id: OTHER, added: 1, removed: 0 },
  limitations: ["Synthetic limitation."],
  files: [
    {
      name: "p.parquet",
      path: `data/out/${RUN}/los-angeles_property_roll2026.parquet`,
      size_bytes: 1,
      sha256: "x",
    },
    {
      name: "los-angeles.csv",
      path: "data/seeds/los-angeles.csv",
      role: "shared seed",
      size_bytes: 9,
      sha256: "s",
    },
    {
      name: "summary.json",
      path: "summary.json",
      role: "roll cache summary",
      size_bytes: 5,
      sha256: "c",
    },
  ],
};

let root = "";
let outDir = "";
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "artifact-manifest-"));
  outDir = mkdtempSync(join(tmpdir(), "artifact-out-"));
  const w = (p: string, s: string | Uint8Array) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), s);
  };
  w(
    `runs/${RUN}/run_manifest.json`,
    JSON.stringify(runManifest, null, 2) + "\n",
  );
  w(
    `runs/${OTHER}/run_manifest.json`,
    JSON.stringify({ run_id: OTHER }) + "\n",
  );
  w("runs/run_history.jsonl", "{}\n");
  w(`data/out/${RUN}/los-angeles-seed.csv`, "parcel_id\n1\n");
  w(`data/out/${OTHER}/los-angeles-seed.csv`, "parcel_id\n2\n");
  w(`data/raw/los-angeles/roll-2026/${RUN}/page-0000.json`, '{"features":[]}');
  w(`data/raw/los-angeles/roll-2026/${RUN}/receipts.jsonl`, "{}\n");
  w(`data/work/${RUN}/rows.ndjson`, "{}\n");
  mkdirSync(join(root, `data/out/${RUN}`), { recursive: true });
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  const out = (f: string) =>
    join(root, `data/out/${RUN}/${f}`).replaceAll("'", "''");
  await c.run(
    `COPY (SELECT '2001001001' AS parcel_identifier, 1950::INTEGER AS property_structure_built_year, 'PROXY' AS roof_age_basis, 'u' AS source_http_request) TO '${out("los-angeles_property_roll2026.parquet")}' (FORMAT parquet)`,
  );
  await c.run(
    `COPY (SELECT 'X100' AS permit_number, 'B1' AS license_identifier, 'ACME ROOFING' AS contractors_business_name) TO '${out("los-angeles_ladbs_permit_contractors.parquet")}' (FORMAT parquet)`,
  );
  c.closeSync();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

const expectedRunFiles = () => [
  `data/out/${RUN}/los-angeles-seed.csv`,
  `data/out/${RUN}/los-angeles_ladbs_permit_contractors.parquet`,
  `data/out/${RUN}/los-angeles_property_roll2026.parquet`,
  `data/raw/los-angeles/roll-2026/${RUN}/page-0000.json`,
  `data/raw/los-angeles/roll-2026/${RUN}/receipts.jsonl`,
  `runs/${RUN}/run_manifest.json`,
];

describe("run files and classification", () => {
  test("listRunFiles finds every file of the run's folders and nothing of other runs, data/work or run history", () => {
    expect(listRunFiles(root, RUN)).toEqual(expectedRunFiles());
  });

  test("only the recorded run manifest is publishable; data files carry their reasons", () => {
    expect(
      classifyRunFile(`runs/${RUN}/run_manifest.json`, RUN).published,
    ).toBe(true);
    const parquet = classifyRunFile(
      `data/out/${RUN}/los-angeles_property_roll2026.parquet`,
      RUN,
    );
    expect(parquet.published).toBe(false);
    expect(parquet.reason).toMatch(/holds records/);
    expect(parquet.reason).toMatch(
      /republication rights unverified \(docs\/los-angeles-county-findings\.md, section 7\)/,
    );
    expect(parquet.reason).not.toMatch(/personal-data/);
    const contractors = classifyRunFile(
      `data/out/${RUN}/los-angeles_ladbs_permit_contractors.parquet`,
      RUN,
    );
    expect(contractors.reason).toMatch(
      /personal-data adjacency \(sole-proprietor business names\)/,
    );
    for (const p of expectedRunFiles().filter((p) => !p.startsWith("runs/"))) {
      const c = classifyRunFile(p, RUN);
      expect(c.published).toBe(false);
      expect(c.reason).toBeTruthy();
    }
  });

  test("files the run manifest lists outside the run folders are referenced inputs, not hashed", () => {
    const refs = referencedInputs(runManifest, expectedRunFiles());
    expect(refs.map((r) => r.name)).toEqual([
      "data/seeds/los-angeles.csv",
      "summary.json",
    ]);
    expect(refs[0]).toMatchObject({ recorded_size: 9, recorded_sha256: "s" });
    expect(refs[0].note).toMatch(/shared runtime path/);
  });
});

describe("manifest, coverage and schema", () => {
  test("the artifact manifest lists every file of the run once, with size, sha256 and CID", async () => {
    const files = listRunFiles(root, RUN);
    const runFiles = await Promise.all(
      files.map(async (p) => ({
        path: p,
        digest: await digestFile(join(root, p)),
      })),
    );
    const mb = new Uint8Array(
      readFileSync(join(root, `runs/${RUN}/run_manifest.json`)),
    );
    const d = async (b: Uint8Array) => ({
      size: b.length,
      sha256: sha256Hex(b),
      cid: await bytesCid(b),
    });
    const m = buildArtifactManifest({
      runId: RUN,
      runFiles,
      publishable: [
        { name: "run_manifest.json", digest: await d(mb) },
        {
          name: "coverage.json",
          digest: await d(new TextEncoder().encode("{}")),
        },
        {
          name: "schema.json",
          digest: await d(new TextEncoder().encode("[]")),
        },
      ],
      referenced: referencedInputs(runManifest, files),
    });
    const names = m.files.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        "coverage.json",
        "run_manifest.json",
        "schema.json",
        ...files.filter((p) => !p.startsWith("runs/")),
      ].sort(),
    );
    for (const f of runFiles.filter((r) => !r.path.startsWith("runs/"))) {
      const e = m.files.find((x) => x.name === f.path);
      expect(e).toMatchObject({ ...f.digest, codec: "file", published: false });
    }
    expect(m.files.find((f) => f.name === "run_manifest.json")).toMatchObject({
      published: true,
      same_bytes_as: `runs/${RUN}/run_manifest.json`,
      sha256: sha256Hex(mb),
    });
    expect(
      m.files
        .filter((f) => f.published)
        .map((f) => f.name)
        .sort(),
    ).toEqual(["coverage.json", "run_manifest.json", "schema.json"]);
    expect(m.unixfs.chunker).toMatch(/1048576/);
    expect(m.excluded[0]).toMatch(`data/work/${RUN}/`);
    expect(() =>
      buildArtifactManifest({
        runId: RUN,
        runFiles,
        publishable: [
          {
            name: "run_manifest.json",
            digest: { size: 1, sha256: "0", cid: "x" },
          },
        ],
        referenced: [],
      }),
    ).toThrow(/byte for byte/);
  });

  test("coverage holds counts, attribution and limitations, and no request URLs, pages or paths", () => {
    const cov = buildCoverage(runManifest, "f".repeat(64));
    const text = JSON.stringify(cov);
    expect(cov).toMatchObject({
      row_counts: { parquet: 3 },
      permits: { status_classes: { closed: 1 } },
    });
    expect(cov.limitations).toEqual(["Synthetic limitation."]);
    expect(text).not.toMatch(
      /"(request_urls?|cache|pages|files|permit_caches)":|data\/out|data\/seeds|resultOffset|\$offset/,
    );
    const attribution = cov.attribution as Record<string, unknown>[];
    expect(attribution[0]).toMatchObject({
      attribution: expect.stringMatching(/Assessor/),
      license: expect.stringMatching(/republication rights are unverified/),
    });
    expect(attribution[1]).toMatchObject({
      attribution: "LADBS",
      datasets: ["pi9x-tg5x"],
    });
    expect(attribution[2]).toMatchObject({
      license: "CC BY 4.0",
      attribution: "LADBS",
    });
    expect(attribution[2].changes_made).toMatch(
      /3 exact duplicate rows dropped/,
    );
  });

  test("schema labels lexicon, not-verified and other columns per the findings doc, section 12", () => {
    const s = buildSchema(RUN, [
      {
        file: "los-angeles_property_roll2026.parquet",
        columns: [
          { name: "parcel_identifier", type: "VARCHAR" },
          { name: "source_http_request", type: "VARCHAR" },
          { name: "roof_age_basis", type: "VARCHAR" },
        ],
      },
      {
        file: "los-angeles_ladbs_permit_contractors.parquet",
        columns: [{ name: "license_identifier", type: "VARCHAR" }],
      },
    ]);
    expect(
      s.tables.map((t) => [t.table, t.columns.map((c) => c.label)]),
    ).toEqual([
      ["permit_contractor", ["lexicon"]],
      ["property", ["lexicon", "not verified", "not lexicon"]],
    ]);
    expect(() =>
      buildSchema(RUN, [{ file: "other.parquet", columns: [] }]),
    ).toThrow(/unknown table/);
  });
});

describe("build-ipfs-artifacts CLI", () => {
  const cli = () =>
    execFileSync(
      process.execPath,
      ["src/build-ipfs-artifacts.ts", "--source", root, "--out", outDir, RUN],
      {
        encoding: "utf8",
      },
    );
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

  test("writes the four publishable files, the CAR and directory.json; leaves the source untouched; is deterministic", () => {
    const before = tree(root);
    // The publish guard now takes only coverage.json and the artifact manifest, never a run manifest.
    expect(cli()).toMatch(
      /guard REFUSES \(\(directory\): files must be exactly artifact-manifest\.json, coverage\.json; .*run_manifest\.json: a run manifest is never published.*\); scan hits 0/,
    );
    const first = tree(outDir);
    expect(tree(root)).toEqual(before);
    expect(readdirSync(join(outDir, RUN, "publish")).sort()).toEqual(
      [...PUBLISHABLE_FILES].sort(),
    );
    expect(
      readFileSync(join(outDir, RUN, "publish/run_manifest.json")),
    ).toEqual(readFileSync(join(root, `runs/${RUN}/run_manifest.json`)));
    const dirJson = JSON.parse(
      readFileSync(join(outDir, RUN, "directory.json"), "utf8"),
    );
    expect(dirJson.publish_guard.passes).toBe(false);
    expect(dirJson.car.sha256).toBe(
      sha256Hex(
        new Uint8Array(readFileSync(join(outDir, RUN, "directory.car"))),
      ),
    );
    const am = JSON.parse(
      readFileSync(join(outDir, RUN, "publish/artifact-manifest.json"), "utf8"),
    ) as ArtifactManifest;
    expect(am.files.filter((f) => !f.published)).toHaveLength(5);
    const schema = JSON.parse(
      readFileSync(join(outDir, RUN, "publish/schema.json"), "utf8"),
    );
    expect(schema.tables.map((t: { file: string }) => t.file)).toEqual([
      "los-angeles_ladbs_permit_contractors.parquet",
      "los-angeles_property_roll2026.parquet",
    ]);
    cli();
    expect(tree(outDir)).toEqual(first);
  });

  test("refuses an output folder inside the run folders", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "src/build-ipfs-artifacts.ts",
          "--source",
          root,
          "--out",
          join(root, "runs/x"),
          RUN,
        ],
        {
          stdio: "pipe",
        },
      ),
    ).toThrow(/must not be inside the run folders/);
  });
});
