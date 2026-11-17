/**
 * Gateway check after an approved publication (not run as part of any build or test against the
 * network): fetch every published CID of a run from two public gateways this environment does not
 * operate, and compare the bytes (size and sha256).
 *
 * Checked on each gateway:
 * - the run's artifact manifest itself, /ipfs/<manifest cid>, against the local artifact-manifest.json;
 * - every file the manifest lists, /ipfs/<cid>, against its entry; for coverage.json, the folder's file,
 *   also /ipfs/<folder cid>/coverage.json;
 * - the folder (the manifest's one directory entry) fetched as a CAR (?format=car): its sha256 is
 *   recorded but not compared, because a gateway may order or frame blocks differently from the local
 *   CAR; the folder's content is compared through its file's path above.
 *
 * Boundary (kit rules/external-dependency-boundaries.md): an operator-run, sequential, synchronous
 * check of a few files. Each request has a 60 s timeout; a failed or mismatching URL is fetched again
 * up to `attempts` times in all (default 3), `retryWaitMs` apart (default 30 s), because a gateway can
 * take minutes to find newly uploaded content. Every attempt is reported.
 *
 * Usage: node src/gateway-verify.ts <run output dir: data/ipfs/runs/<run_id>> <proof output dir>
 *        [--gateway https://ipfs.io --gateway https://dweb.link] [--attempts 3] [--retry-wait-ms 30000]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ArtifactManifest } from "./artifact-manifest.ts";
import {
  ARTIFACT_MANIFEST_NAME,
  PUBLISH_FOLDER_FILES,
} from "./publish-guard.ts";

export const DEFAULT_GATEWAYS = ["https://ipfs.io", "https://dweb.link"];
const TIMEOUT_MS = 60_000;

export type Fetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type Check = {
  url: string;
  expected_size: number | null;
  expected_sha256: string | null;
  status: number | null;
  size: number | null;
  sha256: string | null;
  ok: boolean;
  attempts: number;
  error?: string;
};

async function get(fetchImpl: Fetch, url: string, accept?: string) {
  try {
    const r = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: accept ? { accept } : {},
    });
    const b = new Uint8Array(await r.arrayBuffer());
    return {
      status: r.status,
      ok: r.ok,
      size: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
    };
  } catch (e) {
    return {
      status: null,
      ok: false,
      size: null,
      sha256: null,
      error: (e as Error).message,
    };
  }
}

export async function verifyOnGateways(args: {
  manifest: ArtifactManifest;
  /** The manifest file's own CID, size and sha256. */
  manifestFile: { cid: string; size: number; sha256: string };
  gateways: string[];
  fetchImpl: Fetch;
  attempts?: number;
  retryWaitMs?: number;
  wait?: (ms: number) => Promise<unknown>;
}): Promise<{ ok: boolean; checks: Check[]; directory_car: Check[] }> {
  const { manifest, manifestFile, fetchImpl } = args;
  const attempts = args.attempts ?? 3;
  const retryWaitMs = args.retryWaitMs ?? 30_000;
  const wait = args.wait ?? ((ms: number) => sleep(ms));
  if (args.gateways.length < 2)
    throw new Error("at least two gateways are required");
  if (attempts < 1) throw new Error("attempts must be at least 1");
  const dirs = manifest.objects.filter((o) => o.codec === "directory");
  if (dirs.length !== 1)
    throw new Error("the artifact manifest must list exactly one directory");
  const folderCid = dirs[0].cid;
  const inFolder = (name: string) =>
    (PUBLISH_FOLDER_FILES as readonly string[]).includes(name);

  const check = async (
    url: string,
    expected: { size: number | null; sha256: string | null },
    accept?: string,
  ): Promise<Check> => {
    let r: Awaited<ReturnType<typeof get>> = await get(fetchImpl, url, accept);
    const passes = (x: typeof r) =>
      x.ok &&
      (expected.sha256 === null ||
        (x.size === expected.size && x.sha256 === expected.sha256));
    let n = 1;
    while (!passes(r) && n < attempts) {
      await wait(retryWaitMs);
      r = await get(fetchImpl, url, accept);
      n++;
    }
    return {
      url,
      expected_size: expected.size,
      expected_sha256: expected.sha256,
      ...r,
      ok: passes(r),
      attempts: n,
    };
  };

  const checks: Check[] = [];
  const directory_car: Check[] = [];
  for (const gw of args.gateways.map((g) => g.replace(/\/+$/, ""))) {
    checks.push(await check(`${gw}/ipfs/${manifestFile.cid}`, manifestFile));
    for (const f of manifest.objects.filter((o) => o.codec === "file"))
      for (const url of [
        `${gw}/ipfs/${f.cid}`,
        ...(inFolder(f.name)
          ? [`${gw}/ipfs/${folderCid}/${encodeURIComponent(f.name)}`]
          : []),
      ])
        checks.push(await check(url, f));
  }
  for (const gw of args.gateways.map((g) => g.replace(/\/+$/, "")))
    directory_car.push(
      await check(
        `${gw}/ipfs/${folderCid}?format=car`,
        { size: null, sha256: null },
        "application/vnd.ipld.car",
      ),
    );
  return {
    ok:
      checks.length > 0 &&
      checks.every((c) => c.ok) &&
      directory_car.every((c) => c.ok),
    checks,
    directory_car,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      gateway: { type: "string", multiple: true },
      attempts: { type: "string" },
      "retry-wait-ms": { type: "string" },
    },
  });
  const [runDir, proofDir] = positionals;
  if (!runDir || !proofDir)
    throw new Error(
      "usage: gateway-verify.ts <run output dir> <proof output dir>",
    );
  const manifest = JSON.parse(
    readFileSync(join(runDir, ARTIFACT_MANIFEST_NAME), "utf8"),
  ) as ArtifactManifest;
  const record = JSON.parse(
    readFileSync(join(runDir, "directory.json"), "utf8"),
  ) as {
    run_id: string;
    directory_cid: string;
    artifact_manifest: { cid: string; size: number; sha256: string };
  };
  const started_at = new Date().toISOString();
  const res = await verifyOnGateways({
    manifest,
    manifestFile: record.artifact_manifest,
    gateways: values.gateway ?? DEFAULT_GATEWAYS,
    fetchImpl: fetch,
    attempts: values.attempts ? Number(values.attempts) : undefined,
    retryWaitMs: values["retry-wait-ms"]
      ? Number(values["retry-wait-ms"])
      : undefined,
  });
  mkdirSync(proofDir, { recursive: true });
  const out = join(proofDir, `gateway-check-${record.run_id}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        run_id: record.run_id,
        manifest_cid: record.artifact_manifest.cid,
        directory_cid: record.directory_cid,
        started_at,
        ...res,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${res.ok ? "PASS" : "FAIL"}: ${res.checks.filter((c) => c.ok).length}/${res.checks.length} file checks; ${out}`,
  );
  process.exitCode = res.ok ? 0 : 1;
}
