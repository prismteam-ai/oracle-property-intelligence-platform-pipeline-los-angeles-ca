import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { ArtifactManifest } from "../src/artifact-manifest.ts";
import {
  DEFAULT_GATEWAYS,
  verifyOnGateways,
  type Fetch,
} from "../src/gateway-verify.ts";

// No network: every request goes to an in-memory fake, which fails the test on any unexpected host.
const bytes = new TextEncoder().encode('{"counts":1}\n');
const sha = createHash("sha256").update(bytes).digest("hex");
const manifest = {
  run_id: "r",
  files: [
    {
      name: "coverage.json",
      size: bytes.length,
      sha256: sha,
      cid: "bafkfile",
      published: true,
    },
    {
      name: "data/out/r/t.parquet",
      size: 9,
      sha256: "0",
      cid: "bafkdata",
      published: false,
    },
  ],
} as unknown as ArtifactManifest;

function fakeFetch(
  body: (url: string) => Uint8Array | Error,
  seen: string[],
): Fetch {
  return async (url) => {
    seen.push(url);
    if (!DEFAULT_GATEWAYS.some((g) => url.startsWith(g + "/ipfs/")))
      throw new Error(`unexpected host: ${url}`);
    const b = body(url);
    if (b instanceof Error) throw b;
    return { ok: true, status: 200, arrayBuffer: async () => b.slice().buffer };
  };
}

test("checks every published file by its CID and through the directory, on both gateways; skips unpublished files", async () => {
  const seen: string[] = [];
  const res = await verifyOnGateways({
    manifest,
    directoryCid: "bafydir",
    gateways: DEFAULT_GATEWAYS,
    fetchImpl: fakeFetch(
      (u) => (u.includes("format=car") ? new Uint8Array([1]) : bytes),
      seen,
    ),
  });
  expect(res.ok).toBe(true);
  expect(seen).toEqual([
    "https://ipfs.io/ipfs/bafkfile",
    "https://ipfs.io/ipfs/bafydir/coverage.json",
    "https://dweb.link/ipfs/bafkfile",
    "https://dweb.link/ipfs/bafydir/coverage.json",
    "https://ipfs.io/ipfs/bafydir?format=car",
    "https://dweb.link/ipfs/bafydir?format=car",
  ]);
});

test("a size or digest mismatch, or a failed request, fails the check without throwing", async () => {
  const wrong = await verifyOnGateways({
    manifest,
    directoryCid: "bafydir",
    gateways: DEFAULT_GATEWAYS,
    fetchImpl: fakeFetch(
      (u) =>
        u.includes("dweb.link/ipfs/bafkfile")
          ? new TextEncoder().encode("{}")
          : bytes,
      [],
    ),
  });
  expect(wrong.ok).toBe(false);
  expect(wrong.checks.filter((c) => !c.ok).map((c) => c.url)).toEqual([
    "https://dweb.link/ipfs/bafkfile",
  ]);
  const down = await verifyOnGateways({
    manifest,
    directoryCid: "bafydir",
    gateways: DEFAULT_GATEWAYS,
    fetchImpl: fakeFetch(
      (u) => (u.startsWith("https://ipfs.io") ? new Error("timeout") : bytes),
      [],
    ),
  });
  expect(down.ok).toBe(false);
  expect(down.checks[0]).toMatchObject({
    ok: false,
    status: null,
    error: "timeout",
  });
});

test("needs at least two gateways", async () => {
  await expect(
    verifyOnGateways({
      manifest,
      directoryCid: "d",
      gateways: ["https://ipfs.io"],
      fetchImpl: fakeFetch(() => bytes, []),
    }),
  ).rejects.toThrow(/two gateways/);
});
