import { createHash } from "node:crypto";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { expect, test } from "vitest";
import { isAllowed, loadHashes } from "../src/authorizer.ts";

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
  ssm.restore();
});
