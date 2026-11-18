/**
 * runs/publications.jsonl: the line format (src/publications.ts) and the append-only record tool
 * (scripts/record-publication.ts), on temporary copies; the tracked file is only read.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  publicationRecordPath,
  publicationRecordProblem,
} from "../src/publications.ts";
import {
  recordPublication,
  verifyAppend,
} from "../scripts/record-publication.ts";

let FOLDER = ""; // a dag-pb UnixFS directory CID, as a publish folder has
let MANIFEST = ""; // a raw-leaf file CID, as a small artifact-manifest.json has
beforeAll(async () => {
  FOLDER = await directoryCid([
    { name: "coverage.json", bytes: new TextEncoder().encode("{}") },
  ]);
  MANIFEST = await bytesCid(new TextEncoder().encode('{"artifacts":[]}'));
});

const RUN_A = "2026-11-14T10-00-00-000Z-bc7f18f2e9cf2";
const RUN_B = "2026-11-17T00-55-12-521Z-b99e177df66a0";

let dir = "";
let paths = { publications: "", history: "", runs: "" };
/** runs/<run_id>/publication/directory.json with the fields the record tool checks (as the build writes them). */
function writeRecord(runId: string, record: unknown) {
  const p = join(paths.runs, publicationRecordPath(runId));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(
    p,
    typeof record === "string" ? record : JSON.stringify(record, null, 2),
  );
}
const record = (run_id: string) => ({
  run_id,
  directory_cid: FOLDER,
  files: [],
  car: { file: "directory.car", size: 1, sha256: "0".repeat(64) },
  artifact_manifest: { cid: MANIFEST, name: "artifact-manifest.json" },
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publications-"));
  paths = {
    publications: join(dir, "publications.jsonl"),
    history: join(dir, "run_history.jsonl"),
    runs: join(dir, "runs"),
  };
  writeRecord(RUN_A, record(RUN_A));
  writeRecord(RUN_B, record(RUN_B));
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
    expect(MANIFEST).toMatch(/^bafk/);
    expect(isCidV1Base32(FOLDER)).toBe(true);
    expect(isCidV1Base32(MANIFEST)).toBe(true);
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
      manifest_cid: MANIFEST,
      folder_cid: FOLDER,
      published_at: "2026-11-18",
    };
    const line = publicationLine(p);
    expect(line).toBe(
      `{"run_id":"${RUN_A}","manifest_cid":"${MANIFEST}","folder_cid":"${FOLDER}","published_at":"2026-11-18"}\n`,
    );
    expect(parsePublications("")).toEqual([]);
    expect(parsePublications(line)).toEqual([p]);
    expect(gatewayUrl(MANIFEST)).toBe(`https://ipfs.io/ipfs/${MANIFEST}`);
    const reordered = JSON.stringify({
      folder_cid: FOLDER,
      run_id: RUN_A,
      manifest_cid: MANIFEST,
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
      [line.replace(MANIFEST, FOLDER.toUpperCase()), "manifest_cid"],
      [line.replace("2026-11-18", "2026-11-31"), "published_at"],
      [line.replace(`"run_id"`, ` "run_id"`), "written form"],
      [line + line, "line 2: run"],
      // The earlier layout (folder and CAR identifiers) is refused.
      [
        `${JSON.stringify({ run_id: RUN_A, folder_cid: FOLDER, car_cid: MANIFEST, published_at: "2026-11-18" })}\n`,
        "keys must be exactly run_id, manifest_cid, folder_cid, published_at",
      ],
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
        manifest_cid: MANIFEST,
        folder_cid: FOLDER,
        published_at: "2026-11-18",
      },
      paths,
    );
    const afterFirst = readFileSync(paths.publications, "utf8");
    expect(afterFirst).toBe(first);
    const second = recordPublication(
      { run_id: RUN_B, manifest_cid: MANIFEST, folder_cid: FOLDER },
      paths,
      () => new Date("2026-11-19T08:00:00.000Z"),
    );
    expect(second).toBe(
      `{"run_id":"${RUN_B}","manifest_cid":"${MANIFEST}","folder_cid":"${FOLDER}","published_at":"2026-11-19T08:00:00.000Z"}\n`,
    );
    expect(readFileSync(paths.publications, "utf8")).toBe(afterFirst + second);
    expect(
      parsePublications(readFileSync(paths.publications, "utf8")).map(
        (p) => p.run_id,
      ),
    ).toEqual([RUN_A, RUN_B]);
  });

  test("refuses, writing nothing: a run not in the history, a run already recorded, an invalid CID or date, a malformed file", () => {
    const ok = { run_id: RUN_A, manifest_cid: MANIFEST, folder_cid: FOLDER };
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
      [
        { ...ok, run_id: RUN_B, manifest_cid: MANIFEST.slice(0, -2) },
        "manifest_cid",
      ],
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

  test("refuses, writing nothing, identifiers that are not the run's runs/<run_id>/publication/directory.json, or no such file", () => {
    const ok = { run_id: RUN_A, manifest_cid: MANIFEST, folder_cid: FOLDER };
    const empty = readFileSync(paths.publications);
    for (const [input, message] of [
      [
        { ...ok, manifest_cid: FOLDER, folder_cid: MANIFEST },
        `manifest_cid ${FOLDER} is not directory.json's artifact_manifest.cid ${MANIFEST}`,
      ],
      [
        { ...ok, folder_cid: MANIFEST },
        `folder_cid ${MANIFEST} is not directory.json's directory_cid ${FOLDER}`,
      ],
    ] as const) {
      expect(() => recordPublication(input, paths), message).toThrow(message);
      expect(readFileSync(paths.publications).equals(empty)).toBe(true);
    }
    for (const [content, message] of [
      [record(RUN_B), `directory.json's run_id is "${RUN_B}", not ${RUN_A}`],
      [
        { ...record(RUN_A), artifact_manifest: undefined },
        "no artifact_manifest.cid",
      ],
      [{ ...record(RUN_A), directory_cid: undefined }, "no directory_cid"],
      ["[]", "not a JSON object"],
      ["{", "not JSON"],
    ] as const) {
      writeRecord(RUN_A, content);
      expect(() => recordPublication(ok, paths), message).toThrow(message);
      expect(readFileSync(paths.publications).equals(empty)).toBe(true);
    }
    rmSync(join(paths.runs, RUN_A), { recursive: true });
    expect(() => recordPublication(ok, paths)).toThrow(
      `${join(paths.runs, RUN_A, "publication", "directory.json")} does not exist`,
    );
    expect(readFileSync(paths.publications).equals(empty)).toBe(true);
    writeRecord(RUN_A, record(RUN_A));
    expect(recordPublication(ok, paths)).toContain(`"run_id":"${RUN_A}"`);
  });

  test("publicationRecordProblem names the fields as directory.json has them", () => {
    const p = { run_id: RUN_A, manifest_cid: MANIFEST, folder_cid: FOLDER };
    expect(publicationRecordPath(RUN_A)).toBe(
      `${RUN_A}/publication/directory.json`,
    );
    expect(publicationRecordProblem(p, record(RUN_A))).toBeNull();
    expect(publicationRecordProblem(p, null)).toBe(
      "directory.json is not a JSON object",
    );
    expect(
      publicationRecordProblem({ ...p, manifest_cid: FOLDER }, record(RUN_A)),
    ).toContain("artifact_manifest.cid");
    expect(
      publicationRecordProblem({ ...p, folder_cid: MANIFEST }, record(RUN_A)),
    ).toContain("directory_cid");
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
      "usage: node scripts/record-publication.ts <run_id> <manifest_cid> <folder_cid> [published_at]",
    );
    expect(r.stdout).toBe("");
  });
});
