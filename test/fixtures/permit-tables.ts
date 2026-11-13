/**
 * Synthetic input tables for buildPermitTables (src/permit-sql.ts), written at test setup:
 * a raw roll table turned into property by the real propertyTableSql, plus permit_raw and
 * contractor_raw in the staged layout. No real rows.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { CONTRACTOR_FIELDS, PERMIT_FIELDS } from "../../src/permit-fields.ts";
import { propertyTableSql, sqlLiteral as lit } from "../../src/property-sql.ts";
import { RAW_FIELDS } from "../../src/raw-fields.ts";

type Row = Record<string, string | null | undefined>;
const PROVENANCE = [
  "_page_file",
  "_request_url",
  "_retrieved_at",
  "_page_sha256",
];
const val = (v: string | null | undefined) =>
  v === null || v === undefined ? "null" : lit(v);

async function table(
  c: DuckDBConnection,
  name: string,
  columns: readonly string[],
  rows: Row[],
): Promise<void> {
  await c.run(
    `create table ${name} (${columns.map((f) => `"${f}" varchar`).join(", ")})`,
  );
  for (const r of rows)
    await c.run(
      `insert into ${name} values (${columns.map((f) => val(r[f])).join(", ")})`,
    );
}

export function rollRow(r: Row): Row {
  return {
    OBJECTID: "1",
    AssessorID: "0000-000-000",
    YearBuilt: "1960",
    EffectiveYearBuilt: "1965",
    UseType: "Residential",
    UseCode: "0100",
    PropertyLocation: "FIXTURE",
    SitusHouseNo: "1",
    SitusDirection: "",
    SitusStreet: "FIXTURE ST",
    SitusCity: "LOS ANGELES CA",
    SitusZIP5: "90001",
    SitusZIP: "90001-0000",
    CENTER_LAT: "34.0",
    CENTER_LON: "-118.0",
    TaxRateArea_CITY: "LOS ANGELES",
    RollYear: "2026",
    RecordingDate: "1262304000000",
    _page_file: "pages/page-00000.json.gz",
    _request_url: "https://example.invalid/roll",
    _retrieved_at: "2026-11-12T00:00:00Z",
    _page_sha256: "0".repeat(64),
    ...r,
  };
}

export function permitRaw(r: Row): Row {
  return {
    apn: null,
    primary_address: null,
    zip_code: null,
    permit_type: "Bldg-Alter/Repair",
    permit_sub_type: "1 or 2 Family Dwelling",
    business_unit: "Plan Check",
    work_desc: "REROOF",
    submitted_date: null,
    issue_date: "2015-01-02T00:00:00.000",
    status_desc: "Permit Finaled",
    status_date: "2015-03-04T00:00:00.000",
    _dataset: "aaaa-1111",
    _dataset_kind: "issued",
    _page_file: "pages/aaaa-1111_p000.json.gz",
    _request_url: "https://data.lacity.org/resource/aaaa-1111.json",
    _retrieved_at: "2026-11-12T13:10:00.000Z",
    _page_sha256: "1".repeat(64),
    ...r,
  };
}

export function contractorRaw(r: Row): Row {
  return {
    contractors_business_name: "FIXTURE ROOFING CO",
    license: "123456",
    license_type: "C39",
    license_expiration_date: "2027-01-31T00:00:00.000",
    contractor_city: "Los Angeles",
    contractor_state: "CA",
    issue_date: "2015-01-02T00:00:00.000",
    _dataset: "8guu-8f5m",
    _page_file: "pages/8guu-8f5m_p000.json.gz",
    _request_url: "https://data.lacity.org/resource/8guu-8f5m.json",
    _retrieved_at: "2026-11-12T14:00:00.000Z",
    _page_sha256: "2".repeat(64),
    ...r,
  };
}

/** Create raw → property, permit_raw and contractor_raw. */
export async function setupTables(
  c: DuckDBConnection,
  roll: Row[],
  permits: Row[],
  contractors: Row[],
): Promise<void> {
  await table(c, "raw", [...RAW_FIELDS, ...PROVENANCE], roll.map(rollRow));
  await c.run(propertyTableSql("2026-11-12", "fixture roll"));
  await c.run("drop table raw");
  await table(
    c,
    "permit_raw",
    [...PERMIT_FIELDS, "_dataset", "_dataset_kind", ...PROVENANCE],
    permits.map(permitRaw),
  );
  await table(
    c,
    "contractor_raw",
    [...CONTRACTOR_FIELDS, "_dataset", ...PROVENANCE],
    contractors.map(contractorRaw),
  );
}
