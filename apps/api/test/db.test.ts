import { createReadStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, describe, expect, test } from "vitest";
import { openDb } from "../src/db.ts";
import { FIXTURE, writeFixture } from "./fixture.ts";

/** Always runs: S3 copy (streamed), sha256 check and DuckDB lockdown over the synthetic fixture run. */
describe("openDb from S3", () => {
  let dir: string;
  let parquetSha256: string;
  beforeAll(async () => ({ dir, parquetSha256 } = await writeFixture()));
  // The body is a stream, as the SDK returns in Node. Buffering it whole would call transformToByteArray.
  const body = (name: string) =>
    ({
      Body: Object.assign(createReadStream(join(dir, name)), {
        transformToByteArray: () => {
          throw new Error("the cold start must stream, not buffer");
        },
      }),
    }) as never;

  test("streams the three run files from S3 to /tmp, verifies the sha256 and locks DuckDB down", async () => {
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
    ).toEqual([
      `runs/${FIXTURE.runId}/${FIXTURE.parquetFile}`,
      `runs/${FIXTURE.runId}/run_history.jsonl`,
      `runs/${FIXTURE.runId}/run_manifest.json`,
    ]);
    // The copies are byte-identical to the objects.
    for (const f of [FIXTURE.parquetFile, "run_manifest.json"])
      expect(
        readFileSync(join(tmpDir, "oracle-data", FIXTURE.runId, f)).equals(
          readFileSync(join(dir, f)),
        ),
      ).toBe(true);
    expect(db.parquetSha256).toBe(parquetSha256);
    expect(db.rollYear).toBe(2026);
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
          bucket: "b",
          prefix: "p/",
          tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
        },
        new S3Client({}),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
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
            bucket: "b",
            prefix: "p/",
            tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
          },
          new S3Client({}),
        ),
      ).rejects.toThrow(/bad Parquet file name/);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    s3.restore();
  });
});
