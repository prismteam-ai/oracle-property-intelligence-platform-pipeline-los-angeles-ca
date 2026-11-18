/**
 * Gateway check after an approved publication (run by the operator, never by a build or a test against the network):
 * fetch every published object of a run by GET from public gateways this environment does not operate, and compare
 * the bytes by size and SHA-256.
 *
 * Input: a run's publication folder, runs/<run_id>/publication/ (or the packet's runs/<run_id>/), holding
 * artifact-manifest.json, directory.json (its build record) and publish/ (the folder's files).
 *
 * Fetched from every gateway of the list (src/gateways.ts; path form https://<host>/ipfs/<cid>):
 * - the artifact manifest itself, by its CID, against the local file (unless --skip-manifest-fetch: then it is
 *   read locally only, for a rehearsal whose manifest was never uploaded; the proof says manifest_fetched false);
 * - every file the manifest lists, by its CID, against its entry;
 * - the folder (the manifest's one directory entry), proven twice per gateway:
 *   (a) the gateway's own CAR of the folder (?format=car, Accept: application/vnd.ipld.car), its size and SHA-256
 *       compared with the entry's. A mismatch is reported, not fatal: a gateway may write blocks in another order
 *       or framing.
 *   (b) each of the folder's files fetched by path (/ipfs/<folder CID>/<name>, names from directory.json), the CAR
 *       rebuilt from those bytes with the pipeline's own directoryCar (root block first), and its root CID, length
 *       and SHA-256 compared with the entry's. When a gateway answers every file and the rebuilt CAR differs, that
 *       is fatal for the run.
 *
 * A run passes when every listed object (the manifest, unless skipped, and every file) matches on at least two
 * gateways of different operators, the folder's (b) passes on at least two gateways of different operators, and no
 * (b) is fatal. The proof (gateway-check-<run_id>.json and .txt) records every gateway's result for every object,
 * failures included: status, bytes, SHA-256, every attempt and its time.
 *
 * Time limits and retries (all configurable): each answer may take timeoutMs (default 60 s) plus one second per
 * timeoutBytesPerS (default 131,072 B, 128 KiB) of the expected size: about 60 s for the small files, 310 s for the
 * 32,775,616-byte county Parquet. A failed or mismatching answer is fetched again, up to `attempts` in all (default
 * 5), waiting retryWaitMs (default 15 s) doubled after each attempt up to retryWaitMaxMs (default 120 s): 15, 30, 60
 * and 120 s, because a gateway can take minutes to find newly uploaded content. The folder CAR (a) is fetched again
 * only when the request fails, not when its bytes differ.
 *
 * Boundary (kit rules/external-dependency-boundaries.md; assessment in the night-18nov notes, p2/boundary.md): an
 * operator-run, synchronous check of a handful of read-only GETs, one at a time, with bounded time and attempts;
 * the gateways are an injectable list and the HTTP client an injectable Fetch.
 *
 * Usage: node src/gateway-verify.ts <publication dir> <proof dir> [--gateway host=Operator ...]
 *        [--attempts 5] [--retry-wait-ms 15000] [--retry-wait-max-ms 120000] [--timeout-ms 60000]
 *        [--timeout-bytes-per-s 131072] [--skip-manifest-fetch]
 *        The list can also come from IPFS_GATEWAYS ("host=Operator,host=Operator"); --gateway wins.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ArtifactManifest } from "./artifact-manifest.ts";
import {
  GATEWAYS,
  gatewayPathUrl,
  parseGatewayList,
  type Gateway,
} from "./gateways.ts";
import { bytesCid, directoryCar, sha256Hex } from "./ipfs-unixfs.ts";
import { ARTIFACT_MANIFEST_NAME } from "./publish-guard.ts";

export type Fetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface Settings {
  attempts: number;
  retryWaitMs: number;
  retryWaitMaxMs: number;
  timeoutMs: number;
  timeoutBytesPerS: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  attempts: 5,
  retryWaitMs: 15_000,
  retryWaitMaxMs: 120_000,
  timeoutMs: 60_000,
  timeoutBytesPerS: 131_072,
});

/** The time one answer may take: timeoutMs plus one second per timeoutBytesPerS of the expected size. */
export function timeoutFor(size: number, s: Settings): number {
  return s.timeoutMs + Math.ceil((size / s.timeoutBytesPerS) * 1000);
}

