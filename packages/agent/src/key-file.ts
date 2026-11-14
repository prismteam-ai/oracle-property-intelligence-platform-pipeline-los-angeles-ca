/**
 * The Anthropic API key comes from a file, never from the environment (Mario, 13 Nov 2026). The path has no
 * default and no environment variable: the caller passes it (the eval's required --key-file option, config.ts and
 * model-client.ts); the key itself is never an argument or an environment variable.
 *
 * File format: JSON `{ "apiKey": "<key>" }` (camelCase, like the repo's other .secrets files). Before reading, the
 * path is stat'ed: it must be a regular file whose permission bits (mode & 0o777) are exactly 0o600. Anything else
 * refuses to start with an AnthropicKeyFileError naming the path (and the mode in octal where it is the problem).
 * No error message ever contains file content: JSON.parse's own message quotes the input, so it is never used.
 */
import { readFileSync, statSync, type Stats } from "node:fs";

/** The only permission bits a key file may have: owner read and write. */
export const REQUIRED_KEY_FILE_MODE = 0o600;

/** Permission bits in octal with a leading 0, e.g. 0644. */
export function octalMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

export type KeyFileProblem =
  | "missing"
  | "unreadable"
  | "not-a-regular-file"
  | "mode"
  | "invalid-json"
  | "missing-api-key";

/** A refused secret file: carries the path, the problem and the mode; never file content. */
export class SecretFileError extends Error {
  readonly path: string;
  readonly problem: KeyFileProblem;
  /** The file's permission bits in octal (e.g. "0644"), when it could be stat'ed. */
  readonly mode: string | null;

  constructor(
    message: string,
    path: string,
    problem: KeyFileProblem,
    mode: string | null = null,
  ) {
    super(message);
    this.name = "SecretFileError";
    this.path = path;
    this.problem = problem;
    this.mode = mode;
  }
}

/** Refusal to start provider "anthropic". Carries the path, the problem and the mode; never file content. */
export class AnthropicKeyFileError extends SecretFileError {
  constructor(
    path: string,
    problem: KeyFileProblem,
    detail: string,
    mode: string | null = null,
  ) {
    super(
      `refusing to start provider "anthropic": the key file ${path} ${detail}`,
      path,
      problem,
      mode,
    );
    this.name = "AnthropicKeyFileError";
  }
}

const errorCode = (err: unknown): string =>
  err &&
  typeof err === "object" &&
  "code" in err &&
  typeof err.code === "string"
    ? err.code
    : "unknown error";

/**
 * Read one non-empty string field of a JSON secret file at `path`, with the checks of the header comment (a regular
 * file, mode exactly 0600, valid JSON, the field present). `refuse` builds the error for a problem and its detail
 * text; `example` is the expected content shown in it (e.g. { "apiKey": "<key>" }).
 */
export function readSecretField(
  path: string,
  field: string,
  example: string,
  refuse: (
    problem: KeyFileProblem,
    detail: string,
    mode: string | null,
  ) => Error,
): string {
  let st: Stats;
  try {
    st = statSync(path);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR")
      throw refuse("missing", "does not exist.", null);
    throw refuse("unreadable", `cannot be stat'ed (${code}).`, null);
  }
  const mode = octalMode(st.mode);
  if (!st.isFile())
    throw refuse(
      "not-a-regular-file",
      `is not a regular file (mode ${mode}).`,
      mode,
    );
  if ((st.mode & 0o777) !== REQUIRED_KEY_FILE_MODE)
    throw refuse(
      "mode",
      `has mode ${mode}; it must be exactly 0600 (chmod 600 ${path}).`,
      mode,
    );
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw refuse("unreadable", `cannot be read (${errorCode(err)}).`, mode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never the SyntaxError's message: V8 quotes the input in it.
    throw refuse(
      "invalid-json",
      `is not valid JSON (expected ${example}).`,
      mode,
    );
  }
  const value =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw refuse(
      "missing-api-key",
      `has no non-empty string "${field}" (expected ${example}).`,
      mode,
    );
  return value;
}

/**
 * Read the API key from `path` (as the caller gave it). Throws AnthropicKeyFileError when the file is missing, is not a
 * regular file, has permission bits other than 0600, is not valid JSON, or has no non-empty string `apiKey`.
 */
export function readAnthropicKeyFile(path: string): string {
  return readSecretField(
    path,
    "apiKey",
    '{ "apiKey": "<key>" }',
    (problem, detail, mode) =>
      new AnthropicKeyFileError(path, problem, detail, mode),
  );
}
