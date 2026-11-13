import { createReadStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, describe, expect, test } from "vitest";
import { openDb, parsePermitFiles, type PermitFile } from "../src/db.ts";
import { FIXTURE, PERMIT_FILE_NAMES, writeFixture } from "./fixture.ts";

/** Always runs: S3 copy (streamed), sha256 check and DuckDB lockdown over the synthetic fixture run. */
describe("openDb from S3", () => {
  let dir: string;
  let parquetSha256: string;
  let permitFiles: PermitFile[];
  beforeAll(
    async () => ({ dir, parquetSha256, permitFiles } = await writeFixture()),
  );
  // The body is a stream, as the SDK returns in Node. Buffering it whole would call transformToByteArray.
  const body = (name: string) =>
    ({
      Body: Object.assign(createReadStream(join(dir, name)), {
        transformToByteArray: () => {
          throw new Error("the cold start must stream, not buffer");
        },
      }),
    }) as never;

  test("streams the six run files from S3 to /tmp, verifies the sha256 and locks DuckDB down", async () => {
    const s3 = mockClient(S3Client);
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) =>
      body(input.Key.split("/").pop()!),
    );
    const tmpDir = mkdtempSync(join(tmpdir(), "api-tmp-"));
    const db = await openDb(
      {
        runId: FIXTURE.runId,
        parquetSha256,
        parquetFile: FIXTURE.parquetFile,
        permitFiles,
        bucket: "b",
        prefix: `runs/${FIXTURE.runId}/`,
        tmpDir,
      },
      new S3Client({}),
    );
    expect(
      s3
        .commandCalls(GetObjectCommand)
        .map((c) => c.args[0].input.Key)
        .sort(),
    ).toEqual(
      [
        FIXTURE.parquetFile,
        ...Object.values(PERMIT_FILE_NAMES),
        "run_history.jsonl",
        "run_manifest.json",
      ]
        .map((f) => `runs/${FIXTURE.runId}/${f}`)
        .sort(),
    );
    // The copies are byte-identical to the objects.
    for (const f of [
      FIXTURE.parquetFile,
      ...Object.values(PERMIT_FILE_NAMES),
      "run_manifest.json",
    ])
      expect(
        readFileSync(join(tmpDir, "oracle-data", FIXTURE.runId, f)).equals(
          readFileSync(join(dir, f)),
        ),
      ).toBe(true);
    expect(db.parquetSha256).toBe(parquetSha256);
    expect(db.permitFiles).toEqual(
      permitFiles.map((f) => ({ role: f.role, sha256: f.sha256 })),
    );
    expect(db.rollYear).toBe(2026);
    expect(db.referenceDate).toBe("2026-11-11");
    // Every run file is readable; nothing else is.
    expect(
      (await db.rows("select count(*)::integer n from oracle.v_permit"))[0],
    ).toEqual({ n: 0 });
    await expect(
      db.rows("select * from read_csv('/etc/passwd')"),
    ).rejects.toThrow(/disabled by configuration|Permission/);
    await expect(
      db.rows("set enable_external_access = true"),
    ).rejects.toThrow();
    s3.restore();
  });

  test("fails closed when the Parquet digest does not match", async () => {
    const s3 = mockClient(S3Client);
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) =>
      body(input.Key.split("/").pop()!),
    );
    await expect(
      openDb(
        {
          runId: FIXTURE.runId,
          parquetSha256: "0".repeat(64),
          parquetFile: FIXTURE.parquetFile,
          permitFiles,
          bucket: "b",
          prefix: "p/",
          tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
        },
        new S3Client({}),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    // A permit file's digest is checked the same way.
    for (const role of ["permits", "permit_parcels", "permit_contractors"])
      await expect(
        openDb(
          {
            runId: FIXTURE.runId,
            parquetSha256,
            parquetFile: FIXTURE.parquetFile,
            permitFiles: permitFiles.map((f) =>
              f.role === role ? { ...f, sha256: "1".repeat(64) } : f,
            ),
            bucket: "b",
            prefix: "p/",
            tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
          },
          new S3Client({}),
        ),
      ).rejects.toThrow(new RegExp(`${role} parquet sha256 mismatch`));
    s3.restore();
  });

  test("refuses a Parquet file name with a directory part before any S3 call", async () => {
    const s3 = mockClient(S3Client);
    for (const parquetFile of ["../x.parquet", "a/b.parquet", "x.csv", ""])
      await expect(
        openDb(
          {
            runId: FIXTURE.runId,
            parquetSha256,
            parquetFile,
            permitFiles,
            bucket: "b",
            prefix: "p/",
            tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
          },
          new S3Client({}),
        ),
      ).rejects.toThrow(/bad Parquet file name/);
    for (const bad of [
      permitFiles.map((f) =>
        f.role === "permits" ? { ...f, file: "../x.parquet" } : f,
      ),
      permitFiles.slice(1),
      [...permitFiles.slice(1), permitFiles[1]!],
    ])
      await expect(
        openDb(
          {
            runId: FIXTURE.runId,
            parquetSha256,
            parquetFile: FIXTURE.parquetFile,
            permitFiles: bad,
            bucket: "b",
            prefix: "p/",
            tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
          },
          new S3Client({}),
        ),
      ).rejects.toThrow(/bad Parquet file name|bad permit files/);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    s3.restore();
  });
});

describe("parsePermitFiles (the PERMIT_FILES environment variable)", () => {
  const ok = [
    { role: "permits", file: "a.parquet", sha256: "a".repeat(64) },
    { role: "permit_parcels", file: "b.parquet", sha256: "b".repeat(64) },
    { role: "permit_contractors", file: "c.parquet", sha256: "c".repeat(64) },
  ];
  test("accepts one {role, file, sha256} per role", () => {
    expect(parsePermitFiles(JSON.stringify(ok))).toEqual(ok);
  });
  test("refuses anything else", () => {
    for (const bad of [
      "",
      "{}",
      JSON.stringify(ok.slice(1)),
      JSON.stringify([...ok, ok[0]]),
      JSON.stringify([{ ...ok[0], file: "../a.parquet" }, ...ok.slice(1)]),
      JSON.stringify([{ ...ok[0], sha256: "A".repeat(64) }, ...ok.slice(1)]),
      JSON.stringify([{ ...ok[0], role: "seed" }, ...ok.slice(1)]),
      JSON.stringify([{ ...ok[0], extra: 1 }, ...ok.slice(1)]),
      JSON.stringify([null, ...ok.slice(1)]),
    ])
      expect(() => parsePermitFiles(bad), bad).toThrow(/bad permit files/);
  });
});
