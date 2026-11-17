/**
 * The bundled runs/publications.jsonl (a Vite ?raw import): the Explorer's list is the tracked file's lines, parsed.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parsePublications } from "../../../src/publications.ts";
import { PUBLICATIONS } from "../src/publications.ts";

test("the Explorer's publications are the tracked runs/publications.jsonl, parsed", () => {
  const text = readFileSync(
    new URL("../../../runs/publications.jsonl", import.meta.url),
    "utf8",
  );
  expect(PUBLICATIONS).toEqual(parsePublications(text));
});
