/**
 * Builds, for each recorded run, the artifact manifest, the publishable directory, its CID and its
 * CAR. Local only: no IPFS node, no network, no upload.
 *
 * Reads the run folders of <source> (runs/<run_id>/, data/out/<run_id>/, data/raw/.../<run_id>/) and
 * never writes there. Writes only under <out>/<run_id>/:
 *   publish/                the four publishable files
 *   directory.car           the CAR of publish/, rooted at the directory CID
 *   directory.json          the directory CID, the CAR's size and sha256, the publish-guard result and
 *                           the scan hits (the directory CID cannot be inside its own manifest)
 * and <out>/index.json for the runs built in this call. No build time is written anywhere, so a rebuild
 * of the same run gives identical bytes.
 *
 * Usage: node src/build-ipfs-artifacts.ts [--source <dir with runs/ and data/>] [--out data/ipfs]
 *        (--all | <run_id> ...)
 * DuckDB reads only the Parquet schemas (memory limit 1 GB, one thread).
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  buildArtifactManifest,
  jsonBytes,
  listRunFiles,
  referencedInputs,
} from "./artifact-manifest.ts";
import {
  bytesCid,
  digestFile,
  directoryCar,
  sha256Hex,
  type FileDigest,
} from "./ipfs-unixfs.ts";
import {
  buildCoverage,
  buildSchema,
  type ParquetTable,
  type RunManifestLike,
} from "./publishable-docs.ts";
import { RUN_ID_PATTERN } from "./run-config.ts";
import { guardDirectory } from "./publish-guard.ts";
import { scanJson } from "./publish-scans.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string", default: "." },
    out: { type: "string", default: "data/ipfs" },
    all: { type: "boolean", default: false },
  },
});
const source = resolve(values.source);
const out = resolve(values.out);
for (const ro of ["runs", "data/out", "data/raw"]) {
  const r = relative(join(source, ro), out);
  if (r === "" || !(r.startsWith("..") || r.startsWith(sep)))
    throw new Error(`--out must not be inside the run folders (${ro})`);
}
const runIds = values.all
  ? readdirSync(join(source, "runs"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : positionals;
if (!runIds.length) throw new Error("give run IDs or --all");

async function parquetColumns(c: DuckDBConnection, path: string) {
  const r = await c.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet('${path.replaceAll("'", "''")}')`,
  );
  return r.getRowObjectsJS().map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));
}

async function digestBytes(bytes: Uint8Array): Promise<FileDigest> {
  return {
    size: bytes.length,
    sha256: sha256Hex(bytes),
    cid: await bytesCid(bytes),
  };
}

const db = await DuckDBInstance.create(":memory:", {
  memory_limit: "1GB",
  threads: "1",
});
const conn = await db.connect();
const index: unknown[] = [];

for (const runId of runIds) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`not a run ID: ${runId}`);
  const t0 = Date.now();
  const manifestPath = join(source, "runs", runId, "run_manifest.json");
  const runManifestBytes = new Uint8Array(readFileSync(manifestPath));
  const m = JSON.parse(
    new TextDecoder().decode(runManifestBytes),
  ) as RunManifestLike & { files?: never[] };
  if (m.run_id !== runId)
    throw new Error(`${manifestPath}: run_id is ${m.run_id}`);

  const paths = listRunFiles(source, runId);
  const runFiles: { path: string; digest: FileDigest }[] = [];
  for (const p of paths)
    runFiles.push({ path: p, digest: await digestFile(join(source, p)) });

  const tables: ParquetTable[] = [];
  for (const p of paths.filter(
    (x) => x.startsWith(`data/out/${runId}/`) && x.endsWith(".parquet"),
  ))
    tables.push({
      file: posix.basename(p),
      columns: await parquetColumns(conn, join(source, p)),
    });

  const coverage = jsonBytes(buildCoverage(m, sha256Hex(runManifestBytes)));
  const schema = jsonBytes(buildSchema(runId, tables));
  const artifactManifest = buildArtifactManifest({
    runId,
    runFiles,
    publishable: [
      {
        name: "run_manifest.json",
        digest: await digestBytes(runManifestBytes),
      },
      { name: "coverage.json", digest: await digestBytes(coverage) },
      { name: "schema.json", digest: await digestBytes(schema) },
    ],
    referenced: referencedInputs(m as { files?: [] }, paths),
  });
  const files = [
    { name: "artifact-manifest.json", bytes: jsonBytes(artifactManifest) },
    { name: "coverage.json", bytes: coverage },
    { name: "run_manifest.json", bytes: runManifestBytes },
    { name: "schema.json", bytes: schema },
  ];
  const car = await directoryCar(files);
  const refusals = await guardDirectory({
    files,
    root: car.root,
    car: car.car,
  });
  const scanHits = files
    .filter((f) => f.name.endsWith(".json"))
    .flatMap((f) => scanJson(f.name, new TextDecoder().decode(f.bytes)));

  const runOut = join(out, runId);
  rmSync(runOut, { recursive: true, force: true });
  mkdirSync(join(runOut, "publish"), { recursive: true });
  for (const f of files)
    writeFileSync(join(runOut, "publish", f.name), f.bytes);
  writeFileSync(join(runOut, "directory.car"), car.car);
  const directory = {
    run_id: runId,
    directory_cid: car.root,
    codec: "directory",
    car: {
      file: "directory.car",
      size: car.car.length,
      sha256: car.car_sha256,
    },
    files: await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        ...(await digestBytes(f.bytes)),
      })),
    ),
    data_files_listed: artifactManifest.files.filter((f) => !f.published)
      .length,
    publish_guard: { passes: refusals.length === 0, refusals },
    scans: { hits: scanHits },
  };
  writeFileSync(join(runOut, "directory.json"), jsonBytes(directory));
  index.push({
    run_id: runId,
    directory_cid: car.root,
    car_sha256: car.car_sha256,
    publish_guard_passes: refusals.length === 0,
    scan_hits: scanHits.length,
  });
  console.log(
    `${runId}: directory ${car.root}; ${artifactManifest.files.length} files listed; guard ${
      refusals.length
        ? `REFUSES (${refusals.map((r) => `${r.name}: ${r.reason}`).join("; ")})`
        : "passes"
    }; scan hits ${scanHits.length}; ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}
conn.closeSync();
writeFileSync(join(out, "index.json"), jsonBytes({ runs: index }));