/** The wait before attempt n + 1 (n >= 1): retryWaitMs doubled per attempt, at most retryWaitMaxMs. */
export function waitBefore(n: number, s: Settings): number {
  return Math.min(s.retryWaitMs * 2 ** (n - 1), s.retryWaitMaxMs);
}

export interface Attempt {
  status: number | null;
  size: number | null;
  sha256: string | null;
  ms: number;
  error?: string;
}

export interface GatewayResult {
  host: string;
  operator: string;
  url: string;
  timeout_ms: number;
  /** The last attempt's answer. */
  status: number | null;
  size: number | null;
  sha256: string | null;
  /** Size and SHA-256 equal the expected ones (on a 2xx answer). */
  ok: boolean;
  attempts: Attempt[];
}

export interface Expected {
  size: number;
  sha256: string;
}

export interface ObjectProof {
  kind: "manifest" | "file";
  name: string;
  cid: string;
  expected: Expected;
  gateways: GatewayResult[];
  /** The operators of the gateways it matched on. */
  operators_matched: string[];
  passes: boolean;
}

export interface FolderGatewayProof {
  host: string;
  operator: string;
  /** (a) The gateway's own CAR of the folder; a mismatch is not fatal. */
  car: GatewayResult;
  /** (b) The folder's files by path, and the CAR rebuilt from them with directoryCar. */
  by_path: {
    files: (GatewayResult & { name: string })[];
    rebuilt: { root: string; size: number; sha256: string } | null;
    ok: boolean;
    fatal: boolean;
  };
}

export interface FolderProof {
  name: string;
  cid: string;
  expected: Expected;
  gateways: FolderGatewayProof[];
  /** The operators of the gateways where (a) matched (reported only). */
  car_operators_matched: string[];
  /** The operators of the gateways where (b) passed. */
  operators_matched: string[];
  passes: boolean;
}

export interface Proof {
  run_id: string;
  manifest_cid: string;
  directory_cid: string;
  manifest_fetched: boolean;
  gateways: Gateway[];
  settings: Settings;
  objects: ObjectProof[];
  folder: FolderProof;
  fatal: string[];
  passes: boolean;
}

/** A run's publication folder, read and checked locally before anything is fetched. */
export interface Publication {
  run_id: string;
  manifest: ArtifactManifest;
  manifestFile: { cid: string; size: number; sha256: string };
  folder: { name: string; cid: string; expected: Expected };
  folderFiles: { name: string; size: number; sha256: string }[];
}

interface DirectoryRecord {
  run_id: string;
  directory_cid: string;
  files: { name: string; size: number; sha256: string }[];
  artifact_manifest: { cid: string; size: number; sha256: string };
}

/**
 * Reads artifact-manifest.json, directory.json and publish/ of a publication folder and checks them against each
 * other: the record's manifest CID, size and SHA-256 are the local manifest's, the manifest lists exactly one
 * directory and it is the record's folder, publish/ holds exactly the record's files with their bytes, and the CAR
 * directoryCar builds from them is the manifest's folder entry. Throws on any difference.
 */
export async function loadPublication(dir: string): Promise<Publication> {
  const manifestBytes = new Uint8Array(
    readFileSync(join(dir, ARTIFACT_MANIFEST_NAME)),
  );
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestBytes),
  ) as ArtifactManifest;
  const record = JSON.parse(
    readFileSync(join(dir, "directory.json"), "utf8"),
  ) as DirectoryRecord;
  const manifestFile = {
    cid: await bytesCid(manifestBytes),
    size: manifestBytes.length,
    sha256: sha256Hex(manifestBytes),
  };
  const r = record.artifact_manifest;
  if (
    r?.cid !== manifestFile.cid ||
    r.size !== manifestFile.size ||
    r.sha256 !== manifestFile.sha256
  )
    throw new Error(
      `${dir}: directory.json's artifact_manifest is not the local ${ARTIFACT_MANIFEST_NAME}`,
    );
  const dirs = manifest.objects.filter((o) => o.codec === "directory");
  if (dirs.length !== 1)
    throw new Error(
      `${dir}: the artifact manifest must list exactly one directory`,
    );
  const folder = dirs[0];
  if (folder.cid !== record.directory_cid)
    throw new Error(
      `${dir}: the manifest's directory is not directory.json's directory_cid`,
    );
  const names = readdirSync(join(dir, "publish")).sort();
  const recorded = record.files.map((f) => f.name).sort();
  if (names.join("\n") !== recorded.join("\n"))
    throw new Error(
      `${dir}: publish/ does not hold exactly directory.json's files`,
    );
  const files = record.files.map((f) => ({
    name: f.name,
    bytes: new Uint8Array(readFileSync(join(dir, "publish", f.name))),
  }));
  for (const [i, f] of files.entries())
    if (
      f.bytes.length !== record.files[i].size ||
      sha256Hex(f.bytes) !== record.files[i].sha256
    )
      throw new Error(`${dir}: publish/${f.name} differs from directory.json`);
  const car = await directoryCar(files);
  if (
    car.root !== folder.cid ||
    car.car.length !== folder.size ||
    car.car_sha256 !== folder.sha256
  )
    throw new Error(
      `${dir}: the CAR of publish/ is not the manifest's directory entry (CID, size and SHA-256)`,
    );
  return {
    run_id: record.run_id,
    manifest,
    manifestFile,
    folder: {
      name: folder.name,
      cid: folder.cid,
      expected: { size: folder.size, sha256: folder.sha256 },
    },
    folderFiles: record.files.map(({ name, size, sha256 }) => ({
      name,
      size,
      sha256,
    })),
  };
}

