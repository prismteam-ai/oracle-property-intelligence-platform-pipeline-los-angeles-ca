/**
 * The gateway check (src/gateway-verify.ts) and the shared gateway list (src/gateways.ts). No network: requests go
 * to an in-memory fake, or, for the command line, to fake gateways served on 127.0.0.1 by this test (through the
 * test-only switch).
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
  EXIT_CODES,
  TEST_ONLY_SWITCH,
  checkGatewaySetup,
  loadPublication,
  proofText,
  timeoutFor,
  verdictLine,
  verifyOnGateways,
  waitBefore,
  type Fetch,
  type Publication,
} from "../src/gateway-verify.ts";
import {
  GATEWAYS,
  gatewayPathUrl,
  localGatewayProblem,
  onGatewayHost,
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
const C: Gateway = { host: "gw-c.test", operator: "Operator C" };
const P: Gateway = { host: "gw-pin.test", operator: "Pinner" };

/** bytes (200), a thrown error, an HTTP status without body, or bytes answered from another URL (a redirect). */
type Answer = Uint8Array | Error | number | { bytes: Uint8Array; from: string };
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
        url,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    if (!(a instanceof Uint8Array))
      return {
        ok: true,
        status: 200,
        url: a.from,
        arrayBuffer: async () => a.bytes.slice().buffer,
      };
    return {
      ok: true,
      status: 200,
      url,
      arrayBuffer: async () => a.slice().buffer,
    };
  };
}
const correct = (pub: Pub) => fakeFetch((_u, path) => content(pub, path));

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
    for (const g of GATEWAYS) expect(localGatewayProblem(g)).toBeNull();
  });

  test("has no Node imports, so the Explorer can bundle it", () => {
    const src = readFileSync("src/gateways.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/require\(|node:/);
  });

  test("a replacement list: every item host=Operator; a host without its operator, bad, empty or repeated hosts refused", () => {
    expect(
      parseGatewayList("a.example=Op A, b.example=Op B,https://c.example=C"),
    ).toEqual([
      { host: "a.example", operator: "Op A" },
      { host: "b.example", operator: "Op B" },
      { host: "https://c.example", operator: "C" },
    ]);
    expect(parseGatewayList(["a.example=X", "b.example=Y"])).toHaveLength(2);
    expect(() => parseGatewayList("a.example=X,c.example")).toThrow(
      'gateway "c.example" has no declared operator',
    );
    expect(() => parseGatewayList("a.example=")).toThrow(
      "no declared operator",
    );
    expect(() => parseGatewayList(" , ")).toThrow("empty");
    expect(() => parseGatewayList("a.example/ipfs=X")).toThrow(
      "not a gateway host",
    );
    expect(() => parseGatewayList("a.example=X,https://a.example=Y")).toThrow(
      "twice",
    );
  });

  test("a real run refuses non-https and local or private addresses: loopback, RFC 1918, link-local, unique-local, 0.0.0.0", () => {
    for (const host of [
      "http://gw.example",
      "localhost",
      "https://localhost:8080",
      "ipfs.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "[::1]",
      "[::]",
      "[fe80::1]",
      "[fd12:3456::1]",
      "[fc00::1]:8443",
      "[::ffff:192.168.0.1]",
      "http://127.0.0.1:8080",
    ])
      expect(localGatewayProblem({ host, operator: "X" }), host).not.toBeNull();
    for (const host of [
      "ipfs.aleph.cloud",
      "https://gateway.pinata.cloud",
      "172.32.0.1",
      "8.8.8.8",
      "[2001:db8::1]",
    ])
      expect(localGatewayProblem({ host, operator: "X" }), host).toBeNull();
  });

  test("a real run tests the host as the URL parser reads it: other loopback forms and carrier-grade NAT refused", () => {
    for (const host of [
      "127.1",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "017700000001",
      "0",
      "[::ffff:7f00:1]",
      "[0:0:0:0:0:ffff:127.0.0.1]",
      "https://127.1:8443",
      "[::ffff:c0a8:1]",
      "100.64.0.1",
      "100.127.255.255",
      "999.1.1.1",
    ])
      expect(localGatewayProblem({ host, operator: "X" }), host).not.toBeNull();
    for (const host of ["100.63.255.255", "100.128.0.1", "[::ffff:808:808]"])
      expect(localGatewayProblem({ host, operator: "X" }), host).toBeNull();
  });

  test("host and host:443 are one gateway; so are http host and host:80", () => {
    expect(() =>
      parseGatewayList(
        "gateway.pinata.cloud=Pinata,gateway.pinata.cloud:443=Pinata Ltd",
      ),
    ).toThrow("twice");
    expect(() =>
      parseGatewayList("https://a.example=X,a.example:443=Y"),
    ).toThrow("twice");
    expect(() =>
      parseGatewayList("http://a.example=X,http://a.example:80=Y"),
    ).toThrow("twice");
    expect(parseGatewayList("a.example=X,a.example:8443=Y")).toHaveLength(2);
    expect(() => parseGatewayList("a.example:99999=X")).toThrow(
      "not a gateway host",
    );
  });

  test("an answer counts for a gateway only from its own host or a subdomain", () => {
    expect(onGatewayHost(A, "https://gw-a.test/ipfs/x")).toBe(true);
    expect(onGatewayHost(A, "https://bafyx.ipfs.gw-a.test/")).toBe(true);
    expect(onGatewayHost(A, "https://gw-b.test/ipfs/x")).toBe(false);
    expect(onGatewayHost(A, "https://evil-gw-a.test/ipfs/x")).toBe(false);
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

describe("checkGatewaySetup", () => {
  test("requires --pinned-by, an operator that is in the list (any case), and two counted operators left", () => {
    expect(() => checkGatewaySetup([A, B, P], [], false)).toThrow(
      "--pinned-by <Operator> is required",
    );
    expect(() => checkGatewaySetup([A, B, P], ["Pinata"], false)).toThrow(
      "--pinned-by Pinata: no gateway in the list has that operator",
    );
    expect(() => checkGatewaySetup([A, B, B2], ["Operator B"], false)).toThrow(
      "at least two operators that do not pin",
    );
    expect(checkGatewaySetup([A, B, P], ["pinner"], false)).toEqual([
      { ...A, counted: true },
      { ...B, counted: true },
      { ...P, counted: false },
    ]);
    expect(() =>
      checkGatewaySetup(
        [A, B, { host: "gw.test", operator: " " }],
        ["Operator A"],
        false,
      ),
    ).toThrow("no declared operator");
  });

  test("operators are counted on a trimmed, lower-cased label: Pinata and pinata on two hosts are one operator", () => {
    const list = parseGatewayList(
      "gateway.pinata.cloud=Pinata,other.mypinata.cloud=pinata,ipfs.filebase.io=Filebase",
    );
    expect(() => checkGatewaySetup(list, ["Filebase"], false)).toThrow(
      "at least two operators that do not pin",
    );
    expect(() =>
      checkGatewaySetup(
        [
          { host: "gw-a.test", operator: "Pinata" },
          { host: "gw-b.test", operator: " PINATA " },
          P,
        ],
        ["Pinner"],
        false,
      ),
    ).toThrow("at least two operators that do not pin");
  });

  test("local gateways only with the test-only switch", () => {
    const local: Gateway = { host: "http://127.0.0.1:1", operator: "L" };
    expect(() => checkGatewaySetup([A, B, local], ["L"], false)).toThrow(
      "gateway refused: http://127.0.0.1:1: not https",
    );
    expect(checkGatewaySetup([A, B, local], ["L"], true)).toHaveLength(3);
    expect(TEST_ONLY_SWITCH).toBe("--test-only-allow-local-gateways");
  });
});

describe("verifyOnGateways", () => {
  test("PASS: every object on two counted operators; the pinning operator's gateway fetched and reported, never counted", async () => {
    const seen: { url: string; accept?: string; timeout?: boolean }[] = [];
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((_u, path) => content(pub, path), seen),
      wait: noWait,
    });
    expect(proof).toMatchObject({
      verdict: "PASS",
      passes: true,
      fatal: [],
      pinned_by: ["Pinner"],
      gateway_list: "default",
      test_only_local_gateways: false,
      manifest_fetched: true,
    });
    expect(seen.map((s) => s.url)).toEqual([
      `https://gw-a.test/ipfs/${pub.manifestCid}`,
      `https://gw-b.test/ipfs/${pub.manifestCid}`,
      `https://gw-pin.test/ipfs/${pub.manifestCid}`,
      `https://gw-a.test/ipfs/${pub.coverageCid}`,
      `https://gw-b.test/ipfs/${pub.coverageCid}`,
      `https://gw-pin.test/ipfs/${pub.coverageCid}`,
      `https://gw-a.test/ipfs/${pub.objectCid}`,
      `https://gw-b.test/ipfs/${pub.objectCid}`,
      `https://gw-pin.test/ipfs/${pub.objectCid}`,
      `https://gw-a.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-a.test/ipfs/${pub.folderCid}/coverage.json`,
      `https://gw-b.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-b.test/ipfs/${pub.folderCid}/coverage.json`,
      `https://gw-pin.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-pin.test/ipfs/${pub.folderCid}/coverage.json`,
    ]);
    expect(seen.every((s) => s.timeout)).toBe(true);
    expect(seen.filter((s) => s.accept).map((s) => s.url)).toEqual([
      `https://gw-a.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-b.test/ipfs/${pub.folderCid}?format=car`,
      `https://gw-pin.test/ipfs/${pub.folderCid}?format=car`,
    ]);
    for (const o of proof.objects) {
      expect(o.operators_matched).toEqual(["Operator A", "Operator B"]);
      expect(o.pinning_operators_matched).toEqual(["Pinner"]);
      expect(o.gateways.map((g) => g.counted)).toEqual([true, true, false]);
    }
    expect(proof.objects.map((o) => [o.kind, o.name])).toEqual([
      ["manifest", "artifact-manifest.json"],
      ["file", "coverage.json"],
      ["file", "x.parquet"],
    ]);
    expect(proof.folder).toMatchObject({
      car_operators_matched: ["Operator A", "Operator B"],
      operators_matched: ["Operator A", "Operator B"],
      passes: true,
    });
    expect(proof.folder.gateways[0].by_path.rebuilt).toEqual({
      root: pub.folderCid,
      size: pub.folderCar.length,
      sha256: sha256Hex(pub.folderCar),
    });
    const text = proofText(proof);
    expect(text.split("\n")[0]).toBe(
      "PASS: gateway check of run r (pinned by Pinner, not counted)",
    );
    expect(text).toContain(
      "gw-pin.test: match (pinning operator: reported, not counted)",
    );
  });

  test("FAIL when only the pinning operator and one other match: the pinning gateway never makes the second", async () => {
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((_u, path, host) =>
        host === "gw-a.test" ? new Error("fetch failed") : content(pub, path),
      ),
      settings: { attempts: 2 },
      wait: noWait,
    });
    expect(proof.verdict).toBe("FAIL");
    expect(proof.passes).toBe(false);
    expect(proof.objects[0]).toMatchObject({
      operators_matched: ["Operator B"],
      pinning_operators_matched: ["Pinner"],
      passes: false,
    });
    expect(proof.folder.passes).toBe(false);
    // Every failure is in the proof: the attempts, their error and time.
    expect(proof.objects[0].gateways[0]).toMatchObject({
      host: "gw-a.test",
      ok: false,
      status: null,
      attempts: [
        { status: null, error: "fetch failed" },
        { status: null, error: "fetch failed" },
      ],
    });
  });

  test("two gateways of one operator count once", async () => {
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, B2, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((_u, path, host) =>
        host === "gw-a.test" ? 504 : content(pub, path),
      ),
      settings: { attempts: 1 },
      wait: noWait,
    });
    expect(proof.verdict).toBe("FAIL");
    expect(proof.objects[1].operators_matched).toEqual(["Operator B"]);
  });

  test("two gateways of one operator under two spellings count once, shown under the first one's label", async () => {
    const b2 = { host: "gw-b2.test", operator: " operator b" };
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, b2, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((_u, path, host) =>
        host === "gw-a.test" ? 504 : content(pub, path),
      ),
      settings: { attempts: 1 },
      wait: noWait,
    });
    expect(proof.verdict).toBe("FAIL");
    expect(proof.objects[1].operators_matched).toEqual(["Operator B"]);
    expect(proof.folder.operators_matched).toEqual(["Operator B"]);
    expect(proof.folder.car_operators_matched).toEqual(["Operator B"]);
    expect(proof.objects[1].gateways.map((g) => g.operator)).toEqual([
      "Operator A",
      "Operator B",
      " operator b",
      "Pinner",
    ]);
    const pinned = await verifyOnGateways({
      publication,
      gateways: [A, B, { host: "gw-pin2.test", operator: "PINNER" }, P],
      pinnedBy: ["pinner"],
      fetchImpl: correct(pub),
      settings: { attempts: 1 },
      wait: noWait,
    });
    expect(pinned.objects[1].pinning_operators_matched).toEqual(["PINNER"]);
    expect(pinned.verdict).toBe("PASS");
  });

  test("(a) is required: a folder CAR matching on only one counted operator fails the run; it is fetched again like any answer", async () => {
    const reordered = new Uint8Array(pub.folderCar).reverse();
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((u, path) =>
        u.startsWith("https://gw-a.test") && path.endsWith("?format=car")
          ? reordered
          : content(pub, path),
      ),
      wait: noWait,
    });
    expect(proof.objects.every((o) => o.passes)).toBe(true);
    expect(proof.folder.operators_matched).toEqual([
      "Operator A",
      "Operator B",
    ]);
    expect(proof.folder.car_operators_matched).toEqual(["Operator B"]);
    expect(proof.folder.gateways[0].car).toMatchObject({
      ok: false,
      size: pub.folderCar.length,
    });
    expect(proof.folder.gateways[0].car.attempts).toHaveLength(5);
    expect(proof.fatal).toEqual([]);
    expect(proof.verdict).toBe("FAIL");
  });

  test("(b) other bytes by path rebuild to another CAR: fatal, on any gateway, even the pinning operator's", async () => {
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((u, path) =>
        u === `https://gw-pin.test/ipfs/${pub.folderCid}/coverage.json`
          ? enc("{}\n")
          : content(pub, path),
      ),
      settings: { attempts: 2 },
      wait: noWait,
    });
    expect(proof.objects.every((o) => o.passes)).toBe(true);
    expect(proof.folder.car_operators_matched).toEqual([
      "Operator A",
      "Operator B",
    ]);
    expect(proof.folder.gateways[2].by_path).toMatchObject({
      ok: false,
      fatal: true,
    });
    expect(proof.fatal[0]).toMatch(
      /^gw-pin\.test: the folder's files by path rebuild to another CAR/,
    );
    expect(proof.verdict).toBe("FAIL");
    expect(proofText(proof)).toContain("MISMATCH (fatal)");
  });

  test("(b) a file not answered by path is not fatal: no CAR is rebuilt on that gateway", async () => {
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, C, P],
      pinnedBy: ["Pinner"],
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
    expect(proof.verdict).toBe("PASS");
  });

  test("a redirect to another host is recorded and not counted; to the gateway's own subdomain it counts", async () => {
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((u, path, host) => {
        const b = content(pub, path);
        if (!b) return null;
        if (host === "gw-a.test")
          return { bytes: b, from: `https://elsewhere.test/ipfs/${path}` };
        if (host === "gw-b.test")
          return {
            bytes: b,
            from: `https://${path.split(/[/?]/)[0]}.ipfs.gw-b.test/`,
          };
        return b;
      }),
      settings: { attempts: 1 },
      wait: noWait,
    });
    expect(proof.objects[0].gateways[0]).toMatchObject({
      ok: false,
      status: 200,
      final_url: `https://elsewhere.test/ipfs/${pub.manifestCid}`,
    });
    expect(proof.objects[0].gateways[1].ok).toBe(true);
    expect(proof.objects[0].operators_matched).toEqual(["Operator B"]);
    expect(proof.folder.gateways[0].by_path).toMatchObject({
      rebuilt: null,
      fatal: false,
    });
    expect(proof.verdict).toBe("FAIL");
    expect(proofText(proof)).toContain(
      `answered by https://elsewhere.test/ipfs/${pub.manifestCid}`,
    );
  });

  test("--skip-manifest-fetch: never PASS; INCOMPLETE when all else is met (exit 3), FAIL otherwise", async () => {
    const seen: { url: string }[] = [];
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((_u, path) => content(pub, path), seen),
      fetchManifest: false,
      wait: noWait,
    });
    expect(proof).toMatchObject({
      verdict: "INCOMPLETE",
      passes: false,
      manifest_fetched: false,
    });
    expect(EXIT_CODES.INCOMPLETE).toBe(3);
    expect(seen.some((s) => s.url.includes(pub.manifestCid))).toBe(false);
    expect(proof.objects.map((o) => o.kind)).toEqual(["file", "file"]);
    expect(verdictLine(proof)).toBe(
      "INCOMPLETE: gateway check of run r (pinned by Pinner, not counted; manifest not fetched (--skip-manifest-fetch))",
    );
    expect(proofText(proof)).toContain("this is not a pass");
    const failed = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
      fetchImpl: fakeFetch((_u, path, host) =>
        host === "gw-b.test" ? 404 : content(pub, path),
      ),
      fetchManifest: false,
      settings: { attempts: 1 },
      wait: noWait,
    });
    expect(failed.verdict).toBe("FAIL");
  });

  test("the verdict line states a replaced list and the test-only switch", async () => {
    const local: Gateway = { host: "http://127.0.0.1:9", operator: "Local" };
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, local],
      pinnedBy: ["Local"],
      fetchImpl: fakeFetch((_u, path) => content(pub, path)),
      listSource: "IPFS_GATEWAYS",
      testOnlyAllowLocalGateways: true,
      wait: noWait,
    }).catch((e: Error) => e);
    // The local gateway is reached through fakeFetch's https-only pattern, so it fails; the line is what matters.
    expect(proof).not.toBeInstanceOf(Error);
    const p = proof as Awaited<ReturnType<typeof verifyOnGateways>>;
    expect(p.gateway_list).toBe("IPFS_GATEWAYS");
    expect(p.test_only_local_gateways).toBe(true);
    expect(verdictLine(p)).toBe(
      `${p.verdict}: gateway check of run r (pinned by Local, not counted; default gateway list replaced by IPFS_GATEWAYS; TEST ONLY: local gateways allowed (--test-only-allow-local-gateways))`,
    );
  });

  test("a failure or mismatch is fetched again, up to 5 attempts by default, waiting 15, 30, 60 and 120 s", async () => {
    const waits: number[] = [];
    let calls = 0;
    const proof = await verifyOnGateways({
      publication,
      gateways: [A, B, P],
      pinnedBy: ["Pinner"],
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
      [true, 1, 200],
    ]);
    expect(x.operators_matched).toEqual(["Operator A"]);
    expect(proof.verdict).toBe("FAIL");
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

  test("refuses invalid settings and gateway setups before fetching", async () => {
    const f = correct(pub);
    await expect(
      verifyOnGateways({
        publication,
        gateways: [A, B, P],
        pinnedBy: ["Pinner"],
        fetchImpl: f,
        settings: { attempts: 0 },
      }),
    ).rejects.toThrow("attempts");
    await expect(
      verifyOnGateways({
        publication,
        gateways: [A, B, P],
        pinnedBy: ["Pinner"],
        fetchImpl: f,
        settings: { timeoutBytesPerS: 0 },
      }),
    ).rejects.toThrow("timeoutBytesPerS");
    await expect(
      verifyOnGateways({
        publication,
        gateways: [A, B],
        pinnedBy: [],
        fetchImpl: f,
      }),
    ).rejects.toThrow("--pinned-by");
  });
});

