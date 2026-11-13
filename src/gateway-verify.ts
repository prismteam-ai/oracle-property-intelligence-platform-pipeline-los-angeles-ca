/**
 * Gateway check after an approved publication (not run as part of any build or test against the
 * network): fetch every published CID from two public gateways this environment does not operate,
 * and compare the bytes with the artifact manifest (size and sha256).
 *
 * Checked per published file: /ipfs/<file cid> and /ipfs/<directory cid>/<name>, on each gateway.
 * The directory itself is also fetched as a CAR (?format=car); its sha256 is recorded but not
 * compared, because a gateway may order or frame blocks differently from the local CAR.
 *
 * Boundary (kit rules/external-dependency-boundaries.md): an operator-run, sequential, synchronous
 * check of a few small files. Each request has a 60 s timeout, there is no automatic retry, and a
 * failure is reported per URL; the recovery is to re-run the script.
 *
 * Usage: node src/gateway-verify.ts <run output dir: data/ipfs/<run_id>> <proof output dir>
 *        [--gateway https://ipfs.io --gateway https://dweb.link]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ArtifactManifest } from "./artifact-manifest.ts";

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
  directoryCid: string;
  gateways: string[];
  fetchImpl: Fetch;
}): Promise<{ ok: boolean; checks: Check[]; directory_car: Check[] }> {
  const { manifest, directoryCid, fetchImpl } = args;
  if (args.gateways.length < 2)
    throw new Error("at least two gateways are required");
  const published = manifest.files.filter((f) => f.published);
  const checks: Check[] = [];
  for (const gw of args.gateways.map((g) => g.replace(/\/+$/, "")))
    for (const f of published)
      for (const url of [
        `${gw}/ipfs/${f.cid}`,
        `${gw}/ipfs/${directoryCid}/${encodeURIComponent(f.name)}`,
      ]) {
        const r = await get(fetchImpl, url);
        checks.push({
          url,
          expected_size: f.size,
          expected_sha256: f.sha256,
          ...r,
          ok: r.ok && r.size === f.size && r.sha256 === f.sha256,
        });
      }
  const directory_car: Check[] = [];
  for (const gw of args.gateways.map((g) => g.replace(/\/+$/, ""))) {
    const url = `${gw}/ipfs/${directoryCid}?format=car`;
    const r = await get(fetchImpl, url, "application/vnd.ipld.car");
    directory_car.push({
      url,
      expected_size: null,
      expected_sha256: null,
      ...r,
    });
  }
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
    options: { gateway: { type: "string", multiple: true } },
  });
  const [runDir, proofDir] = positionals;
  if (!runDir || !proofDir)
    throw new Error(
      "usage: gateway-verify.ts <run output dir> <proof output dir>",
    );
  const manifest = JSON.parse(
    readFileSync(join(runDir, "publish/artifact-manifest.json"), "utf8"),
  ) as ArtifactManifest;
  const { directory_cid } = JSON.parse(
    readFileSync(join(runDir, "directory.json"), "utf8"),
  ) as { directory_cid: string };
  const started_at = new Date().toISOString();
  const res = await verifyOnGateways({
    manifest,
    directoryCid: directory_cid,
    gateways: values.gateway ?? DEFAULT_GATEWAYS,
    fetchImpl: fetch,
  });
  mkdirSync(proofDir, { recursive: true });
  const out = join(proofDir, `gateway-check-${manifest.run_id}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      { run_id: manifest.run_id, directory_cid, started_at, ...res },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${res.ok ? "PASS" : "FAIL"}: ${res.checks.filter((c) => c.ok).length}/${res.checks.length} file checks; ${out}`,
  );
  process.exitCode = res.ok ? 0 : 1;
}
