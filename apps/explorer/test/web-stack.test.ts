/**
 * Template test of the Explorer web stack in both modes (no AWS calls): its own Amplify app, and a branch on
 * a host app whose ID is read from an SSM parameter at deploy time. Dummy credentials and account.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import {
  ExplorerWebStack,
  HOST_BRANCH,
} from "../cdk/lib/explorer-web-stack.ts";

const PARAM = "/roofing-crm/web/app-id";
const synth = (hostAppIdParameter?: string) => {
  const siteDir = mkdtempSync(join(tmpdir(), "explorer-site-"));
  writeFileSync(join(siteDir, "index.html"), "<!doctype html>");
  const stack = new ExplorerWebStack(new cdk.App(), "OracleLaExplorerWeb", {
    env: { account: "123456789012", region: "eu-north-1" },
    siteDir,
    basicUser: "test-user",
    basicPass: "test-pass",
    hostAppIdParameter,
  });
  return Template.fromStack(stack);
};

describe("Explorer web stack", () => {
  test("own-app mode: an Amplify app with its service role and a main branch behind basic auth", () => {
    const t = synth();
    t.resourceCountIs("AWS::Amplify::App", 1);
    t.resourceCountIs("AWS::IAM::Role", 1);
    t.hasResourceProperties("AWS::Amplify::App", {
      Name: "oracle-la-explorer",
      Platform: "WEB",
    });
    t.hasResourceProperties("AWS::Amplify::Branch", {
      BranchName: "main",
      AppId: { "Fn::GetAtt": [Match.anyValue(), "AppId"] },
      BasicAuthConfig: Match.objectLike({ EnableBasicAuth: true }),
    });
    expect(Object.keys(t.toJSON().Parameters ?? {})).toEqual([
      "BootstrapVersion",
    ]);
    t.hasOutput("AppId", {});
    // A full CDK synth: it took over 5 s when the shared machine was busy, so it gets 20 s.
  }, 20_000);

  test("host mode: only an explorer branch on the app named by the SSM parameter; no app, no IAM in this stack", () => {
    const t = synth(PARAM);
    const json = t.toJSON();
    t.resourceCountIs("AWS::Amplify::App", 0);
    t.resourceCountIs("AWS::Amplify::Branch", 1);
    for (const r of Object.values(
      json.Resources as Record<string, { Type: string }>,
    ))
      expect(r.Type).not.toMatch(/^AWS::IAM::/);
    const [param, def] = Object.entries(
      json.Parameters as Record<string, { Type: string; Default?: string }>,
    ).find(([, p]) => p.Default === PARAM)!;
    expect(def.Type).toBe("AWS::SSM::Parameter::Value<String>");
    t.hasResourceProperties("AWS::Amplify::Branch", {
      AppId: { Ref: param },
      BranchName: HOST_BRANCH,
      EnableAutoBuild: false,
      BasicAuthConfig: Match.objectLike({ EnableBasicAuth: true }),
    });
    t.hasResourceProperties("Custom::AmplifyAssetDeployment", {
      AppId: { Ref: param },
      BranchName: HOST_BRANCH,
    });
    t.hasOutput("Origin", {
      Value: {
        "Fn::Join": [
          "",
          [`https://${HOST_BRANCH}.`, { Ref: param }, ".amplifyapp.com"],
        ],
      },
    });
  });
});
