import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, describe, expect, test } from "vitest";
import { openDb } from "../src/db.ts";
import { FIXTURE, writeFixture } from "./fixture.ts";

/** Always runs: S3 copy, sha256 check and DuckDB lockdown over the synthetic fixture run. */
describe("openDb from S3", () => {
  let dir: string;
  let parquetSha256: string;
  beforeAll(async () => ({ dir, parquetSha256 } = await writeFixture()));
  const body = (name: string) =>
    ({
      Body: {
        transformToByteArray: async () =>
          new Uint8Array(readFileSync(join(dir, name))),
      },
    }) as never;

  test("copies the three run files from S3 to /tmp, verifies the sha256 and locks DuckDB down", async () => {
    const s3 = mockClient(S3Client);
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) =>
      body(input.Key.split("/").pop()!),
    );
    const db = await openDb(
      {
        runId: FIXTURE.runId,
        parquetSha256,
        bucket: "b",
        prefix: `runs/${FIXTURE.runId}/`,
        tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
      },
      new S3Client({}),
    );
    expect(
      s3
        .commandCalls(GetObjectCommand)
        .map((c) => c.args[0].input.Key)
        .sort(),
    ).toEqual([
      `runs/${FIXTURE.runId}/los-angeles_property_roll2026_slice.parquet`,
      `runs/${FIXTURE.runId}/run_history.jsonl`,
      `runs/${FIXTURE.runId}/run_manifest.json`,
    ]);
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
          bucket: "b",
          prefix: "p/",
          tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
        },
        new S3Client({}),
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    s3.restore();
  });
});
