/**
 * Verify raw pages against their receipts (sha256, bytes) and flatten them to one NDJSON
 * staging file with per-row provenance. Exported for build-outputs.ts.
 */
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Receipt {
  file: string;
  request_url: string;
  method: string;
  retrieved_at: string;
  http_status: number;
  bytes: number;
  sha256: string;
  rows: number;
}

export function readReceipts(rawDir: string): Receipt[] {
  return readFileSync(join(rawDir, "receipts.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Receipt);
}

export async function stageRaw(
  rawDir: string,
  ndjsonPath: string,
): Promise<{ receipts: Receipt[]; rows: number }> {
  const receipts = readReceipts(rawDir);
  const out = createWriteStream(ndjsonPath);
  let rows = 0;
  for (const r of receipts) {
    const body = readFileSync(join(rawDir, r.file));
    const sha = createHash("sha256").update(body).digest("hex");
    if (sha !== r.sha256 || body.length !== r.bytes)
      throw new Error(`receipt mismatch for ${r.file}`);
    const page = JSON.parse(body.toString("utf8")) as {
      features: Array<{ attributes: Record<string, unknown> }>;
    };
    if (page.features.length !== r.rows)
      throw new Error(`row count mismatch for ${r.file}`);
    for (const f of page.features) {
      out.write(
        JSON.stringify({
          ...f.attributes,
          _page_file: r.file,
          _request_url: r.request_url,
          _retrieved_at: r.retrieved_at,
          _page_sha256: r.sha256,
        }) + "\n",
      );
      rows += 1;
    }
  }
  await new Promise<void>((resolve, reject) =>
    out.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  return { receipts, rows };
}
