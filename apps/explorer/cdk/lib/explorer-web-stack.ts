import * as amplify from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import type { Construct } from "constructs";

export interface ExplorerWebStackProps extends cdk.StackProps {
  siteDir: string;
  basicUser: string;
  basicPass: string;
}

/** Pipeline Explorer on Amplify Hosting without Git: one branch deployed from the built dist, behind basic auth. */
export class ExplorerWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExplorerWebStackProps) {
    super(scope, id, props);
    const app = new amplify.App(this, "App", {
      appName: "oracle-la-explorer",
      platform: amplify.Platform.WEB,
      customRules: [amplify.CustomRule.SINGLE_PAGE_APPLICATION_REDIRECT],
    });
    app.addBranch("main", {
      asset: new Asset(this, "Site", { path: props.siteDir }),
      // The password sits in the CloudFormation template, so there is no Secrets Manager standing cost.
      basicAuth: amplify.BasicAuth.fromCredentials(
        props.basicUser,
        cdk.SecretValue.unsafePlainText(props.basicPass),
      ),
    });
    // The token-hash SSM parameter is owned by OracleLaDataApi (driven by apps/api/cdk/clients.json).
    new cdk.CfnOutput(this, "AppId", { value: app.appId });
    new cdk.CfnOutput(this, "Origin", {
      value: `https://main.${app.defaultDomain}`,
    });
  }
}
