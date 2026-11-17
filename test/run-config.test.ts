import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import {
  buildDigest,
  isUnder,
  loadRunConfig,
  manifestDigestSha256,
  referenceDateOf,
  RUN_ID_PATTERN,
  RUN_ID_PLACEHOLDER,
  rollPublicationLimitation,
  rollSourceTerms,
  runIdOf,
  runTimeFromCaches,
} from "../src/run-config.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const OUTPUTS = [
  { role: "property", sha256: sha("property") },
  { role: "permits", sha256: sha("permits") },
  { role: "permit_parcels", sha256: sha("permit_parcels") },
  { role: "permit_contractors", sha256: sha("permit_contractors") },
];
/** A manifest in the recorded form, for the run ID given (paths name it, as the build's do). */
const manifest = (runId: string, over: Record<string, unknown> = {}) => ({
  run_id: runId,
  generated_at: "2026-11-14T12:00:00.000Z",
  dry_run: false,
  cache: {
    summary: { path: "summary.json", sha256: sha("summary") },
    pages: [{ path: "pages/page-00000.json.gz", body_sha256: sha("page 0") }],
  },
  build_digest: "",
  files: [{ path: `data/out/${runId}/x.parquet`, sha256: sha("property") }],
  limitations: ["one"],
  ...over,
});
// Two IDs of the new form, as a dry run and a recorded build of other builds would name them.
const A = "2026-11-12T14-00-51-383Z-b0123456789ab";
const B = "2026-11-12T14-00-51-383Z-bba9876543210";
const idOf = (m: Record<string, unknown>, outputs = OUTPUTS) =>
  runIdOf(
    "2026-11-12T14-00-51-383Z",
    buildDigest(outputs, manifestDigestSha256(m, String(m.run_id))),
  );

test("the run ID is <T>-b<D>: the latest cache time and the build digest's first 12 hex", () => {
  // The three caches' generated_at: roll, permits, contractors.
  expect(
    runTimeFromCaches([
      "2026-11-12T01:44:04.047Z",
      "2026-11-12T13:14:56.570Z",
      "2026-11-12T14:00:51.383Z",
    ]),
  ).toBe("2026-11-12T14-00-51-383Z");
  expect(
    runTimeFromCaches(["2026-11-13T00:00:00.000Z", "2026-11-12T23:59:59.999Z"]),
  ).toBe("2026-11-13T00-00-00-000Z");
  expect(runTimeFromCaches(["2026-11-12T01:44:04.047Z"])).toBe(
    "2026-11-12T01-44-04-047Z",
  );
  // The digest: sha256 over the sorted "output <role> <sha256>" lines and "manifest <sha256>".
  const m = sha("manifest");
  const lines = [
    ...OUTPUTS.map((o) => `output ${o.role} ${o.sha256}`),
    `manifest ${m}`,
  ].sort();
  const d = sha(lines.join("\n") + "\n");
  expect(buildDigest(OUTPUTS, m)).toBe(d);
  expect(buildDigest([...OUTPUTS].reverse(), m)).toBe(d);
  expect(runIdOf("2026-11-12T14-00-51-383Z", d)).toBe(
    `2026-11-12T14-00-51-383Z-b${d.slice(0, 12)}`,
  );
  expect(() => buildDigest([...OUTPUTS, OUTPUTS[0]!], m)).toThrow(/twice/);
  expect(() => buildDigest(OUTPUTS, "abc")).toThrow(/not a sha256/);
  expect(() => runIdOf("2026-11-12T14-00-51-383Z", "abc")).toThrow(
    /not a build digest/,
  );
});

test("run ID and reference date refuse anything but an ISO time", () => {
  expect(() => runTimeFromCaches([])).toThrow(/no cache times/);
  expect(() =>
    runTimeFromCaches(["2026-11-12T01:44:04.047Z", "2026-11-12 14:00"]),
  ).toThrow(/not an ISO time/);
  expect(() => referenceDateOf("12 Nov 2026")).toThrow(/not an ISO time/);
  expect(() => runIdOf("12 Nov 2026", sha("x"))).toThrow(/not a run ID/);
});

test("the same inputs and outputs give the same ID; one output byte or one cache digest gives a new one", () => {
  const id = idOf(manifest(A));
  expect(idOf(manifest(A))).toBe(id);
  // The run ID itself (in run_id and every path), generated_at and build_digest are not hashed.
  expect(idOf(manifest(B))).toBe(id);
  expect(idOf(manifest(RUN_ID_PLACEHOLDER))).toBe(id);
  expect(
    idOf(
      manifest(A, {
        generated_at: "2026-12-01T00:00:00.000Z",
        build_digest: sha("x"),
      }),
    ),
  ).toBe(id);
  // One output byte changed: another sha256, another ID.
  const outputs = OUTPUTS.map((o, i) =>
    i === 3 ? { ...o, sha256: sha("permit_contractors.") } : o,
  );
  expect(idOf(manifest(A), outputs)).not.toBe(id);
  // One input cache digest changed (it is in the manifest): another ID.
  expect(
    idOf(
      manifest(A, {
        cache: {
          summary: { path: "summary.json", sha256: sha("summary") },
          pages: [
            { path: "pages/page-00000.json.gz", body_sha256: sha("page 0.") },
          ],
        },
      }),
    ),
  ).not.toBe(id);
  // A manifest-only change (a limitation's wording): another ID, never "already recorded".
  expect(idOf(manifest(A, { limitations: ["one."] }))).not.toBe(id);
  // A dry run hashes the recorded form; dry_run true would be another manifest.
  expect(idOf(manifest(A, { dry_run: true }))).not.toBe(id);
  expect(readFileSync("src/build-outputs.ts", "utf8")).toMatch(
    /run_id: RUN_ID_PLACEHOLDER,[\s\S]*dry_run: false,\n {2}readiness/,
  );
});