const operatorsOf = (rs: { ok: boolean; operator: string }[]) =>
  [...new Set(rs.filter((r) => r.ok).map((r) => r.operator))].sort();

export async function verifyOnGateways(args: {
  publication: Publication;
  gateways: readonly Gateway[];
  fetchImpl: Fetch;
  settings?: Partial<Settings>;
  /** false: the manifest is not fetched (it was never uploaded, e.g. a rehearsal). */
  fetchManifest?: boolean;
  wait?: (ms: number) => Promise<unknown>;
  clock?: () => number;
}): Promise<Proof> {
  const s: Settings = { ...DEFAULT_SETTINGS, ...args.settings };
  const { publication: p, fetchImpl } = args;
  const fetchManifest = args.fetchManifest ?? true;
  const wait = args.wait ?? ((ms: number) => sleep(ms));
  const clock = args.clock ?? (() => performance.now());
  if (!Number.isInteger(s.attempts) || s.attempts < 1)
    throw new Error("attempts must be a whole number of at least 1");
  for (const k of [
    "retryWaitMs",
    "retryWaitMaxMs",
    "timeoutMs",
    "timeoutBytesPerS",
  ] as const)
    if (!(s[k] >= 0) || (k === "timeoutBytesPerS" && s[k] === 0))
      throw new Error(`${k} must be a positive number`);
  if (new Set(args.gateways.map((g) => g.operator)).size < 2)
    throw new Error("the gateways must belong to at least two operators");

  /** One GET; the bytes are kept for the caller. */
  const get = async (url: string, timeout: number, accept?: string) => {
    const t0 = clock();
    try {
      const r = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeout),
        headers: accept ? { accept } : {},
      });
      const bytes = new Uint8Array(await r.arrayBuffer());
      return {
        okStatus: r.ok,
        bytes,
        attempt: {
          status: r.status,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ms: Math.round(clock() - t0),
        } as Attempt,
      };
    } catch (e) {
      return {
        okStatus: false,
        bytes: null,
        attempt: {
          status: null,
          size: null,
          sha256: null,
          ms: Math.round(clock() - t0),
          error: (e as Error).message,
        } as Attempt,
      };
    }
  };

  /** GETs until the answer matches or the attempts are spent (retryOnMismatch false: only on a failed request). */
  const check = async (
    g: Gateway,
    url: string,
    expected: Expected,
    opts: { accept?: string; retryOnMismatch?: boolean } = {},
  ): Promise<{
    result: GatewayResult;
    bytes: Uint8Array | null;
    answered: boolean;
  }> => {
    const timeout = timeoutFor(expected.size, s);
    const attempts: Attempt[] = [];
    const matches = (a: Attempt, okStatus: boolean) =>
      okStatus && a.size === expected.size && a.sha256 === expected.sha256;
    let last = await get(url, timeout, opts.accept);
    attempts.push(last.attempt);
    while (
      !matches(last.attempt, last.okStatus) &&
      (opts.retryOnMismatch !== false || !last.okStatus) &&
      attempts.length < s.attempts
    ) {
      await wait(waitBefore(attempts.length, s));
      last = await get(url, timeout, opts.accept);
      attempts.push(last.attempt);
    }
    const a = last.attempt;
    return {
      result: {
        host: g.host,
        operator: g.operator,
        url,
        timeout_ms: timeout,
        status: a.status,
        size: a.size,
        sha256: a.sha256,
        ok: matches(a, last.okStatus),
        attempts,
      },
      bytes: last.okStatus ? last.bytes : null,
      answered: last.okStatus,
    };
  };

  const listed: {
    kind: ObjectProof["kind"];
    name: string;
    cid: string;
    expected: Expected;
  }[] = [
    ...(fetchManifest
      ? [
          {
            kind: "manifest" as const,
            name: ARTIFACT_MANIFEST_NAME,
            cid: p.manifestFile.cid,
            expected: {
              size: p.manifestFile.size,
              sha256: p.manifestFile.sha256,
            },
          },
        ]
      : []),
    ...p.manifest.objects
      .filter((o) => o.codec === "file")
      .map((o) => ({
        kind: "file" as const,
        name: o.name,
        cid: o.cid,
        expected: { size: o.size, sha256: o.sha256 },
      })),
  ];
  const objects: ObjectProof[] = [];
  for (const o of listed) {
    const gateways: GatewayResult[] = [];
    for (const g of args.gateways)
      gateways.push(
        (await check(g, gatewayPathUrl(g, o.cid), o.expected)).result,
      );
    const operators_matched = operatorsOf(gateways);
    objects.push({
      ...o,
      gateways,
      operators_matched,
      passes: operators_matched.length >= 2,
    });
  }

  const fatal: string[] = [];
  const folderGateways: FolderGatewayProof[] = [];
  for (const g of args.gateways) {
    const car = (
      await check(
        g,
        `${gatewayPathUrl(g, p.folder.cid)}?format=car`,
        p.folder.expected,
        { accept: "application/vnd.ipld.car", retryOnMismatch: false },
      )
    ).result;
    const files: (GatewayResult & { name: string })[] = [];
    const fetched: { name: string; bytes: Uint8Array }[] = [];
    let allAnswered = true;
    for (const f of p.folderFiles) {
      const r = await check(g, gatewayPathUrl(g, p.folder.cid, f.name), f);
      files.push({ name: f.name, ...r.result });
      if (r.bytes && r.answered) fetched.push({ name: f.name, bytes: r.bytes });
      else allAnswered = false;
    }
    let rebuilt: FolderGatewayProof["by_path"]["rebuilt"] = null;
    let ok = false;
    let isFatal = false;
    if (allAnswered) {
      const c = await directoryCar(fetched);
      rebuilt = { root: c.root, size: c.car.length, sha256: c.car_sha256 };
      ok =
        c.root === p.folder.cid &&
        c.car.length === p.folder.expected.size &&
        c.car_sha256 === p.folder.expected.sha256;
      if (!ok) {
        isFatal = true;
        fatal.push(
          `${g.host}: the folder's files by path rebuild to another CAR (root ${c.root}, ${c.car.length} bytes, sha256 ${c.car_sha256})`,
        );
      }
    }
    folderGateways.push({
      host: g.host,
      operator: g.operator,
      car,
      by_path: { files, rebuilt, ok, fatal: isFatal },
    });
  }
  const operators_matched = operatorsOf(
    folderGateways.map((f) => ({ ok: f.by_path.ok, operator: f.operator })),
  );
  const folder: FolderProof = {
    name: p.folder.name,
    cid: p.folder.cid,
    expected: p.folder.expected,
    gateways: folderGateways,
    car_operators_matched: operatorsOf(folderGateways.map((f) => f.car)),
    operators_matched,
    passes: operators_matched.length >= 2 && fatal.length === 0,
  };
  return {
    run_id: p.run_id,
    manifest_cid: p.manifestFile.cid,
    directory_cid: p.folder.cid,
    manifest_fetched: fetchManifest,
    gateways: args.gateways.map((g) => ({
      host: g.host,
      operator: g.operator,
    })),
    settings: s,
    objects,
    folder,
    fatal,
    passes: objects.every((o) => o.passes) && folder.passes,
  };
}

