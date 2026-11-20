import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { seedFileEntries } from "../src/manifest-files.ts";

test("per-run seed is the artifact; shared seed path is a same-digest copy with overwrite note", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-manifest-"));
  try {
    const perRun = join(dir, "out", "run-1", "los-angeles-seed.csv");
    const shared = join(dir, "seeds", "los-angeles.csv");
    mkdirSync(join(dir, "out", "run-1"), { recursive: true });
    mkdirSync(join(dir, "seeds"), { recursive: true });
    const body =
      "parcel_id,source_identifier,situs_address\n0000000001,0000000001,1 TEST ST\n";
    writeFileSync(perRun, body);
    copyFileSync(perRun, shared);
    const expected = createHash("sha256").update(body).digest("hex");

    const [artifact, copy] = seedFileEntries(perRun, shared, 1);
    expect(artifact.path).toBe(perRun);
    expect(artifact.sha256).toBe(expected);
    expect(artifact.copy_of).toBeUndefined();
    expect(copy.path).toBe(shared);
    expect(copy.sha256).toBe(expected);
    expect(copy.copy_of).toBe(perRun);
    expect(copy.note ?? "").toMatch(/next run overwrites/);

    writeFileSync(shared, body + "0000000002,0000000002,2 TEST ST\n");
    expect(() => seedFileEntries(perRun, shared, 1)).toThrow(/not a byte copy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
