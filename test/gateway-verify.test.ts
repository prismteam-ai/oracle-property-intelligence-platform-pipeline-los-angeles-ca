/**
 * The gateway check (src/gateway-verify.ts) and the shared gateway list (src/gateways.ts). No network: requests go
 * to an in-memory fake, or, for the command line, to fake gateways served on 127.0.0.1 by this test.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildArtifactManifest,
  folderEntry,
  jsonBytes,
  objectOf,
} from "../src/artifact-manifest.ts";
import {
  DEFAULT_SETTINGS,
  loadPublication,
  proofText,
  timeoutFor,
  verifyOnGateways,
  waitBefore,
  type Fetch,
  type Publication,
} from "../src/gateway-verify.ts";
import {
  GATEWAYS,
  gatewayPathUrl,
  isGatewayHost,
  parseGatewayList,
  type Gateway,
} from "../src/gateways.ts";
import { bytesCid, directoryCar, sha256Hex } from "../src/ipfs-unixfs.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const COVERAGE = enc('{\n  "run_id": "r",\n  "parcels": 3\n}\n');
const OBJECT = enc("PAR1 not really a parquet PAR1");

/** A publication folder of the check's shape, built with the pipeline's own functions. */
async function writePublication(dir: string, runId = "r") {
  const folder = await directoryCar([
    { name: "coverage.json", bytes: COVERAGE },
  ]);
  const manifest = jsonBytes(
    buildArtifactManifest(folderEntry(folder), [
      await objectOf("coverage.json", COVERAGE),
      await objectOf("x.parquet", OBJECT),
    ]),
  );
  mkdirSync(join(dir, "publish"), { recursive: true });
  writeFileSync(join(dir, "publish", "coverage.json"), COVERAGE);
  writeFileSync(join(dir, "artifact-manifest.json"), manifest);
  writeFileSync(join(dir, "directory.car"), folder.car);
  writeFileSync(
    join(dir, "directory.json"),
    jsonBytes({
      run_id: runId,
      directory_cid: folder.root,
      files: [await objectOf("coverage.json", COVERAGE)],
      car: {
        file: "directory.car",
        size: folder.car.length,
        sha256: folder.car_sha256,
      },
      artifact_manifest: await objectOf("artifact-manifest.json", manifest),
    }),
  );
  return {
    folderCid: folder.root,
    folderCar: folder.car,
    manifest,
    manifestCid: await bytesCid(manifest),
    coverageCid: await bytesCid(COVERAGE),
    objectCid: await bytesCid(OBJECT),
  };
}

type Pub = Awaited<ReturnType<typeof writePublication>>;

/** What a correct gateway answers for a path (after /ipfs/), or null (404). */
function content(p: Pub, path: string): Uint8Array | null {
  const table: Record<string, Uint8Array> = {
    [p.manifestCid]: p.manifest,
    [p.coverageCid]: COVERAGE,
    [p.objectCid]: OBJECT,
    [`${p.folderCid}/coverage.json`]: COVERAGE,
    [`${p.folderCid}?format=car`]: p.folderCar,
  };
  return table[path] ?? null;
}

const A: Gateway = { host: "gw-a.test", operator: "Operator A" };
const B: Gateway = { host: "gw-b.test", operator: "Operator B" };
const B2: Gateway = { host: "gw-b2.test", operator: "Operator B" };

