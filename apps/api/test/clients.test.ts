import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { describe, expect, test } from "vitest";
import {
  type ClientsFile,
  clientOrigin,
  corsOrigins,
  parseClients,
} from "../cdk/lib/clients.ts";

const committed = JSON.parse(
  readFileSync(new URL("../cdk/clients.json", import.meta.url), "utf8"),
) as ClientsFile;

describe("API clients (clients.json)", () => {
  test("the committed list: crm and explorer as branches of the app in the SSM parameter, mcp with no browser origin; no app ID or literal origin", () => {
    const f = parseClients(committed);
    expect(f.amplifyAppIdParameter).toBe("/roofing-crm/web/app-id");
    expect(f.clients).toEqual([
      { name: "crm", amplifyBranch: "main" },
      { name: "explorer", amplifyBranch: "explorer" },
      { name: "mcp", browser: false },
    ]);
    // CORS: the two browser clients only, in list order.
    expect(corsOrigins(f.clients, "dexample123456")).toEqual([
      "https://main.dexample123456.amplifyapp.com",
      "https://explorer.dexample123456.amplifyapp.com",
    ]);
    expect(JSON.stringify(committed)).not.toMatch(
      /amplifyapp\.com|\bd[a-z0-9]{12,14}\b/,
    );
  });

  test("a branch origin is resolved at deploy time from the SSM parameter", () => {
    const stack = new cdk.Stack(new cdk.App(), "S");
    const appId = ssm.StringParameter.valueForStringParameter(
      stack,
      "/roofing-crm/web/app-id",
    );
    const resolved = stack.resolve(
      clientOrigin({ name: "explorer", amplifyBranch: "explorer" }, appId),
    ) as { "Fn::Join": [string, unknown[]] };
    expect(resolved["Fn::Join"][1][0]).toBe("https://explorer.");
    expect(resolved["Fn::Join"][1][1]).toEqual({ Ref: expect.any(String) });
    expect(resolved["Fn::Join"][1][2]).toBe(".amplifyapp.com");
    expect(
      clientOrigin({ name: "x", amplifyBranch: "main" }, "dexample123456"),
    ).toBe("https://main.dexample123456.amplifyapp.com");
  });

  test("a literal origin is kept as is", () => {
    expect(
      clientOrigin({ name: "x", origin: "https://site.example.org" }),
    ).toBe("https://site.example.org");
  });

  test("a client with browser: false has no CORS origin and needs no Amplify app ID", () => {
    expect(clientOrigin({ name: "mcp", browser: false })).toBeUndefined();
    const f = parseClients({
      clients: [
        { name: "web", origin: "https://site.example.org" },
        { name: "mcp", browser: false },
      ],
    });
    expect(corsOrigins(f.clients)).toEqual(["https://site.example.org"]);
    expect(corsOrigins([{ name: "mcp", browser: false }])).toEqual([]);
    // At synth the branch origins stay deploy-time tokens; the mcp client adds none.
    const stack = new cdk.Stack(new cdk.App(), "S");
    const appId = ssm.StringParameter.valueForStringParameter(
      stack,
      "/roofing-crm/web/app-id",
    );
    expect(corsOrigins(parseClients(committed).clients, appId)).toHaveLength(2);
  });

  test("invalid lists are refused", () => {
    const bad = (f: ClientsFile) => () => parseClients(f);
    expect(bad({ clients: [{ name: "x", amplifyBranch: "main" }] })).toThrow(
      /amplifyAppIdParameter/,
    );
    expect(
      bad({
        amplifyAppIdParameter: "/p",
        clients: [
          { name: "x", origin: "https://a.example", amplifyBranch: "main" },
        ],
      }),
    ).toThrow(/exactly one/);
    expect(bad({ clients: [{ name: "x" }] })).toThrow(/exactly one/);
    expect(
      bad({
        clients: [{ name: "x", origin: "https://a.example", browser: false }],
      }),
    ).toThrow(/exactly one/);
    expect(
      bad({
        amplifyAppIdParameter: "/p",
        clients: [{ name: "x", amplifyBranch: "main", browser: false }],
      }),
    ).toThrow(/exactly one/);
    expect(
      bad({ clients: [{ name: "x", browser: true as unknown as false }] }),
    ).toThrow(/browser may only be false/);
    expect(
      bad({ clients: [{ name: "x", origin: "http://a.example" }] }),
    ).toThrow(/bad origin/);
    expect(
      bad({
        amplifyAppIdParameter: "/p",
        clients: [{ name: "x", amplifyBranch: "Main_1" }],
      }),
    ).toThrow(/bad amplifyBranch/);
    expect(
      bad({
        clients: [
          { name: "x", origin: "https://a.example" },
          { name: "x", origin: "https://b.example" },
        ],
      }),
    ).toThrow(/twice/);
    expect(() => clientOrigin({ name: "x", amplifyBranch: "main" })).toThrow(
      /no Amplify app ID/,
    );
  });
});
