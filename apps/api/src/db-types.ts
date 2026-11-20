/** Data access surface used by the routers (no imports, so the public AppRouter type stays self-contained). */
export interface Db {
  rows(
    sql: string,
    params?: unknown[],
  ): Promise<Array<Record<string, unknown>>>;
  runId: string;
  parquetSha256: string;
  /** The verified sha256 of each permit Parquet file. */
  permitFiles: Array<{ role: string; sha256: string }>;
  rollYear: number;
  /** The run's reference date (YYYY-MM-DD): every derived duration counts to it. */
  referenceDate: string;
  loadMs: number;
}