const answer = (r: GatewayResult) =>
  `${r.ok ? "match" : "NO MATCH"}: status ${r.status ?? "none"}, ${r.size ?? "-"} bytes, sha256 ${r.sha256 ?? "-"}, ` +
  `${r.attempts.length} attempt(s), ${r.attempts.reduce((t, a) => t + a.ms, 0)} ms` +
  (r.attempts.at(-1)?.error ? ` (${r.attempts.at(-1)?.error})` : "");

/** The proof's short text: one line per object and gateway, then the verdict. */
export function proofText(p: Proof): string {
  const lines = [
    `Gateway check of run ${p.run_id}: ${p.passes ? "PASS" : "FAIL"}`,
    `manifest ${p.manifest_cid}${p.manifest_fetched ? "" : " (read locally, not fetched: --skip-manifest-fetch)"}; folder ${p.directory_cid}`,
    `gateways: ${p.gateways.map((g) => `${g.host} (${g.operator})`).join(", ")}`,
    `attempts ${p.settings.attempts}, waits ${p.settings.retryWaitMs}-${p.settings.retryWaitMaxMs} ms doubling, timeout ${p.settings.timeoutMs} ms + 1 s per ${p.settings.timeoutBytesPerS} B`,
  ];
  for (const o of p.objects) {
    lines.push(
      `${o.passes ? "PASS" : "FAIL"} ${o.kind} ${o.name} ${o.cid} (${o.expected.size} bytes, sha256 ${o.expected.sha256}): matched by ${o.operators_matched.join(", ") || "none"}`,
    );
    for (const r of o.gateways) lines.push(`  ${r.host}: ${answer(r)}`);
  }
  const f = p.folder;
  lines.push(
    `${f.passes ? "PASS" : "FAIL"} folder ${f.name} ${f.cid} (CAR ${f.expected.size} bytes, sha256 ${f.expected.sha256}): (b) passed on ${f.operators_matched.join(", ") || "none"}; (a) matched on ${f.car_operators_matched.join(", ") || "none"}`,
  );
  for (const g of f.gateways) {
    lines.push(`  ${g.host} (a) gateway CAR, not fatal: ${answer(g.car)}`);
    for (const x of g.by_path.files)
      lines.push(`  ${g.host} (b) ${x.name} by path: ${answer(x)}`);
    lines.push(
      `  ${g.host} (b) rebuilt CAR: ${
        g.by_path.rebuilt
          ? `root ${g.by_path.rebuilt.root}, ${g.by_path.rebuilt.size} bytes, sha256 ${g.by_path.rebuilt.sha256}: ${g.by_path.ok ? "match" : "MISMATCH (fatal)"}`
          : "not built (a file was not answered)"
      }`,
    );
  }
  for (const x of p.fatal) lines.push(`FATAL ${x}`);
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      gateway: { type: "string", multiple: true },
      attempts: { type: "string" },
      "retry-wait-ms": { type: "string" },
      "retry-wait-max-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      "timeout-bytes-per-s": { type: "string" },
      "skip-manifest-fetch": { type: "boolean" },
    },
  });
  const [pubDir, proofDir] = positionals;
  if (!pubDir || !proofDir || positionals.length > 2) {
    console.error(
      "usage: node src/gateway-verify.ts <publication dir> <proof dir> [--gateway host=Operator ...] [--attempts 5] [--retry-wait-ms 15000] [--retry-wait-max-ms 120000] [--timeout-ms 60000] [--timeout-bytes-per-s 131072] [--skip-manifest-fetch]",
    );
    process.exit(2);
  }
  const num = (v: string | undefined) =>
    v === undefined ? undefined : Number(v);
  const gateways = values.gateway?.length
    ? parseGatewayList(values.gateway)
    : process.env.IPFS_GATEWAYS
      ? parseGatewayList(process.env.IPFS_GATEWAYS)
      : GATEWAYS;
  const settings = Object.fromEntries(
    Object.entries({
      attempts: num(values.attempts),
      retryWaitMs: num(values["retry-wait-ms"]),
      retryWaitMaxMs: num(values["retry-wait-max-ms"]),
      timeoutMs: num(values["timeout-ms"]),
      timeoutBytesPerS: num(values["timeout-bytes-per-s"]),
    }).filter(([, v]) => v !== undefined),
  ) as Partial<Settings>;
  const publication = await loadPublication(pubDir);
  const started_at = new Date().toISOString();
  const proof = await verifyOnGateways({
    publication,
    gateways,
    fetchImpl: fetch,
    settings,
    fetchManifest: !values["skip-manifest-fetch"],
  });
  const finished_at = new Date().toISOString();
  mkdirSync(proofDir, { recursive: true });
  const base = join(proofDir, `gateway-check-${proof.run_id}`);
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ ...proof, started_at, finished_at }, null, 2) + "\n",
  );
  const text =
    proofText(proof) + `started ${started_at}, finished ${finished_at}\n`;
  writeFileSync(`${base}.txt`, text);
  process.stdout.write(text);
  process.exitCode = proof.passes ? 0 : 1;
}
