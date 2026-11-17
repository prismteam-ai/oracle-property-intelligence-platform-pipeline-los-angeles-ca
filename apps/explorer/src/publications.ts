/**
 * The tracked runs/publications.jsonl, bundled at build (a Vite ?raw import, so the page makes no request for it)
 * and parsed once: the run history's "Published (identifier)" column reads it. A malformed line fails the build
 * (vite.config.ts checks the file) and the tests, never the page silently. The data API's `published` flag is not
 * used; the agent and the data API never read this file.
 */
import raw from "../../../runs/publications.jsonl?raw";
import {
  parsePublications,
  type Publication,
} from "../../../src/publications.ts";

export const PUBLICATIONS: readonly Publication[] = parsePublications(raw);
