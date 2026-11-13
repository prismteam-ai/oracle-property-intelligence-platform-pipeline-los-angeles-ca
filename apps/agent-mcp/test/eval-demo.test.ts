/**
 * The eval script's --key-file option: the Anthropic key file has no default path and no environment variable.
 * Only cases that end before a model client is built are run (the usage errors exit 2, a path that does not exist
 * prints "skipped: no key"), so no key is read and nothing is sent. The only key file is a scratch file with a fake
 * value.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../scripts/eval-demo.ts", import.meta.url),
);

const dir = mkdtempSync(join(tmpdir(), "agent-eval-demo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run the script with only PATH and `env` set (no credentials of any provider). */
function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("eval script: --key-file", () => {
  test("missing with AGENT_PROVIDER=anthropic: usage error naming the option, exit 2", () => {
    const r = run([], {
      AGENT_PROVIDER: "anthropic",
      AGENT_MODEL: "sonnet-5.5",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      "--key-file <path> is required for AGENT_PROVIDER=anthropic",
    );
    expect(r.stdout).toBe("");
  });

  test("given with AGENT_PROVIDER=bedrock: usage error, exit 2", () => {
    const path = join(dir, "fake-key.json");
    writeFileSync(path, JSON.stringify({ apiKey: "fake-key-not-real" }));
    chmodSync(path, 0o600);
    const r = run(["--key-file", path], {
      AGENT_PROVIDER: "bedrock",
      AGENT_MODEL: "haiku-5.5",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      "--key-file applies to AGENT_PROVIDER=anthropic only",
    );
    expect(r.stderr).not.toContain("fake-key-not-real");
    expect(r.stdout).toBe("");
  });

  test("a path that does not exist: skipped: no key, exit 0", () => {
    const r = run(["--key-file", join(dir, "absent.json")], {
      AGENT_PROVIDER: "anthropic",
      AGENT_MODEL: "sonnet-5.5",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("skipped: no key");
  });
});
