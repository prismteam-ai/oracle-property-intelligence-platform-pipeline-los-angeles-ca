/**
 * Gateway check after an approved publication (run by the operator, never by a build or a test against the network):
 * fetch every published object of a run by GET from public gateways, and compare the bytes by size and SHA-256.
 *
 * Input: a run's publication folder, runs/<run_id>/publication/ (or the packet's runs/<run_id>/), holding
 * artifact-manifest.json, directory.json (its build record) and publish/ (the folder's files).
 *
 * Who pins the content is given with --pinned-by <Operator> (required, repeatable for a second pinning service). A
 * pinning operator's gateways are fetched and reported, never counted: they read from the pinning service's own
 * storage and show only that the vendor holds the bytes. Every other gateway is counted.
 *
 * Fetched from every gateway of the list (src/gateways.ts; path form https://<host>/ipfs/<cid>):
 * - the artifact manifest itself, by its CID, against the local file (unless --skip-manifest-fetch, for a rehearsal
 *   whose manifest was never uploaded: then the verdict is never PASS; see below);
 * - every file the manifest lists, by its CID, against its entry;
 * - the folder (the manifest's one directory entry), proven twice per gateway:
 *   (a) the gateway's own CAR of the folder (?format=car, Accept: application/vnd.ipld.car), its size and SHA-256
 *       compared with the entry's;
 *   (b) each of the folder's files fetched by path (/ipfs/<folder CID>/<name>, names from directory.json), the CAR
 *       rebuilt from those bytes with the pipeline's own directoryCar (root block first), and its root CID, length
 *       and SHA-256 compared with the entry's. When a gateway answers every file and the rebuilt CAR differs, that is
 *       fatal for the run, on any gateway.
 * A match counts only when the answer came from the gateway's own host or a subdomain of it (a redirect elsewhere is
 * recorded and not counted).
 *
 * Verdict:
 * - PASS (exit 0): the manifest and every listed file match on at least two counted operators; the folder's (a) and
 *   (b) each match on at least two counted operators; nothing fatal.
 * - INCOMPLETE (exit 3): all of that holds for what was fetched, but the manifest was not fetched
 *   (--skip-manifest-fetch). Never a pass.
 * - FAIL (exit 1): anything else. Exit 2: usage or refused settings.
 * The verdict line and the proof say when the default gateway list was replaced (--gateway or IPFS_GATEWAYS).
 *
 * A real run accepts https gateways only, with no loopback, private-range or link-local address in the host
 * (localGatewayProblem); every gateway must declare its operator. Tests use local http gateways through the
 * test-only switch --test-only-allow-local-gateways, which is announced on stderr and marked in the verdict line and
 * the proof (test_only_local_gateways: true); the record tool refuses such a proof.
 *
 * Time limits and retries (all configurable): each answer may take timeoutMs (default 60 s) plus one second per
 * timeoutBytesPerS (default 131,072 B, 128 KiB) of the expected size: about 60 s for the small files, 310 s for the
 * 32,775,616-byte county Parquet. A failed or mismatching answer is fetched again, up to `attempts` in all (default
 * 5), waiting retryWaitMs (default 15 s) doubled after each attempt up to retryWaitMaxMs (default 120 s): 15, 30, 60
 * and 120 s, because a gateway can take minutes to find newly uploaded content.
 *
 * Boundary (kit rules/external-dependency-boundaries.md; assessment in the night-18nov notes, p2/boundary.md): an
 * operator-run, synchronous check of a handful of read-only GETs, one at a time, with bounded time and attempts;
 * the gateways are an injectable list and the HTTP client an injectable Fetch.
 *
 * Usage: node src/gateway-verify.ts <publication dir> <proof dir> --pinned-by <Operator> [--pinned-by <Operator>]
 *        [--gateway host=Operator ...] [--attempts 5] [--retry-wait-ms 15000] [--retry-wait-max-ms 120000]
 *        [--timeout-ms 60000] [--timeout-bytes-per-s 131072] [--skip-manifest-fetch]
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
  localGatewayProblem,
  onGatewayHost,
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
  /** The URL that answered, after redirects (fetch's Response.url); absent or empty: the URL asked. */
  url?: string;
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

