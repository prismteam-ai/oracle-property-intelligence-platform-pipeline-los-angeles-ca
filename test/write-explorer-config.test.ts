/**
 * scripts/write-explorer-config.ts without AWS: the AWS CLI is a fake (no process is started, no network).
 */
import { describe, expect, test } from "vitest";
import {
  explorerConfig,
  stackOutput,
  type AwsCli,
} from "../scripts/write-explorer-config.ts";

const DATA = "https://abc123.execute-api.eu-north-1.amazonaws.com";
const AGENT = "https://def456.execute-api.eu-north-1.amazonaws.com";

/** A fake CLI answering describe-stacks per stack name; a stack missing throws as the CLI does. */
function fakeAws(outputs: Record<string, string | null>) {
  const calls: string[][] = [];
  const aws: AwsCli = (args) => {
    calls.push(args);
    const stack = args[args.indexOf("--stack-name") + 1]!;
    const out = outputs[stack];
    if (out === undefined || out === null)
      throw Object.assign(new Error("Command failed: aws"), {
        stderr: `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stack} does not exist\n`,
      });
    return `${out}\n`;
  };
  return { aws, calls };
}

describe("write-explorer-config", () => {
  test("reads ApiUrl from OracleLaDataApi and AgentApiUrl from OracleLaAgentApi in eu-north-1 with the profile", () => {
    const { aws, calls } = fakeAws({
      OracleLaDataApi: DATA,
      OracleLaAgentApi: AGENT,
    });
    expect(explorerConfig(aws, "p1", "tok")).toEqual({
      client: "explorer",
      apiUrl: DATA,
      apiToken: "tok",
      agentApiUrl: AGENT,
    });
    expect(calls).toEqual([
      [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        "OracleLaDataApi",
        "--profile",
        "p1",
        "--region",
        "eu-north-1",
        "--query",
        "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue",
        "--output",
        "text",
      ],
      [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        "OracleLaAgentApi",
        "--profile",
        "p1",
        "--region",
        "eu-north-1",
        "--query",
        "Stacks[0].Outputs[?OutputKey=='AgentApiUrl'].OutputValue",
        "--output",
        "text",
      ],
    ]);
  });

  test("without the agent stack: no agentApiUrl (the Explorer hides the Ask the agent tab)", () => {
    const { aws } = fakeAws({ OracleLaDataApi: DATA });
    const c = explorerConfig(aws, "p1", "tok");
    expect(c).toEqual({ client: "explorer", apiUrl: DATA, apiToken: "tok" });
    expect("agentApiUrl" in c).toBe(false);
  });

  test("without the data API stack, or with an unexpected value, it stops", () => {
    expect(() =>
      explorerConfig(fakeAws({ OracleLaAgentApi: AGENT }).aws, "p1", "tok"),
    ).toThrow(/OracleLaDataApi does not exist/);
    expect(() =>
      explorerConfig(
        fakeAws({ OracleLaDataApi: DATA, OracleLaAgentApi: "None" }).aws,
        "p1",
        "tok",
      ),
    ).toThrow("unexpected OracleLaAgentApi AgentApiUrl None");
    expect(() =>
      stackOutput(
        fakeAws({ OracleLaDataApi: "https://evil.example.com" }).aws,
        "p1",
        "OracleLaDataApi",
        "ApiUrl",
      ),
    ).toThrow(/unexpected/);
  });

  test("another CLI failure reading the agent stack stops the script (never a silent missing tab)", () => {
    const aws: AwsCli = (args) => {
      if (args.includes("OracleLaAgentApi"))
        throw Object.assign(new Error("Command failed: aws"), {
          stderr: "An error occurred (ExpiredToken)",
        });
      return DATA;
    };
    expect(() => explorerConfig(aws, "p1", "tok")).toThrow(
      "Command failed: aws",
    );
  });
});
