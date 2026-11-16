/**
 * Checks run over the publishable JSON files before anything is called publishable:
 * - personal-data column names: every JSON key and every schema column name, through the build's own
 *   pattern (src/property-sql.ts personalDataColumns);
 * - contact-shaped values: e-mail addresses and North American phone numbers in any string;
 * - home paths (Linux and macOS home and root directories, a leading tilde, Windows user folders), and
 *   the local user and host names.
 * The value-based secrets scan and the account-ID scan are separate tools (run by the operator on the
 * same files). Results name the file, the check and the JSON path, never the value.
 */
import { hostname, userInfo } from "node:os";
import { personalDataColumns } from "./property-sql.ts";

export type ScanHit = { file: string; check: string; where: string };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// NANP with optional +1, brackets, spaces, dots or hyphens (the CRM notes rule's phone shapes).
const PHONE =
  /(?<![\d=&])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/;
const HOME_PATTERNS: [string, RegExp][] = [
  ["home path", /\/home\/[A-Za-z0-9._-]+/],
  ["home path", /\/Users\/[A-Za-z0-9._-]+/],
  ["home path", /\/root\//],
  ["home path", /(^|[\s"'(=])~\//],
  ["home path", /[A-Za-z]:\\Users\\/i],
];

function walk(
  v: unknown,
  path: string,
  visit: (path: string, key: string | null, s: string | null) => void,
) {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, visit));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      visit(`${path}.${k}`, k, null);
      walk(x, `${path}.${k}`, visit);
    }
  else if (typeof v === "string") visit(path, null, v);
}

export function scanJson(
  file: string,
  text: string,
  local: { user: string; host: string } = {
    user: userInfo().username,
    host: hostname(),
  },
): ScanHit[] {
  const hits: ScanHit[] = [];
  const doc: unknown = JSON.parse(text);
  const keys: { path: string; key: string }[] = [];
  const columnNames: { path: string; key: string }[] = [];
  const strings: string[] = [];
  walk(doc, "$", (path, key, s) => {
    if (key !== null) keys.push({ path, key });
    if (s !== null) {
      strings.push(s);
      if (/\.columns\[\d+\]\.name$/.test(path))
        columnNames.push({ path, key: s });
      if (EMAIL.test(s))
        hits.push({ file, check: "e-mail address", where: path });
      if (PHONE.test(s))
        hits.push({ file, check: "phone number", where: path });
    }
  });
  for (const list of [keys, columnNames]) {
    const flagged = new Set(personalDataColumns(list.map((k) => k.key)));
    for (const k of list)
      if (flagged.has(k.key))
        hits.push({ file, check: "personal-data column name", where: k.path });
  }
  // The raw text and the decoded strings (JSON escapes backslashes, so Windows paths show only decoded).
  const all = [text, ...strings].join("\n");
  for (const [check, re] of HOME_PATTERNS)
    if (re.test(all)) hits.push({ file, check, where: "text" });
  const lower = all.toLowerCase();
  for (const [check, v] of [
    ["local user name", local.user],
    ["local host name", local.host],
  ] as const)
    if (v.length >= 3 && lower.includes(v.toLowerCase()))
      hits.push({ file, check, where: "text" });
  return hits;
}