/** The name of the switch that lets local http gateways in: tests only. */
export const TEST_ONLY_SWITCH = "--test-only-allow-local-gateways";

export type Verdict = "PASS" | "INCOMPLETE" | "FAIL";
export const EXIT_CODES: Readonly<Record<Verdict, number>> = Object.freeze({
  PASS: 0,
  FAIL: 1,
  INCOMPLETE: 3,
});

/** Where the gateway list came from. */
export type ListSource = "default" | "--gateway" | "IPFS_GATEWAYS";

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
  /** Present when the answer came from another URL than the one asked (a redirect). */
  final_url?: string;
  error?: string;
}

export interface GatewayResult {
  host: string;
  operator: string;
  /** false: a pinning operator's gateway, reported and never counted. */
  counted: boolean;
  url: string;
  timeout_ms: number;
  /** The last attempt's answer. */
  status: number | null;
  size: number | null;
  sha256: string | null;
  /** The last answer's URL after redirects, when it differs from url. */
  final_url?: string;
  /** Size and SHA-256 equal the expected ones, on a 2xx answer from the gateway's own host. */
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
  /** The counted operators it matched on. */
  operators_matched: string[];
  /** The pinning operators it matched on (reported only). */
  pinning_operators_matched: string[];
  passes: boolean;
}

export interface FolderGatewayProof {
  host: string;
  operator: string;
  counted: boolean;
  /** (a) The gateway's own CAR of the folder. */
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
  /** The counted operators where (a) matched. */
  car_operators_matched: string[];
  /** The counted operators where (b) passed. */
  operators_matched: string[];
  passes: boolean;
}