describe("the command, against fake gateways on 127.0.0.1 (test-only switch)", () => {
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
  type Failure = { code: number; stdout: string; stderr: string };
  const runFails = (args: string[], env?: NodeJS.ProcessEnv) =>
    run(process.execPath, ["src/gateway-verify.ts", ...args], {
      env: { ...process.env, IPFS_GATEWAYS: undefined, ...env },
    }).then(
      () => null,
      (e: Failure) => e,
    );

  test("PASS (exit 0) with the switch: proof files written, the switch and the replaced list in the verdict line and the proof", async () => {
    const one = await serve((p) => content(pub, p));
    const two = await serve((p) => content(pub, p));
    const pin = await serve((p) => content(pub, p));
    const proofDir = join(dir, "proof");
    const out = await run(
      process.execPath,
      [
        "src/gateway-verify.ts",
        join(dir, "pub"),
        proofDir,
        "--pinned-by",
        "Pin",
        "--gateway",
        `${one}=One`,
        "--gateway",
        `${two}=Two`,
        "--gateway",
        `${pin}=Pin`,
        "--attempts",
        "1",
        TEST_ONLY_SWITCH,
      ],
      { env: { ...process.env, IPFS_GATEWAYS: undefined } },
    );
    expect(out.stderr).toContain(
      `WARNING: ${TEST_ONLY_SWITCH} is for tests only`,
    );
    expect(out.stdout.split("\n")[0]).toBe(
      `PASS: gateway check of run r (pinned by Pin, not counted; default gateway list replaced by --gateway; TEST ONLY: local gateways allowed (${TEST_ONLY_SWITCH}))`,
    );
    const proof = JSON.parse(
      readFileSync(join(proofDir, "gateway-check-r.json"), "utf8"),
    );
    expect(proof).toMatchObject({
      verdict: "PASS",
      passes: true,
      run_id: "r",
      pinned_by: ["Pin"],
      gateway_list: "--gateway",
      test_only_local_gateways: true,
      gateways: [
        { host: one, operator: "One", counted: true },
        { host: two, operator: "Two", counted: true },
        { host: pin, operator: "Pin", counted: false },
      ],
      settings: { ...DEFAULT_SETTINGS, attempts: 1 },
    });
    expect(proof.started_at).toMatch(/Z$/);
    expect(
      readFileSync(join(proofDir, "gateway-check-r.txt"), "utf8"),
    ).toContain("MET folder publish");
  });

  test("without the switch local gateways are refused (exit 2); IPFS_GATEWAYS with the manifest skipped gives INCOMPLETE (exit 3)", async () => {
    const one = await serve((p) => content(pub, p));
    const two = await serve((p) => content(pub, p));
    const pin = await serve((p) => content(pub, p));
    const list = `${one}=One,${two}=Two,${pin}=Pin`;
    const refused = await runFails(
      [join(dir, "pub"), join(dir, "proof"), "--pinned-by", "Pin"],
      { IPFS_GATEWAYS: list },
    );
    expect(refused?.code).toBe(2);
    expect(refused?.stderr).toContain(`gateway refused: ${one}: not https`);
    const incomplete = await runFails(
      [
        join(dir, "pub"),
        join(dir, "proof"),
        "--pinned-by",
        "Pin",
        "--attempts",
        "1",
        "--skip-manifest-fetch",
        TEST_ONLY_SWITCH,
      ],
      { IPFS_GATEWAYS: list },
    );
    expect(incomplete?.code).toBe(3);
    expect(incomplete?.stdout.split("\n")[0]).toBe(
      `INCOMPLETE: gateway check of run r (pinned by Pin, not counted; manifest not fetched (--skip-manifest-fetch); default gateway list replaced by IPFS_GATEWAYS; TEST ONLY: local gateways allowed (${TEST_ONLY_SWITCH}))`,
    );
  });

  test("a failing run exits 1; no --pinned-by, a gateway without its operator, or no arguments exit 2", async () => {
    const one = await serve((p) => content(pub, p));
    const empty = await serve(() => null);
    const pin = await serve((p) => content(pub, p));
    const failed = await runFails([
      join(dir, "pub"),
      join(dir, "proof"),
      "--pinned-by",
      "Pin",
      "--gateway",
      `${one}=One`,
      "--gateway",
      `${empty}=Empty`,
      "--gateway",
      `${pin}=Pin`,
      "--attempts",
      "1",
      TEST_ONLY_SWITCH,
    ]);
    expect(failed?.code).toBe(1);
    expect(failed?.stdout.split("\n")[0]).toMatch(/^FAIL: /);
    expect(failed?.stdout).toContain(`${empty}: NO MATCH: status 404`);
    const noPin = await runFails([join(dir, "pub"), join(dir, "proof")]);
    expect(noPin?.code).toBe(2);
    expect(noPin?.stderr).toContain("--pinned-by <Operator> is required");
    const noOperator = await runFails([
      join(dir, "pub"),
      join(dir, "proof"),
      "--pinned-by",
      "Filebase",
      "--gateway",
      "ipfs.aleph.cloud",
    ]);
    expect(noOperator?.code).toBe(2);
    expect(noOperator?.stderr).toContain("has no declared operator");
    const usage = await runFails([]);
    expect(usage?.code).toBe(2);
    expect(usage?.stderr).toContain(
      "usage: node src/gateway-verify.ts <publication dir> <proof dir> --pinned-by <Operator>",
    );
  });
});
