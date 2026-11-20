import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

export const ALERT_TOPIC_PARAM = "/oracle-la/alerts/topic-arn";
/** Monthly cost budget with credits excluded (Budgets counts credits as negative cost by default). */
export const BUDGET_NAME = "oracle-la-monthly-cost-excluding-credits";
export const BUDGET_USD = 5;
export const BUDGET_ACTUAL_ALERT_PCT = 20; // $1 of real (pre-credit) spend in a month

export interface GuardsStackProps extends cdk.StackProps {
  alertEmail?: string;
}

/** Account guards shared by both repos: one SNS alert topic (alarms + budget) and a monthly budget. */
export class GuardsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GuardsStackProps) {
    super(scope, id, props);
    const topic = new sns.Topic(this, "Alerts", {
      topicName: "oracle-la-alerts",
      displayName: "Oracle LA alerts",
    });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AWSBudgetsSNSPublishingPermissions",
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["SNS:Publish"],
        resources: [topic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:aws:budgets::${this.account}:*` },
        },
      }),
    );
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchAlarmsPublish",
        principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["SNS:Publish"],
        resources: [topic.topicArn],
        // Both conditions as in the CloudWatch docs (Notify_Users_Alarm_Changes.html, confused-deputy example).
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:*`,
          },
        },
      }),
    );
    // The subscription needs the user's address and their click on the confirmation email.
    // Explicit construct id: EmailSubscription would derive the logical id from the address itself.
    if (props.alertEmail)
      new sns.Subscription(this, "AlertEmail", {
        topic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alertEmail,
      });
    new ssm.StringParameter(this, "AlertTopicArn", {
      parameterName: ALERT_TOPIC_PARAM,
      stringValue: topic.topicArn,
    });

    // Budget via the Budgets API: CloudFormation has no AWS::Budgets::Budget type in eu-north-1 and
    // us-east-1 is unavailable to this account (organization policy). Credits are excluded, because
    // Budgets counts credits as negative cost by default and a budget would stay silent while they drain.
    const budget = {
      BudgetName: BUDGET_NAME,
      BudgetType: "COST",
      TimeUnit: "MONTHLY",
      BudgetLimit: { Amount: String(BUDGET_USD), Unit: "USD" },
      CostTypes: { IncludeCredit: false, IncludeRefund: false },
    };
    const notify = (NotificationType: string, Threshold: number) => ({
      Notification: {
        NotificationType,
        ComparisonOperator: "GREATER_THAN",
        Threshold,
        ThresholdType: "PERCENTAGE",
      },
      Subscribers: [{ SubscriptionType: "SNS", Address: topic.topicArn }],
    });
    const budgetResource = new cr.AwsCustomResource(this, "MonthlyCostBudget", {
      onCreate: {
        service: "Budgets",
        action: "createBudget",
        parameters: {
          AccountId: this.account,
          Budget: budget,
          NotificationsWithSubscribers: [
            notify("ACTUAL", BUDGET_ACTUAL_ALERT_PCT),
            notify("FORECASTED", 100),
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of(BUDGET_NAME),
      },
      onUpdate: {
        service: "Budgets",
        action: "updateBudget",
        parameters: { AccountId: this.account, NewBudget: budget },
        physicalResourceId: cr.PhysicalResourceId.of(BUDGET_NAME),
      },
      onDelete: {
        service: "Budgets",
        action: "deleteBudget",
        parameters: { AccountId: this.account, BudgetName: BUDGET_NAME },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["budgets:ModifyBudget", "budgets:ViewBudget"],
          resources: [`arn:aws:budgets::${this.account}:budget/${BUDGET_NAME}`],
        }),
      ]),
      installLatestAwsSdk: false,
      logGroup: new logs.LogGroup(this, "BudgetCustomResourceLogs", {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    // Third notification (added after the budget existed): ACTUAL > 100% ($5). The budget resource only
    // creates notifications on create, so this one has its own create/delete calls.
    const actual100 = {
      NotificationType: "ACTUAL",
      ComparisonOperator: "GREATER_THAN",
      Threshold: 100,
      ThresholdType: "PERCENTAGE",
    };
    const n3 = new cr.AwsCustomResource(this, "BudgetActual100", {
      onCreate: {
        service: "Budgets",
        action: "createNotification",
        parameters: {
          AccountId: this.account,
          BudgetName: BUDGET_NAME,
          Notification: actual100,
          Subscribers: [{ SubscriptionType: "SNS", Address: topic.topicArn }],
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `${BUDGET_NAME}-actual-100`,
        ),
      },
      onDelete: {
        service: "Budgets",
        action: "deleteNotification",
        parameters: {
          AccountId: this.account,
          BudgetName: BUDGET_NAME,
          Notification: actual100,
        },
        ignoreErrorCodesMatching: "NotFoundException",
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["budgets:ModifyBudget", "budgets:ViewBudget"],
          resources: [`arn:aws:budgets::${this.account}:budget/${BUDGET_NAME}`],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    n3.node.addDependency(budgetResource);
    new cdk.CfnOutput(this, "AlertTopicArnOut", { value: topic.topicArn });
  }
}
