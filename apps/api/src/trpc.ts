import { initTRPC } from "@trpc/server";
import type { Db } from "./db-types.ts";

/** Minimal logger/metrics shapes so the public AppRouter type does not depend on Powertools. */
export interface LoggerLike {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
}
export interface MetricsLike {
  addMetric(
    name: string,
    unit: "Count" | "Milliseconds" | "Bytes",
    value: number,
  ): void;
}
export interface Ctx {
  db: () => Promise<Db>;
  logger: LoggerLike;
  metrics: MetricsLike;
}

const t = initTRPC.context<Ctx>().create();
export const router = t.router;
export const procedure = t.procedure;
