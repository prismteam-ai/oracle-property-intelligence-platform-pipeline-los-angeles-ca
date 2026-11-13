import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  bytesCid,
  digestFile,
  directoryCar,
  directoryCid,
  sha256Hex,
} from "../src/ipfs-unixfs.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const pattern = (n: number) => new Uint8Array(n).map((_, i) => i & 255);

/*
 * Independent encoders written from the specs, used to check ipfs-car's output without ipfs-car:
 * CIDv1 = 0x01, codec varint, multihash (0x12 sha2-256, 32 bytes); multibase "b" = RFC 4648 base32,
 * lower case, no padding (multibase spec). dag-pb (https://ipld.io/specs/codecs/dag-pb/spec/): links
 * first (field 2), then Data (field 1); a link is Hash (1), Name (2), Tsize (3). UnixFS Data
 * (https://specs.ipfs.tech/unixfs/): Type (1) = 2 for File, filesize (3), blocksizes (4, repeated).
 */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(u: Uint8Array): string {
  let o = "",
    bits = 0,
    v = 0;
  for (const x of u) {
    v = ((v << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      o += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) o += B32[(v << (5 - bits)) & 31];
  return o;
}
function varint(n: number): number[] {
  const o: number[] = [];
  while (n >= 0x80) {
    o.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  o.push(n);
  return o;
}
const cat = (...parts: (Uint8Array | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => Array.from(p)));
const lenField = (num: number, payload: Uint8Array) =>
  cat(varint((num << 3) | 2), varint(payload.length), payload);
const intField = (num: number, n: number) => cat(varint(num << 3), varint(n));
const cidBytes = (codec: number, block: Uint8Array) =>
  cat(
    [1],
    varint(codec),
    [0x12, 32],
    createHash("sha256").update(block).digest(),
  );
const cidString = (codec: number, block: Uint8Array) =>
  "b" + base32(cidBytes(codec, block));
const RAW = 0x55,
  DAG_PB = 0x70;

/** Root of a file split into the given chunks, raw leaves, one level (dag-pb + UnixFS File). */
function twoLevelFileRoot(chunks: Uint8Array[]): string {
  const links = chunks.map((c) =>
    lenField(
      2,
      cat(
        lenField(1, cidBytes(RAW, c)),
        lenField(2, new Uint8Array()),
        intField(3, c.length),
      ),
    ),
  );
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const data = cat(
    intField(1, 2),
    intField(3, total),
    ...chunks.map((c) => intField(4, c.length)),
  );
  return cidString(DAG_PB, cat(...links, lenField(1, data)));
}

describe("known-answer CIDs", () => {
  // Each test title names the public source of its expected value.
  test("empty file = the UnixFS spec's empty raw block (specs.ipfs.tech/unixfs, 'Well-Known UnixFS CIDs')", async () => {
    expect(await bytesCid(new Uint8Array())).toBe(
      "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
  });
  test('"hello world" = IPIP-0499 unixfs-v1-2025 small-file vector (specs.ipfs.tech/ipips/ipip-0499, test vectors for unixfs-v1-2025)', async () => {
    expect(await bytesCid(enc("hello world"))).toBe(
      "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e",
    );
  });
  test("empty directory = UnixFS spec 'Well-Known UnixFS CIDs' and IPIP-0499 additional vectors", async () => {
    expect(await directoryCid([])).toBe(
      "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354",
    );
  });
  test("bytes [21, 31] = ipfs-car 3.1.0 test/index.test.js 'can pack file'", async () => {
    expect(await bytesCid(new Uint8Array([21, 31]))).toBe(
      "bafkreifidl2jnal7ycittjrnbki6jasdxwwvpf7fj733vnyhidtusxby4y",
    );
  });
  test("flat directory cat0.gif/cat1.gif = ipfs-car 3.1.0 test/index.test.js 'can pack directory' (its 'memes' block)", async () => {
    expect(
      await directoryCid([
        { name: "cat1.gif", bytes: new Uint8Array([41, 51]) },
        { name: "cat0.gif", bytes: new Uint8Array([21, 31]) },
      ]),
    ).toBe("bafybeidwuiczcdtqsyqln5fgifl3fbblpclb573ltn4id5w5woffucor5a");
  });
  test("1 MiB + 1 byte: two raw leaves at the 1,048,576-byte boundary, derived from the dag-pb and UnixFS specs", async () => {
    const big = pattern(1048577);
    const derived = twoLevelFileRoot([
      big.subarray(0, 1048576),
      big.subarray(1048576),
    ]);
    expect(derived).toBe(
      "bafybeidilpoket5zygjfcrvh76gvmez7iwgzmf55stwnofqxvprkyjlf7y",
    );
    expect(await bytesCid(big)).toBe(derived);
  });
  test("files up to 1 MiB are one raw block: CID = raw CID of the bytes, computed independently", async () => {
    for (const n of [1, 1000, 262144, 1048576]) {
      const b = pattern(n);
      expect(await bytesCid(b)).toBe(cidString(RAW, b));
    }
  });
});

describe("files on disk and determinism", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ipfs-unixfs-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("digestFile streams a file: size, sha256 and the same CID as the bytes", async () => {
    const b = pattern(2 * 1048576 + 7);
    writeFileSync(join(dir, "f.bin"), b);
    expect(await digestFile(join(dir, "f.bin"))).toEqual({
      size: b.length,
      sha256: sha256Hex(b),
      cid: await bytesCid(b),
    });
  });

  test("same input gives the same directory CID and the same CAR bytes, whatever the entry order", async () => {
    const files = [
      { name: "b.json", bytes: enc('{"b":1}\n') },
      { name: "a.json", bytes: enc('{"a":1}\n') },
      { name: "c.bin", bytes: pattern(1048576 + 10) },
    ];
    const one = await directoryCar(files);
    const two = await directoryCar([...files].reverse());
    expect(two.root).toBe(one.root);
    expect(two.car_sha256).toBe(one.car_sha256);
    expect(Buffer.from(two.car).equals(Buffer.from(one.car))).toBe(true);
    expect(await directoryCid(files)).toBe(one.root);
    const changed = await directoryCar([
      { ...files[0], bytes: enc('{"b":2}\n') },
      files[1],
      files[2],
    ]);
    expect(changed.root).not.toBe(one.root);
  });

  test("rejects nested, empty and duplicate entry names", async () => {
    await expect(
      directoryCid([{ name: "a/b.json", bytes: enc("{}") }]),
    ).rejects.toThrow(/plain file name/);
    await expect(
      directoryCid([{ name: "", bytes: enc("{}") }]),
    ).rejects.toThrow(/plain file name/);
    await expect(
      directoryCid([
        { name: "a.json", bytes: enc("1") },
        { name: "a.json", bytes: enc("2") },
      ]),
    ).rejects.toThrow(/duplicate/);
  });

  test("CAR round trip: ipfs-car's own unpacker (ipfs-unixfs-exporter, block hashes checked) gives back identical bytes", async () => {
    const files = [
      { name: "run_manifest.json", bytes: enc('{"run_id":"x"}\n') },
      { name: "coverage.json", bytes: enc('{"counts":1}\n') },
      { name: "big.bin", bytes: pattern(1048576 * 2 + 3) },
      { name: "empty.json", bytes: new Uint8Array() },
    ];
    const { root, car } = await directoryCar(files);
    writeFileSync(join(dir, "d.car"), car);
    const bin = fileURLToPath(import.meta.resolve("ipfs-car/bin.js"));
    const roots = execFileSync(
      process.execPath,
      [bin, "roots", join(dir, "d.car")],
      { encoding: "utf8" },
    );
    expect(roots.trim()).toBe(root);
    execFileSync(process.execPath, [
      bin,
      "unpack",
      join(dir, "d.car"),
      "--output",
      join(dir, "out"),
    ]);
    expect(readdirSync(join(dir, "out")).sort()).toEqual(
      files.map((f) => f.name).sort(),
    );
    for (const f of files)
      expect(
        sha256Hex(new Uint8Array(readFileSync(join(dir, "out", f.name)))),
      ).toBe(sha256Hex(f.bytes));
  });
});