type Answer = Uint8Array | Error | number; // bytes (200), a thrown error, or an HTTP status without body
function fakeFetch(
  respond: (url: string, path: string, host: string) => Answer | null,
  seen: { url: string; accept?: string; timeout?: boolean }[] = [],
): Fetch {
  return async (url, init) => {
    const m = /^https:\/\/([^/]+)\/ipfs\/(.+)$/.exec(url);
    if (!m) throw new Error(`unexpected URL: ${url}`);
    seen.push({
      url,
      accept: init.headers.accept,
      timeout: init.signal instanceof AbortSignal,
    });
    const a = respond(url, m[2], m[1]);
    if (a instanceof Error) throw a;
    if (a === null || typeof a === "number")
      return {
        ok: false,
        status: a ?? 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    return { ok: true, status: 200, arrayBuffer: async () => a.slice().buffer };
  };
}

const noWait = async () => {};

let dir = "";
let pub: Pub;
let publication: Publication;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gateway-verify-"));
  pub = await writePublication(join(dir, "pub"));
  publication = await loadPublication(join(dir, "pub"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the shared gateway list (src/gateways.ts)", () => {
  test("default: Aleph.im, Pinata and Filebase, in path form", () => {
    expect(GATEWAYS).toEqual([
      { host: "ipfs.aleph.cloud", operator: "Aleph.im" },
      { host: "gateway.pinata.cloud", operator: "Pinata" },
      { host: "ipfs.filebase.io", operator: "Filebase" },
    ]);
    expect(gatewayPathUrl(GATEWAYS[0], "bafyx")).toBe(
      "https://ipfs.aleph.cloud/ipfs/bafyx",
    );
    expect(gatewayPathUrl(GATEWAYS[2], "bafyx", "a b.json")).toBe(
      "https://ipfs.filebase.io/ipfs/bafyx/a%20b.json",
    );
  });

  test("has no Node imports, so the Explorer can bundle it", () => {
    const src = readFileSync("src/gateways.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/require\(|node:/);
  });

  test("a replacement list: host=Operator items; a host alone is its own operator; bad, empty or repeated hosts refused", () => {
    expect(
      parseGatewayList("a.example=Op A, b.example=Op B,c.example"),
    ).toEqual([
      { host: "a.example", operator: "Op A" },
      { host: "b.example", operator: "Op B" },
      { host: "c.example", operator: "c.example" },
    ]);
    expect(parseGatewayList(["a.example=X", "b.example=Y"])).toHaveLength(2);
    expect(parseGatewayList("http://127.0.0.1:8080=Local")).toEqual([
      { host: "http://127.0.0.1:8080", operator: "Local" },
    ]);
    expect(() => parseGatewayList(" , ")).toThrow("empty");
    expect(() => parseGatewayList("https://a.example=X")).toThrow(
      "not a gateway host",
    );
    expect(() => parseGatewayList("a.example/ipfs=X")).toThrow(
      "not a gateway host",
    );
    expect(() => parseGatewayList("a.example=X,a.example=Y")).toThrow("twice");
    expect(isGatewayHost("http://example.com")).toBe(false);
  });
});

describe("loadPublication", () => {
  test("reads the manifest, the record and publish/, and checks them against each other", () => {
    expect(publication).toMatchObject({
      run_id: "r",
      manifestFile: { cid: pub.manifestCid, size: pub.manifest.length },
      folder: {
        name: "publish",
        cid: pub.folderCid,
        expected: { size: pub.folderCar.length },
      },
      folderFiles: [
        {
          name: "coverage.json",
          size: COVERAGE.length,
          sha256: sha256Hex(COVERAGE),
        },
      ],
    });
  });

  test("refuses a record that does not match the manifest, a changed or extra folder file", async () => {
    const p = join(dir, "pub");
    writeFileSync(join(p, "artifact-manifest.json"), enc("{}\n"));
    await expect(loadPublication(p)).rejects.toThrow(
      "artifact_manifest is not the local",
    );
    await writePublication(p);
    writeFileSync(join(p, "publish", "other.json"), enc("{}"));
    await expect(loadPublication(p)).rejects.toThrow(
      "exactly directory.json's files",
    );
    rmSync(join(p, "publish", "other.json"));
    writeFileSync(join(p, "publish", "coverage.json"), enc("{}"));
    await expect(loadPublication(p)).rejects.toThrow(
      "differs from directory.json",
    );
  });
});

describe("verifyOnGateways", () => {
  test("every gateway: the manifest and every file by CID, the folder as a CAR (a) and by path rebuilt (b); passes", async () => {
    const seen: { url: string; accept?: string; timeout?: boolean }[] = [];
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B],
      fetchImpl: fakeFetch((_u, path) => content(pub, path), seen),
      wait: noWait,
    });
    expect(proof.passes).toBe(true);
    expect(proof.fatal).toEqual([]);
    expect(seen.map((s) => s.url)).toEqual([
      `https://gw-a.test/ipfs/${pub.manifestCid}`,
      `https://gw-b.test/ipfs/${pub.manifestCid}`,
      `https://gw-a.test/ipfs/${pub.coverageCid}`,
      `https://gw-b.test/ipfs/${pub.coverageCid}`,
      `https://gw-a.test/ipfs/${pub.objectCid}`,
      `https://gw-b.test/ipfs/${pub.objectCid}`,
      `https://gw-a.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-a.test/ipfs/${pub.folderCid}/coverage.json`,
      `https://gw-b.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-b.test/ipfs/${pub.folderCid}/coverage.json`,
    ]);
    expect(seen.every((s) => s.timeout)).toBe(true);
    expect(seen.filter((s) => s.accept).map((s) => s.url)).toEqual([
      `https://gw-a.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-b.test/ipfs/${pub.folderCid}?format=car`,
    ]);
    expect(
      proof.objects.map((o) => [o.kind, o.name, o.operators_matched]),
    ).toEqual([
      ["manifest", "artifact-manifest.json", ["Operator A", "Operator B"]],
      ["file", "coverage.json", ["Operator A", "Operator B"]],
      ["file", "x.parquet", ["Operator A", "Operator B"]],
    ]);
    expect(proof.folder).toMatchObject({
      cid: pub.folderCid,
      car_operators_matched: ["Operator A", "Operator B"],
      operators_matched: ["Operator A", "Operator B"],
      passes: true,
    });
    expect(proof.folder.gateways[0].by_path.rebuilt).toEqual({
      root: pub.folderCid,
      size: pub.folderCar.length,
      sha256: sha256Hex(pub.folderCar),
    });
    expect(proof.objects[0].gateways[0]).toMatchObject({
      status: 200,
      size: pub.manifest.length,
      sha256: sha256Hex(pub.manifest),
      ok: true,
      timeout_ms: timeoutFor(pub.manifest.length, DEFAULT_SETTINGS),
    });
    expect(proof.objects[0].gateways[0].attempts).toHaveLength(1);
    const text = proofText(proof);
    expect(text).toContain("Gateway check of run r: PASS");
    expect(text).toContain("gw-a.test (a) gateway CAR, not fatal: match");
    expect(text).toContain(`gw-b.test (b) rebuilt CAR: root ${pub.folderCid}`);
  });

  test("two gateways of different operators suffice; two of the same operator do not", async () => {
    const aDown = fakeFetch((_u, path, host) =>
      host === "gw-a.test" ? new Error("fetch failed") : content(pub, path),
    );
    const sameOperator = await verifyOnGateways({
      publication,
      gateways: [A, B, B2],
      fetchImpl: aDown,
      settings: { attempts: 2 },
      wait: noWait,
    });
    expect(sameOperator.passes).toBe(false);
    expect(sameOperator.objects.every((o) => !o.passes)).toBe(true);
    expect(sameOperator.objects[0].operators_matched).toEqual(["Operator B"]);
    expect(sameOperator.folder.passes).toBe(false);
    expect(sameOperator.fatal).toEqual([]);
    // Every failure is in the proof: the attempts, their error and time.
    expect(sameOperator.objects[0].gateways[0]).toMatchObject({
      host: "gw-a.test",
      ok: false,
      status: null,
      attempts: [
        { status: null, error: "fetch failed" },
        { status: null, error: "fetch failed" },
      ],
    });
    const C: Gateway = { host: "gw-c.test", operator: "Operator C" };
    const other = await verifyOnGateways({
      publication,
      gateways: [A, B, C],
      fetchImpl: fakeFetch((_u, path, host) =>
        host === "gw-a.test" ? 504 : content(pub, path),
      ),
      settings: { attempts: 1 },
      wait: noWait,
    });
    expect(other.passes).toBe(true);
    expect(other.objects[1].gateways[0]).toMatchObject({
      status: 504,
      ok: false,
    });
  });

  test("a failure or mismatch is fetched again, up to 5 attempts by default, waiting 15, 30, 60 and 120 s", async () => {
    const waits: number[] = [];
    let calls = 0;
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B],
      fetchImpl: fakeFetch((u, path) => {
        if (u === `https://gw-a.test/ipfs/${pub.objectCid}`) {
          calls++;
          return calls < 5 ? enc("not yet") : OBJECT;
        }
        if (u === `https://gw-b.test/ipfs/${pub.objectCid}`) return 429;
        return content(pub, path);
      }),
      wait: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([
      15_000, 30_000, 60_000, 120_000, 15_000, 30_000, 60_000, 120_000,
    ]);
    const x = proof.objects.find((o) => o.name === "x.parquet")!;
    expect(x.gateways.map((g) => [g.ok, g.attempts.length, g.status])).toEqual([
      [true, 5, 200],
      [false, 5, 429],
    ]);
    expect(x.passes).toBe(false);
    expect(proof.passes).toBe(false);
    expect([1, 2, 3, 4, 5].map((n) => waitBefore(n, DEFAULT_SETTINGS))).toEqual(
      [15_000, 30_000, 60_000, 120_000, 120_000],
    );
  });

  test("time limits: about a minute for a small file, scaled by size (310 s for the 32.8 MB county Parquet); configurable", () => {
    expect(timeoutFor(1_177, DEFAULT_SETTINGS)).toBe(60_009);
    expect(timeoutFor(32_775_616, DEFAULT_SETTINGS)).toBe(310_059);
    expect(
      timeoutFor(1_000, {
        ...DEFAULT_SETTINGS,
        timeoutMs: 5,
        timeoutBytesPerS: 1_000,
      }),
    ).toBe(1_005);
    expect(DEFAULT_SETTINGS).toEqual({
      attempts: 5,
      retryWaitMs: 15_000,
      retryWaitMaxMs: 120_000,
      timeoutMs: 60_000,
      timeoutBytesPerS: 131_072,
    });
  });

  test("(a) the gateway's folder CAR in another order is reported, fetched once, and not fatal", async () => {
    const reordered = new Uint8Array(pub.folderCar);
    reordered.reverse();
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B],
      fetchImpl: fakeFetch((u, path) =>
        u.startsWith("https://gw-a.test") && path.endsWith("?format=car")
          ? reordered
          : content(pub, path),
      ),
      wait: noWait,
    });
    expect(proof.passes).toBe(true);
    expect(proof.folder.gateways[0].car).toMatchObject({
      ok: false,
      size: pub.folderCar.length,
    });
    expect(proof.folder.gateways[0].car.attempts).toHaveLength(1);
    expect(proof.folder.car_operators_matched).toEqual(["Operator B"]);
    expect(proofText(proof)).toContain(
      "gw-a.test (a) gateway CAR, not fatal: NO MATCH",
    );
  });

  test("(a) a failed CAR request is fetched again", async () => {
    let n = 0;
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B],
      fetchImpl: fakeFetch((u, path) =>
        u === `https://gw-a.test/ipfs/${pub.folderCid}?format=car` && ++n < 3
          ? 502
          : content(pub, path),
      ),
      wait: noWait,
    });
    expect(proof.folder.gateways[0].car).toMatchObject({ ok: true });
    expect(proof.folder.gateways[0].car.attempts.map((a) => a.status)).toEqual([
      502, 502, 200,
    ]);
  });

  test("(b) other bytes by path rebuild to another CAR: fatal, even when two other operators pass", async () => {
    const C: Gateway = { host: "gw-c.test", operator: "Operator C" };
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, C],
      fetchImpl: fakeFetch((u, path) =>
        u === `https://gw-c.test/ipfs/${pub.folderCid}/coverage.json`
          ? enc("{}\n")
          : content(pub, path),
      ),
      settings: { attempts: 2 },
      wait: noWait,
    });
    expect(proof.objects.every((o) => o.passes)).toBe(true);
    expect(proof.folder.operators_matched).toEqual([
      "Operator A",
      "Operator B",
    ]);
    const c = proof.folder.gateways[2];
    expect(c.by_path).toMatchObject({ ok: false, fatal: true });
    expect(c.by_path.files[0].attempts).toHaveLength(2);
    expect(c.by_path.rebuilt?.root).not.toBe(pub.folderCid);
    expect(proof.fatal).toHaveLength(1);
    expect(proof.fatal[0]).toMatch(
      /^gw-c\.test: the folder's files by path rebuild to another CAR/,
    );
    expect(proof.folder.passes).toBe(false);
    expect(proof.passes).toBe(false);
    expect(proofText(proof)).toContain("MISMATCH (fatal)");
  });

  test("(b) a file not answered by path is not fatal: no CAR is rebuilt on that gateway", async () => {
    const C: Gateway = { host: "gw-c.test", operator: "Operator C" };
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, C],
      fetchImpl: fakeFetch((u, path) =>
        u.startsWith("https://gw-c.test") && path.includes("/")
          ? 404
          : content(pub, path),
      ),
      settings: { attempts: 1 },
      wait: noWait,
    });
    expect(proof.folder.gateways[2].by_path).toMatchObject({
      ok: false,
      fatal: false,
      rebuilt: null,
    });
    expect(proof.passes).toBe(true);
  });

  test("--skip-manifest-fetch: the manifest is read locally only, and the proof says so", async () => {
    const seen: { url: string }[] = [];
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B],
      fetchImpl: fakeFetch((_u, path) => content(pub, path), seen),
      fetchManifest: false,
      wait: noWait,
    });
    expect(proof.passes).toBe(true);
    expect(proof.manifest_fetched).toBe(false);
    expect(seen.some((s) => s.url.includes(pub.manifestCid))).toBe(false);
    expect(proof.objects.map((o) => o.kind)).toEqual(["file", "file"]);
    expect(proofText(proof)).toContain(
      "(read locally, not fetched: --skip-manifest-fetch)",
    );
  });

  test("refuses fewer than two operators and invalid settings", async () => {
    const f = fakeFetch((_u, path) => content(pub, path));
    await expect(
      verifyOnGateways({ publication, gateways: [B, B2], fetchImpl: f }),
    ).rejects.toThrow("at least two operators");
    await expect(
      verifyOnGateways({
        publication,
        gateways: [A, B],
        fetchImpl: f,
        settings: { attempts: 0 },
      }),
    ).rejects.toThrow("attempts");
    await expect(
      verifyOnGateways({
        publication,
        gateways: [A, B],
        fetchImpl: f,
        settings: { timeoutBytesPerS: 0 },
      }),
    ).rejects.toThrow("timeoutBytesPerS");
  });
});