test("the run ID is safe as a path segment and an S3 key; recorded IDs keep their form", () => {
  const id = idOf(manifest(A));
  expect(id).toMatch(/^2026-11-12T14-00-51-383Z-b[0-9a-f]{12}$/);
  expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  expect(RUN_ID_PATTERN.test(id)).toBe(true);
  const recorded = readFileSync("runs/run_history.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { run_id: string }).run_id);
  expect(recorded.length).toBeGreaterThanOrEqual(3);
  for (const r of recorded) expect(RUN_ID_PATTERN.test(r)).toBe(true);
  for (const bad of ["../x", "2026-11-12T14-00-51-383Z/x", `${id}0`, ""])
    expect(RUN_ID_PATTERN.test(bad)).toBe(false);
});

test("a path is under a run folder only with the trailing slash: one ID starts with another", () => {
  const old = "2026-11-12T14-00-51-383Z";
  const id = `${old}-b0123456789ab`;
  expect(isUnder(`data/out/${old}/x.parquet`, `data/out/${old}`)).toBe(true);
  expect(isUnder(`data/out/${old}/x.parquet`, `data/out/${old}/`)).toBe(true);
  expect(isUnder(`data/out/${id}/x.parquet`, `data/out/${old}`)).toBe(false);
  expect(isUnder(`data/out/${old}/x.parquet`, `data/out/${id}`)).toBe(false);
  // The dry-run summary lists the run's files with isUnder, never a bare startsWith.
  const src = readFileSync("src/build-outputs.ts", "utf8");
  expect(src).toMatch(/isUnder\(String\(f\.path\), recordedOut\)/);
  expect(src).not.toMatch(/startsWith\(outDir\)/);
});

test("the reference date is the permit cache's date, never the build date", () => {
  expect(referenceDateOf("2026-11-12T13:14:56.570Z")).toBe("2026-11-12");
  expect(readFileSync("src/build-outputs.ts", "utf8")).toMatch(
    /referenceDateOf\(permitCache\.summary\.generated_at\)/,
  );
});

test("the permits config names the catalog's City of LA datasets and the contractor view", () => {
  const cfg = loadRunConfig("config/la-county-permits-run.json");
  const catalog = parse(readFileSync(cfg.sources_catalog, "utf8")) as {
    permits: {
      jurisdictions: Array<{ jurisdiction: string; datasets?: string[] }>;
    };
  };
  const la = catalog.permits.jurisdictions.find(
    (j) => j.jurisdiction === "Los Angeles",
  )!;
  expect(cfg.permit_sources!.permits.datasets).toEqual(la.datasets);
  expect(cfg.permit_sources!.contractors.datasets).toEqual(["8guu-8f5m"]);
  expect(cfg).toMatchObject({
    permits_harvested: true,
    permit_jurisdictions: ["Los Angeles"],
    input: "roll-cache",
    jurisdiction: "all",
    zips: [],
  });
});

test("the permits config gives the roll's eGIS Hub terms, license and attribution", () => {
  const { source } = loadRunConfig("config/la-county-permits-run.json");
  expect(rollSourceTerms(source)).toEqual({
    terms_of_use: "https://egis-lacounty.hub.arcgis.com/pages/terms-of-use",
    license: expect.stringContaining(
      '"you are granted a license to copy, publish, distribute and/or transmit the Data, to adapt the Data and to exploit the Data for commercial and/or personal use"',
    ) as unknown,
    attribution: expect.stringMatching(
      /^County of Los Angeles; none required/,
    ) as unknown,
  });
  // The build records them in sources[0] from the config, never a literal of its own.
  const src = readFileSync("src/build-outputs.ts", "utf8");
  expect(src).toMatch(/const rollTerms = rollSourceTerms\(cfg\.source\)/);
  expect(src).not.toMatch(/terms_of_use: "https:\/\/egis-lacounty/);
});

test("the publication limitation carries the config's terms address", () => {
  const { source } = loadRunConfig("config/la-county-permits-run.json");
  const sentence = rollPublicationLimitation(rollSourceTerms(source));
  expect(sentence).toBe(
    `Publication: County roll data in this run may be republished under the LA County eGIS Hub terms of use (${source.terms_of_use}), quoted in this manifest's roll license, which grant a license to copy, publish and distribute the data. A roll-only extract of parcel rows is eligible for publication to IPFS, together with summaries of the run that hold no records.`,
  );
  expect(sentence).toContain(
    "(https://egis-lacounty.hub.arcgis.com/pages/terms-of-use)",
  );
  // Another address in the config is the address in the sentence.
  expect(
    rollPublicationLimitation({ terms_of_use: "https://example.test/terms" }),
  ).toContain("terms of use (https://example.test/terms), quoted");
  // The build writes it from the validated roll terms, with no sentence of its own.
  const src = readFileSync("src/build-outputs.ts", "utf8");
  expect(src).toMatch(/rollPublicationLimitation\(rollTerms\)/);
  expect(src).not.toMatch(/"Publication: /);
});

test.each(["terms_of_use", "license", "attribution"] as const)(
  "a roll source without %s is refused",
  (k) => {
    const { source } = loadRunConfig("config/la-county-permits-run.json");
    expect(() => rollSourceTerms({ ...source, [k]: " " })).toThrow(
      `the run config's source needs a ${k}`,
    );
    const rest: Partial<typeof source> = { ...source };
    delete rest[k];
    expect(() => rollSourceTerms(rest as typeof source)).toThrow(k);
  },
);
