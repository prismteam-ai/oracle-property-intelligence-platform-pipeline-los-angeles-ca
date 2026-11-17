import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { ArtifactManifest } from "../src/artifact-manifest.ts";
import {
  DEFAULT_GATEWAYS,
  verifyOnGateways,
  type Fetch,
} from "../src/gateway-verify.ts";

// No network: every request goes to an in-memory fake, which fails the test on any unexpected host.
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = new TextEncoder().encode('{"counts":1}\n');
const manifest: ArtifactManifest = {
  objects: [
    {
      cid: "bafydir",
      name: "publish",
      size: 99,
      codec: "directory",
      ipld_codec: "dag-pb",
      sha256: "0".repeat(64),
    },
    {
      cid: "bafkfile",
      name: "coverage.json",
      size: bytes.length,
      codec: "file",
      ipld_codec: "raw",
      sha256: sha(bytes),
    },
    {
      cid: "bafyobject",
      name: "x.parquet",
      size: bytes.length,
      codec: "file",
      ipld_codec: "dag-pb",
      sha256: sha(bytes),
    },
  ],
};
const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
const manifestFile = {
  cid: "bafkmanifest",
  size: manifestBytes.length,
  sha256: sha(manifestBytes),
};
const body = (u: string) =>
  u.includes("format=car")
    ? new Uint8Array([1])
    : u.includes("bafkmanifest")
      ? manifestBytes
      : bytes;

function fakeFetch(
  respond: (url: string) => Uint8Array | Error,
  seen: string[],
): Fetch {
  return async (url) => {
    seen.push(url);
    if (!DEFAULT_GATEWAYS.some((g) => url.startsWith(g + "/ipfs/")))
      throw new Error(`unexpected host: ${url}`);
    const b = respond(url);
    if (b instanceof Error) throw b;
    return { ok: true, status: 200, arrayBuffer: async () => b.slice().buffer };
  };
}

const noWait = async () => {};

test("fetches the artifact manifest and every file by its CID on both gateways, the folder's file also through the folder, and the folder as a CAR", async () => {
  const seen: string[] = [];
  const res = await verifyOnGateways({
    manifest,
    manifestFile,
    gateways: DEFAULT_GATEWAYS,
    fetchImpl: fakeFetch(body, seen),
    wait: noWait,
  });
  expect(res.ok).toBe(true);
  expect(seen).toEqual([
    "https://ipfs.io/ipfs/bafkmanifest",
    "https://ipfs.io/ipfs/bafkfile",
    "https://ipfs.io/ipfs/bafydir/coverage.json",
    "https://ipfs.io/ipfs/bafyobject",
    "https://dweb.link/ipfs/bafkmanifest",
    "https://dweb.link/ipfs/bafkfile",
    "https://dweb.link/ipfs/bafydir/coverage.json",
    "https://dweb.link/ipfs/bafyobject",
    "https://ipfs.io/ipfs/bafydir?format=car",
    "https://dweb.link/ipfs/bafydir?format=car",
  ]);
  expect(res.checks.every((c) => c.attempts === 1)).toBe(true);
});

test("a mismatch is fetched again up to the attempts given, waiting between; a later match passes", async () => {
  const seen: string[] = [];
  const waits: number[] = [];
  let manifestCalls = 0;
  const res = await verifyOnGateways({
    manifest,
    manifestFile,
    gateways: DEFAULT_GATEWAYS,
    fetchImpl: fakeFetch((u) => {
      if (u === "https://ipfs.io/ipfs/bafkmanifest" && ++manifestCalls < 3)
        return new TextEncoder().encode("{}");
      return body(u);
    }, seen),
    attempts: 3,
    retryWaitMs: 5,
    wait: async (ms) => void waits.push(ms),
  });
  expect(res.ok).toBe(true);
  expect(res.checks[0]).toMatchObject({
    url: "https://ipfs.io/ipfs/bafkmanifest",
    ok: true,
    attempts: 3,
  });
  expect(waits).toEqual([5, 5]);
});

test("a size or digest mismatch, or a failed request, fails the check without throwing after the last attempt", async () => {
  const wrong = await verifyOnGateways({
    manifest,
    manifestFile,
    gateways: DEFAULT_GATEWAYS,
    fetchImpl: fakeFetch(
      (u) =>
        u.includes("dweb.link/ipfs/bafkfile")
          ? new TextEncoder().encode("{}")
          : body(u),
      [],
    ),
    attempts: 2,
    wait: noWait,
  });
  expect(wrong.ok).toBe(false);
  expect(
    wrong.checks.filter((c) => !c.ok).map((c) => [c.url, c.attempts]),
  ).toEqual([["https://dweb.link/ipfs/bafkfile", 2]]);
  const down = await verifyOnGateways({
    manifest,
    manifestFile,
    gateways: DEFAULT_GATEWAYS,
    fetchImpl: fakeFetch(
      (u) => (u.startsWith("https://ipfs.io") ? new Error("timeout") : body(u)),
      [],
    ),
    attempts: 1,
    wait: noWait,
  });
  expect(down.ok).toBe(false);
  expect(down.checks[0]).toMatchObject({
    ok: false,
    status: null,
    error: "timeout",
    attempts: 1,
  });
});

test("needs at least two gateways and exactly one directory in the manifest", async () => {
  await expect(
    verifyOnGateways({
      manifest,
      manifestFile,
      gateways: ["https://ipfs.io"],
      fetchImpl: fakeFetch(body, []),
    }),
  ).rejects.toThrow(/two gateways/);
  await expect(
    verifyOnGateways({
      manifest: { objects: manifest.objects.slice(1) },
      manifestFile,
      gateways: DEFAULT_GATEWAYS,
      fetchImpl: fakeFetch(body, []),
    }),
  ).rejects.toThrow(/exactly one directory/);
});