describe("the command, against two fake gateways on 127.0.0.1", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise((r) => s.close(r))),
    );
  });
  async function serve(
    answer: (path: string) => Uint8Array | null,
  ): Promise<string> {
    const s = createServer((req, res) => {
      const path = (req.url ?? "").replace(/^\/ipfs\//, "");
      const b = answer(path);
      if (!b) return void res.writeHead(404).end();
      res.writeHead(200, { "content-length": b.length }).end(Buffer.from(b));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  const run = promisify(execFile);

  test("--gateway list: writes the JSON and text proof and exits 0; IPFS_GATEWAYS also works, and a failing run exits 1", async () => {
    const one = await serve((p) => content(pub, p));
    const two = await serve((p) => content(pub, p));
    const proofDir = join(dir, "proof");
    const out = await run(process.execPath, [
      "src/gateway-verify.ts",
      join(dir, "pub"),
      proofDir,
      "--gateway",
      `${one}=One`,
      "--gateway",
      `${two}=Two`,
      "--attempts",
      "1",
    ]);
    expect(out.stdout).toContain("Gateway check of run r: PASS");
    const proof = JSON.parse(
      readFileSync(join(proofDir, "gateway-check-r.json"), "utf8"),
    );
    expect(proof).toMatchObject({
      run_id: "r",
      passes: true,
      manifest_fetched: true,
      gateways: [
        { host: one, operator: "One" },
        { host: two, operator: "Two" },
      ],
      settings: { ...DEFAULT_SETTINGS, attempts: 1 },
    });
    expect(proof.started_at).toMatch(/Z$/);
    expect(
      readFileSync(join(proofDir, "gateway-check-r.txt"), "utf8"),
    ).toContain("PASS folder publish");

    const empty = await serve(() => null);
    const failed = await run(
      process.execPath,
      [
        "src/gateway-verify.ts",
        join(dir, "pub"),
        proofDir,
        "--attempts",
        "1",
        "--skip-manifest-fetch",
      ],
      { env: { ...process.env, IPFS_GATEWAYS: `${one}=One,${empty}=Empty` } },
    ).then(
      () => null,
      (e: { code: number; stdout: string }) => e,
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stdout).toContain("Gateway check of run r: FAIL");
    expect(failed?.stdout).toContain(`${empty}: NO MATCH: status 404`);
  });

  test("usage without arguments", async () => {
    const e = await run(process.execPath, ["src/gateway-verify.ts"]).then(
      () => null,
      (x: { code: number; stderr: string }) => x,
    );
    expect(e?.code).toBe(2);
    expect(e?.stderr).toContain(
      "usage: node src/gateway-verify.ts <publication dir> <proof dir>",
    );
  });
});
