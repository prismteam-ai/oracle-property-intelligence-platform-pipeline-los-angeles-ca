/** tRPC API Lambda (HTTP API, payload 2.0). Powertools Logger, Tracer and Metrics go through the tRPC context. */
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { S3Client } from "@aws-sdk/client-s3";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { openDb, parsePermitFiles, type Db } from "./db.ts";
import { appRouter } from "./routers/index.ts";
import type { Ctx, LoggerLike, MetricsLike } from "./trpc.ts";

const logger = new Logger();
const tracer = new Tracer();
const metrics = new Metrics();
/** The only S3 client: X-Ray-traced, passed to openDb so the cold-start copy appears in traces. */
const s3 = tracer.captureAWSv3Client(new S3Client({}));
const loggerLike: LoggerLike = {
  info: (m, e) => logger.info(m, e ?? {}),
  warn: (m, e) => logger.warn(m, e ?? {}),
};
const metricsLike: MetricsLike = {
  addMetric: (name, unit, value) =>
    metrics.addMetric(name, MetricUnit[unit], value),
};

let dbPromise: Promise<Db> | undefined;
const getDb = (): Promise<Db> => {
  dbPromise ??= Promise.resolve()
    .then(() =>
      openDb(
        {
          runId: process.env.RUN_ID!,
          parquetSha256: process.env.PARQUET_SHA256!,
          parquetFile: process.env.PARQUET_FILE!,
          permitFiles: parsePermitFiles(process.env.PERMIT_FILES ?? ""),
          bucket: process.env.DATA_BUCKET!,
          prefix: process.env.DATA_PREFIX!,
        },
        s3,
      ),
    )
    .then(
      (db) => {
        logger.info("data loaded", {
          runId: db.runId,
          rollYear: db.rollYear,
          loadMs: db.loadMs,
        });
        metrics.addMetric("DataLoadMs", MetricUnit.Milliseconds, db.loadMs);
        return db;
      },
      (err: unknown) => {
        dbPromise = undefined; // retry on the next invocation
        throw err;
      },
    );
  return dbPromise;
};

const trpc = awsLambdaRequestHandler({
  router: appRouter,
  createContext: (): Ctx => ({
    db: getDb,
    logger: loggerLike,
    metrics: metricsLike,
  }),
  onError: ({ error, path }) => {
    if (error.code === "INTERNAL_SERVER_ERROR")
      logger.error("procedure failed", { path, error });
    else logger.warn("procedure rejected", { path, code: error.code });
  },
});

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
) => {
  logger.addContext(context);
  metrics.captureColdStartMetric();
  try {
    return await trpc(event, context);
  } finally {
    metrics.publishStoredMetrics();
  }
};
