/**
 * Builds the publication of recorded runs. Local only: no IPFS node, no network, no upload.
 *
 * Per run, from runs/<run_id>/run_manifest.json, data/out/<run_id>/ and the run config:
 *   runs/<run_id>/publish/coverage.json           counts and sources only (publishable-docs.ts)
 *   runs/<run_id>/publish/artifact-manifest.json  every published object: coverage.json and the named
 *                                                 Parquet objects (artifact-manifest.ts)
 *   runs/<run_id>/directory.car                   the CAR of publish/, rooted at the folder's CID
 *   runs/<run_id>/directory.json                  the folder's CID, its files, the CAR's size and
 *                                                 sha256, the publish-guard result and the scan hits
 * Once, from the given Parquet files (the named objects of publish-named-objects.ts, never rebuilt):
 *   objects/<name>, objects/<name>.car            each file's bytes and its CAR, rooted at its CID
 *   objects.json                                  each object's CID, size, sha256, its CAR's size and
 *                                                 sha256, and the publish-guard result
 *
 * Before coverage.json is built, the run's property and permits Parquet files in data/out/<run_id>/
 * must have the size and sha256 the run manifest records, and their Parquet row counts must equal the
 * recorded ones; the permit count is that row count. Any value not in the recorded files stops the
 * build (publishable-docs.ts). No build time is written anywhere: a rebuild gives identical bytes.
 * The run folders are only read. The exit code is 1 when the guard refuses anything or a scan hits.
 *
 * Usage: node src/build-ipfs-artifacts.ts --config <run config> --object <file> --object <file>
 *        [--source <dir with runs/ and data/out/>] [--out data/ipfs] <run_id> ...
 * DuckDB reads only the Parquet footers (memory limit 1 GB, one thread).
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  buildArtifactManifest,
  jsonBytes,
  namedObjectEntry,
  objectOf,
} from "./artifact-manifest.ts";
import { directoryCar, fileCar, sha256Hex } from "./ipfs-unixfs.ts";
import { buildCoverage, type RunManifestLike } from "./publishable-docs.ts";
import { NAMED_OBJECTS, type NamedObject } from "./publish-named-objects.ts";
import { guardDirectory, guardObject } from "./publish-guard.ts";
import { scanJson } from "./publish-scans.ts";
import { RUN_ID_PATTERN, loadRunConfig, type RunConfig } from "./run-config.ts";

async function sha256File(
  path: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function parquetRows(c: DuckDBConnection, path: string): Promise<number> {
  const r = await c.runAndReadAll(
    `SELECT num_rows FROM parquet_file_metadata('${path.replaceAll("'", "''")}')`,
  );
  const rows = r.getRowObjectsJS();
  if (rows.length !== 1) throw new Error(`${path}: not one Parquet file`);
  return Number(rows[0].num_rows);
}

type RecordedFile = {
  name?: string;
  path?: string;
  size_bytes?: number;
  sha256?: string;
  row_count?: number;
};

/** A recorded Parquet output of the run, checked against its bytes and its footer row count. */
async function checkedParquet(
  c: DuckDBConnection,
  source: string,
  runId: string,
  files: RecordedFile[],
  name: string,
): Promise<number> {
  const hits = files.filter((f) => f.name === name);
  if (hits.length !== 1)
    throw new Error(
      `${runId}: the run manifest records ${hits.length} files named ${name}`,
    );
  const f = hits[0];
  if (f.path !== `data/out/${runId}/${name}`)
    throw new Error(`${runId}: ${name} is recorded at ${f.path}`);
  const d = await sha256File(join(source, f.path));
  if (d.size !== f.size_bytes || d.sha256 !== f.sha256)
    throw new Error(
      `${runId}: ${f.path} is not the recorded file (size or sha256)`,
    );
  const rows = await parquetRows(c, join(source, f.path));
  if (rows !== f.row_count)
    throw new Error(
      `${runId}: ${name} holds ${rows} rows; the run manifest records ${f.row_count}`,
    );
  return rows;
}

export type BuildArgs = {
  /** The folder holding runs/ and data/out/ (only read). */
  source: string;
  out: string;
  config: RunConfig;
  /** Paths of the given Parquet files, one per named object, found by file name. */
  objects: string[];
  runIds: string[];
  /** The named objects; tests pass small ones. */
  named?: readonly NamedObject[];
  log?: (line: string) => void;
};

