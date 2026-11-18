/**
 * The bundled runs/publications.jsonl (a Vite ?raw import): the Explorer's list is the tracked file's lines, parsed.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  manifestLinks,
  parsePublications,
  PUBLICATION_KEYS,
} from "../../../src/publications.ts";
import { GATEWAYS } from "../../../src/gateways.ts";
import { PUBLICATIONS } from "../src/publications.ts";

test("the Explorer's publications are the tracked runs/publications.jsonl, parsed", () => {
  const text = readFileSync(
    new URL("../../../runs/publications.jsonl", import.meta.url),
    "utf8",
  );
  expect(PUBLICATIONS).toEqual(parsePublications(text));
});

test("a line records the run, its artifact manifest's CID, its folder's CID and the date (no CAR identifier); the links go to the manifest on the first two gateways of the shared list", () => {
  expect(PUBLICATION_KEYS).toEqual([
    "run_id",
    "manifest_cid",
    "folder_cid",
    "published_at",
  ]);
  const manifest =
    "bafkreigqi7vtxtejkcf7y4vgba3lckqusywxy36nogl5o5sktnt52tlyfm";
  expect(manifestLinks(manifest)).toEqual(
    GATEWAYS.slice(0, 2).map((g) => ({
      host: g.host,
      url: `https://${g.host}/ipfs/${manifest}`,
    })),
  );
  expect(manifestLinks(manifest).map((l) => l.host)).toEqual([
    "ipfs.aleph.cloud",
    "gateway.pinata.cloud",
  ]);
});
