/**
 * runs/publications.jsonl: the line format (src/publications.ts) and the append-only record tool
 * (scripts/record-publication.ts), on temporary copies; the tracked file is only read.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { bytesCid, directoryCid } from "../src/ipfs-unixfs.ts";
import {
  gatewayUrl,
  isCidV1Base32,
  isUtcDateOrTime,
  parsePublications,
  publicationLine,
} from "../src/publications.ts";
import {
  recordPublication,
  verifyAppend,
} from "../scripts/record-publication.ts";

let FOLDER = ""; // a dag-pb UnixFS directory CID, as a publish folder has
let CAR = ""; // a raw-leaf file CID, as a small CAR file's bytes have
beforeAll(async () => {
  FOLDER = await directoryCid([
    { name: "coverage.json", bytes: new TextEncoder().encode("{}") },
  ]);
  CAR = await bytesCid(new TextEncoder().encode("car bytes"));
});

const RUN_A = "2026-11-14T10-00-00-000Z-bc7f18f2e9cf2";
const RUN_B = "2026-11-17T00-55-12-521Z-b99e177df66a0";

let dir = "";
let paths = { publications: "", history: "" };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publications-"));
  paths = {
    publications: join(dir, "publications.jsonl"),
    history: join(dir, "run_history.jsonl"),
  };
  writeFileSync(paths.publications, "");
  writeFileSync(
    paths.history,
    [RUN_A, RUN_B].map((run_id) => JSON.stringify({ run_id })).join("\n") +
      "\n",
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("publication lines", () => {
  test("CIDv1 base32 with a sha2-256 multihash only", () => {
    expect(FOLDER).toMatch(/^bafy/);
    expect(CAR).toMatch(/^bafk/);
    expect(isCidV1Base32(FOLDER)).toBe(true);
    expect(isCidV1Base32(CAR)).toBe(true);
    for (const bad of [
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", // CIDv0 (base58)
      FOLDER.toUpperCase(), // base32 upper (multibase "B")
      `z${FOLDER.slice(1)}`, // another multibase prefix
      FOLDER.slice(0, -1), // truncated digest
      `${FOLDER}a`, // trailing byte
      "bafy!",
      "b",
      "",
    ])
      expect(isCidV1Base32(bad), bad).toBe(false);
  });

  test("published_at: a real UTC date or time, nothing else", () => {
    for (const ok of [
      "2026-11-18",
      "2026-11-18T09:30:00Z",
      "2026-11-18T09:30:00.123Z",
    ])
      expect(isUtcDateOrTime(ok), ok).toBe(true);
    for (const bad of [
      "2026-02-30",
      "2026-11-18T25:00:00Z",
      "2026-11-18T09:30:00+01:00",
      "2026-11-18T09:30:00",
      "18 Nov 2026",
      "",
    ])
      expect(isUtcDateOrTime(bad), bad).toBe(false);
  });

  test("the line has the fixed key order; parsing refuses anything malformed", () => {
    const p = {
      run_id: RUN_A,
      folder_cid: FOLDER,
      car_cid: CAR,
      published_at: "2026-11-18",
    };
    const line = publicationLine(p);
    expect(line).toBe(
      `{"run_id":"${RUN_A}","folder_cid":"${FOLDER}","car_cid":"${CAR}","published_at":"2026-11-18"}\n`,
    );
    expect(parsePublications("")).toEqual([]);
    expect(parsePublications(line)).toEqual([p]);
    expect(gatewayUrl(FOLDER)).toBe(`https://ipfs.io/ipfs/${FOLDER}/`);
    const reordered = JSON.stringify({
      folder_cid: FOLDER,
      run_id: RUN_A,
      car_cid: CAR,
      published_at: "2026-11-18",
    });
    for (const [text, message] of [
      [line.trimEnd(), "no newline"],
      [`${line}\n`, "line 2: not JSON"],
      ["not json\n", "line 1: not JSON"],
      ["[]\n", "not a JSON object"],
      [`${reordered}\n`, "keys must be exactly"],
      [`${line.slice(0, -2)},"x":"y"}\n`, "keys must be exactly"],
      [line.replace(FOLDER, "bafyx"), "folder_cid"],
      [line.replace(CAR, FOLDER.toUpperCase()), "car_cid"],
      [line.replace("2026-11-18", "2026-11-31"), "published_at"],
      [line.replace(`"run_id"`, ` "run_id"`), "written form"],
      [line + line, "line 2: run"],
    ] as const)
      expect(() => parsePublications(text), message).toThrow(message);
  });

  test("the tracked runs/publications.jsonl parses", () => {
    expect(() =>
      parsePublications(readFileSync("runs/publications.jsonl", "utf8")),
    ).not.toThrow();
  });
});

describe("scripts/record-publication.ts", () => {
  test("appends one line per run, the earlier bytes unchanged; published_at defaults to now", () => {
    const first = recordPublication(
      {
        run_id: RUN_A,
        folder_cid: FOLDER,
        car_cid: CAR,
        published_at: "2026-11-18",
      },
      paths,
    );
    const afterFirst = readFileSync(paths.publications, "utf8");
    expect(afterFirst).toBe(first);
    const second = recordPublication(
      { run_id: RUN_B, folder_cid: FOLDER, car_cid: CAR },
      paths,
      () => new Date("2026-11-19T08:00:00.000Z"),
    );
    expect(second).toBe(
      `{"run_id":"${RUN_B}","folder_cid":"${FOLDER}","car_cid":"${CAR}","published_at":"2026-11-19T08:00:00.000Z"}\n`,
    );
    expect(readFileSync(paths.publications, "utf8")).toBe(afterFirst + second);
    expect(
      parsePublications(readFileSync(paths.publications, "utf8")).map(
        (p) => p.run_id,
      ),
    ).toEqual([RUN_A, RUN_B]);
  });

  test("refuses, writing nothing: a run not in the history, a run already recorded, an invalid CID or date, a malformed file", () => {
    const ok = { run_id: RUN_A, folder_cid: FOLDER, car_cid: CAR };
    recordPublication(ok, paths);
    const bytes = readFileSync(paths.publications);
    for (const [input, message] of [
      [{ ...ok, run_id: "2026-01-01T00-00-00-000Z" }, "is not in"],
      [ok, "already recorded"],
      [
        {
          ...ok,
          run_id: RUN_B,
          folder_cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        },
        "folder_cid",
      ],
      [{ ...ok, run_id: RUN_B, car_cid: CAR.slice(0, -2) }, "car_cid"],
      [{ ...ok, run_id: RUN_B, published_at: "yesterday" }, "published_at"],
    ] as const) {
      expect(() => recordPublication(input, paths), message).toThrow(message);
      expect(readFileSync(paths.publications).equals(bytes)).toBe(true);
    }
    writeFileSync(paths.publications, "{}\n");
    expect(() => recordPublication({ ...ok, run_id: RUN_B }, paths)).toThrow(
      "line 1",
    );
    expect(readFileSync(paths.publications, "utf8")).toBe("{}\n");
    rmSync(paths.publications);
    expect(() => recordPublication(ok, paths)).toThrow("does not exist");
  });

  test("the append-only check fails when earlier bytes changed or more than the line was added", () => {
    writeFileSync(paths.publications, "abc\nx\n");
    expect(() =>
      verifyAppend(paths.publications, Buffer.from("abd\n"), "x\n"),
    ).toThrow("append-only check failed");
    expect(() =>
      verifyAppend(paths.publications, Buffer.from("abc\n"), "y\n"),
    ).toThrow("append-only check failed");
    expect(() =>
      verifyAppend(paths.publications, Buffer.from("abc\n"), "x\n"),
    ).not.toThrow();
  });

  test("the command line without its arguments prints the usage and writes nothing", () => {
    const r = spawnSync(process.execPath, ["scripts/record-publication.ts"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      "usage: node scripts/record-publication.ts <run_id> <folder_cid> <car_cid> [published_at]",
    );
    expect(r.stdout).toBe("");
  });
});
