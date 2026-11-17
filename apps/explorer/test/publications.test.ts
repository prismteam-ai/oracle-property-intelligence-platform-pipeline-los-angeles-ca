/**
 * The bundled runs/publications.jsonl (a Vite ?raw import): the Explorer's list is the tracked file's lines, parsed.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  gatewayUrl,
  parsePublications,
  PUBLICATION_KEYS,
} from "../../../src/publications.ts";
import { PUBLICATIONS } from "../src/publications.ts";

test("the Explorer's publications are the tracked runs/publications.jsonl, parsed", () => {
  const text = readFileSync(
    new URL("../../../runs/publications.jsonl", import.meta.url),
    "utf8",
  );
  expect(PUBLICATIONS).toEqual(parsePublications(text));
});

test("a line records the run, its artifact manifest's CID, its folder's CID and the date (no CAR identifier); the link goes to the manifest", () => {
  expect(PUBLICATION_KEYS).toEqual([
    "run_id",
    "manifest_cid",
    "folder_cid",
    "published_at",
  ]);
  const manifest =
    "bafkreigqi7vtxtejkcf7y4vgba3lckqusywxy36nogl5o5sktnt52tlyfm";
  expect(gatewayUrl(manifest)).toBe(`https://ipfs.io/ipfs/${manifest}`);
});