/** Builds the objects once and each run's folder; returns false when the guard refused anything or a scan hit. */
export async function buildPublication(a: BuildArgs): Promise<boolean> {
  const source = resolve(a.source);
  const out = resolve(a.out);
  const named = a.named ?? NAMED_OBJECTS;
  const log = a.log ?? (() => {});
  for (const ro of ["runs", "data/out", "data/raw"]) {
    const r = relative(join(source, ro), out);
    if (r === "" || !(r.startsWith("..") || r.startsWith(sep)))
      throw new Error(`--out must not be inside the run folders (${ro})`);
  }
  if (!a.runIds.length) throw new Error("give run IDs");
  for (const id of a.runIds)
    if (!RUN_ID_PATTERN.test(id)) throw new Error(`not a run ID: ${id}`);
  const given = new Map(a.objects.map((p) => [basename(p), p]));
  for (const n of named)
    if (!given.has(n.name))
      throw new Error(`give --object <path to ${n.name}>`);
  let ok = true;

  // The named objects, once: the given bytes, checked by the guard, never rebuilt.
  const objectsOut = join(out, "objects");
  rmSync(objectsOut, { recursive: true, force: true });
  mkdirSync(objectsOut, { recursive: true });
  const objectRecords: unknown[] = [];
  for (const n of named) {
    const bytes = new Uint8Array(readFileSync(given.get(n.name) as string));
    const car = await fileCar(new Blob([bytes]));
    const refusals = await guardObject(
      { name: n.name, bytes, root: car.root, car: car.car },
      named,
    );
    if (refusals.length) ok = false;
    writeFileSync(join(objectsOut, n.name), bytes);
    writeFileSync(join(objectsOut, `${n.name}.car`), car.car);
    objectRecords.push({
      ...namedObjectEntry(n),
      car: {
        file: `objects/${n.name}.car`,
        root: car.root,
        size: car.car.length,
        sha256: car.car_sha256,
      },
      publish_guard: { passes: refusals.length === 0, refusals },
    });
    log(
      `${n.name}: ${car.root}; CAR ${car.car.length} bytes; guard ${refusals.length ? "REFUSES" : "passes"}`,
    );
  }
  writeFileSync(
    join(out, "objects.json"),
    jsonBytes({ objects: objectRecords }),
  );

  const db = await DuckDBInstance.create(":memory:", {
    memory_limit: "1GB",
    threads: "1",
  });
  const conn = await db.connect();
  try {
    for (const runId of a.runIds) {
      const manifestPath = join(source, "runs", runId, "run_manifest.json");
      const m = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as RunManifestLike & { files?: RecordedFile[] };
      if (m.run_id !== runId)
        throw new Error(`${manifestPath}: run_id is ${m.run_id}`);
      const files = m.files ?? [];
      const parcels = await checkedParquet(
        conn,
        source,
        runId,
        files,
        `los-angeles_property_roll${a.config.roll_year}.parquet`,
      );
      if (parcels !== m.row_counts?.parquet)
        throw new Error(
          `${runId}: the property Parquet rows differ from row_counts.parquet`,
        );
      const permits = await checkedParquet(
        conn,
        source,
        runId,
        files,
        "los-angeles_ladbs_permits.parquet",
      );

      const coverage = jsonBytes(buildCoverage(m, a.config, permits));
      const manifest = jsonBytes(
        buildArtifactManifest([
          await objectOf("coverage.json", coverage),
          ...named.map(namedObjectEntry),
        ]),
      );
      const folder = [
        { name: "artifact-manifest.json", bytes: manifest },
        { name: "coverage.json", bytes: coverage },
      ];
      const car = await directoryCar(folder);
      const refusals = await guardDirectory(
        { files: folder, root: car.root, car: car.car },
        named,
      );
      const scanHits = folder.flatMap((f) =>
        scanJson(f.name, new TextDecoder().decode(f.bytes)),
      );
      if (refusals.length || scanHits.length) ok = false;

      const runOut = join(out, "runs", runId);
      rmSync(runOut, { recursive: true, force: true });
      mkdirSync(join(runOut, "publish"), { recursive: true });
      for (const f of folder)
        writeFileSync(join(runOut, "publish", f.name), f.bytes);
      writeFileSync(join(runOut, "directory.car"), car.car);
      writeFileSync(
        join(runOut, "directory.json"),
        jsonBytes({
          run_id: runId,
          directory_cid: car.root,
          files: await Promise.all(
            folder.map((f) => objectOf(f.name, f.bytes)),
          ),
          car: {
            file: "directory.car",
            size: car.car.length,
            sha256: car.car_sha256,
          },
          publish_guard: { passes: refusals.length === 0, refusals },
          scans: { hits: scanHits },
        }),
      );
      log(
        `${runId}: folder ${car.root}; coverage ${sha256Hex(coverage)}; guard ${
          refusals.length
            ? `REFUSES (${refusals.map((r) => `${r.name}: ${r.reason}`).join("; ")})`
            : "passes"
        }; scan hits ${scanHits.length}`,
      );
    }
  } finally {
    conn.closeSync();
  }
  return ok;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: "string", default: "." },
      out: { type: "string", default: "data/ipfs" },
      config: { type: "string" },
      object: { type: "string", multiple: true },
    },
  });
  if (!values.config) throw new Error("give --config <run config>");
  const ok = await buildPublication({
    source: values.source,
    out: values.out,
    config: loadRunConfig(values.config),
    objects: values.object ?? [],
    runIds: positionals,
    log: (line) => console.log(line),
  });
  process.exitCode = ok ? 0 : 1;
}
