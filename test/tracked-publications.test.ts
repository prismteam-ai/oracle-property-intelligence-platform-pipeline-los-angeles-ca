/**
 * The publications tracked under runs/<run_id>/publication/: the run's artifact manifest and its CAR, the
 * publish folder (coverage.json only), the folder's directory record and its CAR, as built by
 * src/build-ipfs-artifacts.ts and published. The publish check must accept each folder and each manifest
 * with the real named objects, each CAR must be the deterministic CAR of its bytes, and the record must
 * name both CIDs. The run's own record (run_manifest.json) is untouched beside it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bytesCidCodec, sha256Hex } from "../src/ipfs-unixfs.ts";
import { guardDirectory, guardManifestFile } from "../src/publish-guard.ts";

const runs = readdirSync("runs", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((id) => existsSync(join("runs", id, "publication")))
  .sort();

const bytes = (p: string) => new Uint8Array(readFileSync(p));

describe("tracked publications in runs/<run_id>/publication/", () => {
  test("the two published runs carry one each", () => {
    expect(runs).toEqual([
      "2026-11-12T14-00-51-383Z-bc7f18f2e9cf2",
      "2026-11-17T00-55-12-521Z-b1f1fbb377948",
    ]);
  });

  for (const id of runs)
    test(`${id}: the manifest, the folder, its record and the two CARs pass the publish check`, async () => {
      const dir = join("runs", id, "publication");
      expect(readdirSync(dir).sort()).toEqual([
        "artifact-manifest.car",
        "artifact-manifest.json",
        "directory.car",
        "directory.json",
        "publish",
      ]);
      expect(readdirSync(join(dir, "publish"))).toEqual(["coverage.json"]);
      const manifest = bytes(join(dir, "artifact-manifest.json"));
      const manifestCar = bytes(join(dir, "artifact-manifest.car"));
      const coverage = bytes(join(dir, "publish", "coverage.json"));
      const car = bytes(join(dir, "directory.car"));
      const record = JSON.parse(
        readFileSync(join(dir, "directory.json"), "utf8"),
      ) as {
        run_id: string;
        directory_cid: string;
        car: { size: number; sha256: string };
        artifact_manifest: {
          cid: string;
          size: number;
          sha256: string;
          car: { size: number; sha256: string };
        };
        publish_guard: { passes: boolean };
      };
      const manifestCid = (await bytesCidCodec(manifest)).cid;
      expect(record.run_id).toBe(id);
      expect(record.car).toMatchObject({
        size: car.length,
        sha256: sha256Hex(car),
      });
      expect(record.artifact_manifest).toMatchObject({
        cid: manifestCid,
        size: manifest.length,
        sha256: sha256Hex(manifest),
        car: { size: manifestCar.length, sha256: sha256Hex(manifestCar) },
      });
      expect(record.publish_guard.passes).toBe(true);
      expect(
        await guardDirectory(
          {
            files: [{ name: "coverage.json", bytes: coverage }],
            root: record.directory_cid,
            car,
          },
          manifest,
        ),
      ).toEqual([]);
      expect(
        await guardManifestFile({
          name: "artifact-manifest.json",
          bytes: manifest,
          root: manifestCid,
          car: manifestCar,
        }),
      ).toEqual([]);
      expect(JSON.parse(new TextDecoder().decode(coverage)).run_id).toBe(id);
      expect(existsSync(join("runs", id, "run_manifest.json"))).toBe(true);
    });
});
