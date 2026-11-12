import { createHash } from "node:crypto";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { expect, test } from "vitest";
import {
  handler,
  isAllowed,
  loadHashes,
  matchClient,
} from "../src/authorizer.ts";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

test("loads one hash per client from SSM and ignores malformed values", async () => {
  const ssm = mockClient(SSMClient);
  ssm
    .on(GetParametersByPathCommand)
    .resolvesOnce({
      Parameters: [{ Name: "/x/explorer/token-sha256", Value: hash("a") }],
      NextToken: "n",
    })
    .resolvesOnce({
      Parameters: [
        { Name: "/x/crm/token-sha256", Value: hash("b") },
        { Name: "/x/bad/token-sha256", Value: "nothex" },
        { Name: "/x/crm/origin", Value: "https://o" },
      ],
    });
  const hashes = await loadHashes(new SSMClient({}), "/x/");
  expect(hashes).toHaveLength(2);
  expect(isAllowed("Bearer a", hashes)).toBe(true);
  expect(isAllowed("Bearer b", hashes)).toBe(true);
  expect(isAllowed("Bearer c", hashes)).toBe(false);
  expect(isAllowed("a", hashes)).toBe(false);
  expect(isAllowed(undefined, hashes)).toBe(false);
  expect(matchClient("Bearer a", hashes)).toBe("explorer");
  expect(matchClient("Bearer b", hashes)).toBe("crm");
  expect(matchClient("Bearer c", hashes)).toBeUndefined();
  ssm.restore();
});

test("the handler returns the matched client in the context, and no context when denied", async () => {
  const ssm = mockClient(SSMClient);
  ssm.on(GetParametersByPathCommand).resolves({
    Parameters: [
      { Name: "/oracle-la/api/clients/crm/token-sha256", Value: hash("t-crm") },
      {
        Name: "/oracle-la/api/clients/explorer/token-sha256",
        Value: hash("t-exp"),
      },
    ],
  });
  process.env.TOKEN_HASH_PATH = "/oracle-la/api/clients/";
  const ctx = { functionName: "authorizer" } as never;
  const call = (authorization?: string) =>
    handler(
      { headers: authorization ? { authorization } : {}, routeKey: "GET /x" },
      ctx,
    );
  expect(await call("Bearer t-crm")).toEqual({
    isAuthorized: true,
    context: { client: "crm" },
  });
  expect(await call("Bearer t-exp")).toEqual({
    isAuthorized: true,
    context: { client: "explorer" },
  });
  expect(await call("Bearer wrong")).toEqual({ isAuthorized: false });
  expect(await call()).toEqual({ isAuthorized: false });
  ssm.restore();
});