export interface Proof {
  verdict: Verdict;
  /** true only for PASS. */
  passes: boolean;
  run_id: string;
  manifest_cid: string;
  directory_cid: string;
  manifest_fetched: boolean;
  pinned_by: string[];
  gateway_list: ListSource;
  test_only_local_gateways: boolean;
  gateways: (Gateway & { counted: boolean })[];
  settings: Settings;
  objects: ObjectProof[];
  folder: FolderProof;
  fatal: string[];
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

/** The counted operators among results that matched. */
const countedMatches = (
  rs: { ok: boolean; operator: string; counted: boolean }[],
) =>
  [
    ...new Set(rs.filter((r) => r.ok && r.counted).map((r) => r.operator)),
  ].sort();
const pinningMatches = (
  rs: { ok: boolean; operator: string; counted: boolean }[],
) =>
  [
    ...new Set(rs.filter((r) => r.ok && !r.counted).map((r) => r.operator)),
  ].sort();

const sameOperator = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Checks the gateway list and the pinning operators before anything is fetched; throws on a refusal. Every gateway
 * declares an operator; each --pinned-by operator has a gateway in the list (so a misspelt operator cannot leave
 * its gateway counted); at least two operators remain counted; without the test-only switch, every gateway is https
 * with no local or private address in its host.
 */
export function checkGatewaySetup(
  gateways: readonly Gateway[],
  pinnedBy: readonly string[],
  allowLocal: boolean,
): (Gateway & { counted: boolean })[] {
  if (!pinnedBy.length || pinnedBy.some((p) => !p.trim()))
    throw new Error(
      "--pinned-by <Operator> is required: the operator that pins the content (its gateways are reported, not counted)",
    );
  for (const g of gateways)
    if (!g.operator?.trim())
      throw new Error(`gateway ${g.host} has no declared operator`);
  if (!allowLocal)
    for (const g of gateways) {
      const problem = localGatewayProblem(g);
      if (problem) throw new Error(`gateway refused: ${problem}`);
    }
  for (const p of pinnedBy)
    if (!gateways.some((g) => sameOperator(g.operator, p)))
      throw new Error(
        `--pinned-by ${p}: no gateway in the list has that operator (operators: ${[...new Set(gateways.map((g) => g.operator))].join(", ")})`,
      );
  const marked = gateways.map((g) => ({
    host: g.host,
    operator: g.operator,
    counted: !pinnedBy.some((p) => sameOperator(g.operator, p)),
  }));
  if (new Set(marked.filter((g) => g.counted).map((g) => g.operator)).size < 2)
    throw new Error(
      "the gateways must include at least two operators that do not pin the content",
    );
  return marked;
}

export async function verifyOnGateways(args: {
  publication: Publication;
  gateways: readonly Gateway[];
  /** The operators that pin the content: their gateways are fetched and reported, never counted. */
  pinnedBy: readonly string[];
  fetchImpl: Fetch;
  settings?: Partial<Settings>;
  /** false: the manifest is not fetched (it was never uploaded, e.g. a rehearsal); the verdict is then never PASS. */
  fetchManifest?: boolean;
  /** Where the gateway list came from (stated in the verdict line and the proof). */
  listSource?: ListSource;
  /** Tests only: lets http and local gateways in. */
  testOnlyAllowLocalGateways?: boolean;
  wait?: (ms: number) => Promise<unknown>;
  clock?: () => number;
}): Promise<Proof> {
  const s: Settings = { ...DEFAULT_SETTINGS, ...args.settings };
  const { publication: p, fetchImpl } = args;
  const fetchManifest = args.fetchManifest ?? true;
  const allowLocal = args.testOnlyAllowLocalGateways ?? false;
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
  const gateways = checkGatewaySetup(args.gateways, args.pinnedBy, allowLocal);

  /** One GET; the bytes are kept for the caller. */
  const get = async (url: string, timeout: number, accept?: string) => {
    const t0 = clock();
    try {
      const r = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeout),
        headers: accept ? { accept } : {},
      });
      const bytes = new Uint8Array(await r.arrayBuffer());
      const finalUrl = r.url && r.url !== url ? r.url : undefined;
      return {
        okStatus: r.ok,
        bytes,
        finalUrl,
        attempt: {
          status: r.status,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ms: Math.round(clock() - t0),
          ...(finalUrl ? { final_url: finalUrl } : {}),
        } as Attempt,
      };
    } catch (e) {
      return {
        okStatus: false,
        bytes: null,
        finalUrl: undefined,
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

  /** GETs until the answer matches or the attempts are spent. */
  const check = async (
    g: Gateway & { counted: boolean },
    url: string,
    expected: Expected,
    accept?: string,
  ): Promise<{
    result: GatewayResult;
    bytes: Uint8Array | null;
    answered: boolean;
  }> => {
    const timeout = timeoutFor(expected.size, s);
    const attempts: Attempt[] = [];
    const ownHost = (x: { finalUrl?: string }) =>
      !x.finalUrl || onGatewayHost(g, x.finalUrl);
    const matches = (x: Awaited<ReturnType<typeof get>>) =>
      x.okStatus &&
      ownHost(x) &&
      x.attempt.size === expected.size &&
      x.attempt.sha256 === expected.sha256;
    let last = await get(url, timeout, accept);
    attempts.push(last.attempt);
    while (!matches(last) && attempts.length < s.attempts) {
      await wait(waitBefore(attempts.length, s));
      last = await get(url, timeout, accept);
      attempts.push(last.attempt);
    }
    const a = last.attempt;
    return {
      result: {
        host: g.host,
        operator: g.operator,
        counted: g.counted,
        url,
        timeout_ms: timeout,
        status: a.status,
        size: a.size,
        sha256: a.sha256,
        ...(last.finalUrl ? { final_url: last.finalUrl } : {}),
        ok: matches(last),
        attempts,
      },
      bytes: last.okStatus && ownHost(last) ? last.bytes : null,
      answered: last.okStatus && ownHost(last),
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
    const results: GatewayResult[] = [];
    for (const g of gateways)
      results.push(
        (await check(g, gatewayPathUrl(g, o.cid), o.expected)).result,
      );
    const operators_matched = countedMatches(results);
    objects.push({
      ...o,
      gateways: results,
      operators_matched,
      pinning_operators_matched: pinningMatches(results),
      passes: operators_matched.length >= 2,
    });
  }

  const fatal: string[] = [];
  const folderGateways: FolderGatewayProof[] = [];
  for (const g of gateways) {
    const car = (
      await check(
        g,
        `${gatewayPathUrl(g, p.folder.cid)}?format=car`,
        p.folder.expected,
        "application/vnd.ipld.car",
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
      counted: g.counted,
      car,
      by_path: { files, rebuilt, ok, fatal: isFatal },
    });
  }
  const operators_matched = countedMatches(
    folderGateways.map((f) => ({
      ok: f.by_path.ok,
      operator: f.operator,
      counted: f.counted,
    })),
  );
  const car_operators_matched = countedMatches(
    folderGateways.map((f) => f.car),
  );
  const folder: FolderProof = {
    name: p.folder.name,
    cid: p.folder.cid,
    expected: p.folder.expected,
    gateways: folderGateways,
    car_operators_matched,
    operators_matched,
    passes:
      operators_matched.length >= 2 &&
      car_operators_matched.length >= 2 &&
      fatal.length === 0,
  };
  const allMet = objects.every((o) => o.passes) && folder.passes;
  const verdict: Verdict = !allMet
    ? "FAIL"
    : fetchManifest
      ? "PASS"
      : "INCOMPLETE";
  return {
    verdict,
    passes: verdict === "PASS",
    run_id: p.run_id,
    manifest_cid: p.manifestFile.cid,
    directory_cid: p.folder.cid,
    manifest_fetched: fetchManifest,
    pinned_by: [...args.pinnedBy],
    gateway_list: args.listSource ?? "default",
    test_only_local_gateways: allowLocal,
    gateways,
    settings: s,
    objects,
    folder,
    fatal,
  };
}

const answer = (r: GatewayResult) =>
  `${r.ok ? "match" : "NO MATCH"}${r.counted ? "" : " (pinning operator: reported, not counted)"}: status ${r.status ?? "none"}, ${r.size ?? "-"} bytes, sha256 ${r.sha256 ?? "-"}, ` +
  `${r.attempts.length} attempt(s), ${r.attempts.reduce((t, a) => t + a.ms, 0)} ms` +
  (r.final_url ? `, answered by ${r.final_url}` : "") +
  (r.attempts.at(-1)?.error ? ` (${r.attempts.at(-1)?.error})` : "");

/** The verdict line: the verdict, the run, and every condition that qualifies it. */
export function verdictLine(p: Proof): string {
  const notes = [
    `pinned by ${p.pinned_by.join(", ")}, not counted`,
    ...(p.manifest_fetched
      ? []
      : ["manifest not fetched (--skip-manifest-fetch)"]),
    ...(p.gateway_list === "default"
      ? []
      : [`default gateway list replaced by ${p.gateway_list}`]),
    ...(p.test_only_local_gateways
      ? [`TEST ONLY: local gateways allowed (${TEST_ONLY_SWITCH})`]
      : []),
  ];
  return `${p.verdict}: gateway check of run ${p.run_id} (${notes.join("; ")})`;
}

/** The proof's short text: the verdict line, one line per object and gateway, then the reasons. */
export function proofText(p: Proof): string {
  const lines = [
    verdictLine(p),
    `manifest ${p.manifest_cid}${p.manifest_fetched ? "" : " (read locally, not fetched)"}; folder ${p.directory_cid}`,
    `gateways (${p.gateway_list}): ${p.gateways.map((g) => `${g.host} (${g.operator}${g.counted ? "" : ", pinning, not counted"})`).join(", ")}`,
    `attempts ${p.settings.attempts}, waits ${p.settings.retryWaitMs}-${p.settings.retryWaitMaxMs} ms doubling, timeout ${p.settings.timeoutMs} ms + 1 s per ${p.settings.timeoutBytesPerS} B`,
  ];
  for (const o of p.objects) {
    lines.push(
      `${o.passes ? "MET" : "NOT MET"} ${o.kind} ${o.name} ${o.cid} (${o.expected.size} bytes, sha256 ${o.expected.sha256}): counted operators matched: ${o.operators_matched.join(", ") || "none"}; pinning operators matched (not counted): ${o.pinning_operators_matched.join(", ") || "none"}`,
    );
    for (const r of o.gateways) lines.push(`  ${r.host}: ${answer(r)}`);
  }
  const f = p.folder;
  lines.push(
    `${f.passes ? "MET" : "NOT MET"} folder ${f.name} ${f.cid} (CAR ${f.expected.size} bytes, sha256 ${f.expected.sha256}): (a) gateway CAR matched on counted ${f.car_operators_matched.join(", ") || "none"}; (b) rebuilt CAR matched on counted ${f.operators_matched.join(", ") || "none"}`,
  );
  for (const g of f.gateways) {
    lines.push(`  ${g.host} (a) gateway CAR: ${answer(g.car)}`);
    for (const x of g.by_path.files)
      lines.push(`  ${g.host} (b) ${x.name} by path: ${answer(x)}`);
    lines.push(
      `  ${g.host} (b) rebuilt CAR: ${
        g.by_path.rebuilt
          ? `root ${g.by_path.rebuilt.root}, ${g.by_path.rebuilt.size} bytes, sha256 ${g.by_path.rebuilt.sha256}: ${g.by_path.ok ? "match" : "MISMATCH (fatal)"}`
          : "not built (a file was not answered)"
      }${g.counted ? "" : " (pinning operator: reported, not counted)"}`,
    );
  }
  for (const x of p.fatal) lines.push(`FATAL ${x}`);
  if (p.verdict === "INCOMPLETE")
    lines.push(
      "INCOMPLETE: everything fetched met the rule, but the manifest was not fetched; this is not a pass.",
    );
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const usage =
    "usage: node src/gateway-verify.ts <publication dir> <proof dir> --pinned-by <Operator> [--pinned-by <Operator>] [--gateway host=Operator ...] [--attempts 5] [--retry-wait-ms 15000] [--retry-wait-max-ms 120000] [--timeout-ms 60000] [--timeout-bytes-per-s 131072] [--skip-manifest-fetch]";
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        "pinned-by": { type: "string", multiple: true },
        gateway: { type: "string", multiple: true },
        attempts: { type: "string" },
        "retry-wait-ms": { type: "string" },
        "retry-wait-max-ms": { type: "string" },
        "timeout-ms": { type: "string" },
        "timeout-bytes-per-s": { type: "string" },
        "skip-manifest-fetch": { type: "boolean" },
        [TEST_ONLY_SWITCH.slice(2)]: { type: "boolean" },
      },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n${usage}`);
    process.exit(2);
  }
  const [pubDir, proofDir] = positionals;
  if (!pubDir || !proofDir || positionals.length > 2) {
    console.error(usage);
    process.exit(2);
  }
  const allowLocal = values[TEST_ONLY_SWITCH.slice(2)] === true;
  if (allowLocal)
    console.error(
      `WARNING: ${TEST_ONLY_SWITCH} is for tests only: local and http gateways are allowed; the proof is marked and the record tool refuses it.`,
    );
  const num = (v: string | undefined) =>
    v === undefined ? undefined : Number(v);
  let gateways: readonly Gateway[] = GATEWAYS;
  let listSource: ListSource = "default";
  try {
    if (values.gateway?.length) {
      gateways = parseGatewayList(values.gateway);
      listSource = "--gateway";
    } else if (process.env.IPFS_GATEWAYS !== undefined) {
      gateways = parseGatewayList(process.env.IPFS_GATEWAYS);
      listSource = "IPFS_GATEWAYS";
    }
    checkGatewaySetup(gateways, values["pinned-by"] ?? [], allowLocal);
  } catch (e) {
    console.error(`${(e as Error).message}\n${usage}`);
    process.exit(2);
  }
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
    pinnedBy: values["pinned-by"] ?? [],
    fetchImpl: fetch,
    settings,
    fetchManifest: !values["skip-manifest-fetch"],
    listSource,
    testOnlyAllowLocalGateways: allowLocal,
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
  process.exitCode = EXIT_CODES[proof.verdict];
}
