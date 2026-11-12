import * as amplify from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

/** The Explorer's branch name on a host app (its URL is https://explorer.<app id>.amplifyapp.com). */
export const HOST_BRANCH = "explorer";

export interface ExplorerWebStackProps extends cdk.StackProps {
  siteDir: string;
  basicUser: string;
  basicPass: string;
  /**
   * SSM parameter holding the ID of an existing Amplify app to host the Explorer (read at deploy time).
   * Set: the stack creates only the `explorer` branch on that app. Absent: it creates its own app with a
   * `main` branch.
   */
  hostAppIdParameter?: string;
}

/** Pipeline Explorer on Amplify Hosting without Git: one branch deployed from the built dist, behind basic auth. */
export class ExplorerWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExplorerWebStackProps) {
    super(scope, id, props);
    // The password sits in the CloudFormation template, so there is no Secrets Manager standing cost.
    const basicAuth = () =>
      amplify.BasicAuth.fromCredentials(
        props.basicUser,
        cdk.SecretValue.unsafePlainText(props.basicPass),
      );
    // The token-hash SSM parameter is owned by OracleLaDataApi (driven by apps/api/cdk/clients.json).
    if (props.hostAppIdParameter) {
      // A branch on the host app: the app, its settings and its service role belong to the host app's stack.
      const appId = ssm.StringParameter.valueForStringParameter(
        this,
        props.hostAppIdParameter,
      );
      new amplify.Branch(this, "Branch", {
        app: amplify.App.fromAppId(this, "HostApp", appId),
        branchName: HOST_BRANCH,
        autoBuild: false, // no Git: nothing builds on Amplify
        pullRequestPreview: false,
        asset: new Asset(this, "Site", { path: props.siteDir }),
        basicAuth: basicAuth(),
      });
      new cdk.CfnOutput(this, "HostAppId", { value: appId });
      new cdk.CfnOutput(this, "Origin", {
        value: `https://${HOST_BRANCH}.${appId}.amplifyapp.com`,
      });
      return;
    }
    const app = new amplify.App(this, "App", {
      appName: "oracle-la-explorer",
      platform: amplify.Platform.WEB,
      customRules: [amplify.CustomRule.SINGLE_PAGE_APPLICATION_REDIRECT],
    });
    app.addBranch("main", {
      asset: new Asset(this, "Site", { path: props.siteDir }),
      basicAuth: basicAuth(),
    });
    new cdk.CfnOutput(this, "AppId", { value: app.appId });
    new cdk.CfnOutput(this, "Origin", {
      value: `https://main.${app.defaultDomain}`,
    });
  }
}
