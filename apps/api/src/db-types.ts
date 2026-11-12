/** Data access surface used by the routers (no imports, so the public AppRouter type stays self-contained). */
export interface Db {
  rows(
    sql: string,
    params?: unknown[],
  ): Promise<Array<Record<string, unknown>>>;
  runId: string;
  parquetSha256: string;
  rollYear: number;
  loadMs: number;
}
