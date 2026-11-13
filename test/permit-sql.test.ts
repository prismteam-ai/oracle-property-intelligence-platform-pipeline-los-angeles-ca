import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PERMIT_FLAG_ONLY_FIELDS } from "../src/permit-fields.ts";
import {
  buildPermitTables,
  PUBLISHED_TABLES,
  type PermitBuildStats,
} from "../src/permit-sql.ts";
import { personalDataColumns } from "../src/property-sql.ts";
import { setupTables } from "./fixtures/permit-tables.ts";

const ROLL = [
  { AIN: "1000000001" },
  {
    AIN: "1000000002",
    SitusHouseNo: "20",
    SitusDirection: "W",
    SitusStreet: "ELM ST",
    SitusZIP5: "90002",
  },
];
const PERMITS = [
  {
    permit_nbr: "P01",
    apn: "1000000001",
    zip_code: "0",
    primary_address: "1 FIXTURE ST",
  },
  {
    permit_nbr: "P02",
    apn: "1000000999",
    primary_address: "20 W ELM STREET",
    zip_code: "90002",
    status_desc: "Issued",
    work_desc: "REROOF; call owner at (818) 555-1234, ATTN someone",
  },
  {
    permit_nbr: "P03",
    apn: null,
    issue_date: null,
    submitted_date: "2024-02-03T00:00:00.000",
    status_desc: "PC Approved",
    _dataset: "bbbb-2222",
    _dataset_kind: "submitted",
  },
  { permit_nbr: "P04", apn: "1000000001", status_desc: "Permit Revoked" },
];
const CONTRACTORS = [
  { pcis_permit: "P01" },
  {
    pcis_permit: "P01",
    license_type: "NA",
    license: "0",
    contractors_business_name: "OWNER-BUILDER",
  },
  { pcis_permit: "P02", license_type: "C93", license_expiration_date: null },
  {
    pcis_permit: "P09",
    license_type: "N/A",
    license: "0",
    contractors_business_name: null,
  },
];
const OPTS = {
  referenceDate: "2026-11-12",
  permitSourceName: "fixture permits",
  contractorSourceName: "fixture contractors",
};

async function build(): Promise<{
  db: DuckDBInstance;
  c: DuckDBConnection;
  stats: PermitBuildStats;
}> {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await setupTables(c, ROLL, PERMITS, CONTRACTORS);
  return { db, c, stats: await buildPermitTables(c, OPTS) };
}

let db: DuckDBInstance;
let c: DuckDBConnection;
let stats: PermitBuildStats;
beforeAll(async () => ({ db, c, stats } = await build()));
afterAll(() => {
  c.closeSync();
  db.closeSync();
});

const rows = async (sql: string, conn = c) =>
  (await conn.runAndReadAll(sql)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;
const columns = async (t: string) =>
  (
    await rows(
      `select column_name from information_schema.columns where table_name = '${t}' order by ordinal_position`,
    )
  ).map((r) => String(r.column_name));

const PROVENANCE = [
  "source_http_request",
  "source_http_method",
  "source_retrieved_at",
  "source_page_sha256",
  "source_page_file",
  "source_name",
];

test("published column names", async () => {
  expect(await columns("permit")).toEqual([
    "permit_number",
    "source_apn",
    "unnormalized_address",
    "postal_code",
    "source_permit_type",
    "source_permit_sub_type",
    "source_business_unit",
    "application_received_date",
    "permit_issue_date",
    "source_status_desc",
    "status_date",
    "permit_status_class",
    "open_since",
    "open_days",
    "roof_r",
    "roof_only",
    "roofing_work",
    "roof_coating_only",
    "join_method",
    "unjoined_cause",
    "source_dataset",
    "source_dataset_kind",
    "roof_flag_rule_version",
    "permit_status_rule_version",
    "join_rule_version",
    ...PROVENANCE,
  ]);
  expect(await columns("permit_parcel")).toEqual([
    "permit_number",
    "parcel_identifier",
    "join_method",
    "building_level",
    "join_rule_version",
  ]);
  expect(await columns("permit_contractor")).toEqual([
    "permit_number",
    "contractors_business_name",
    "license_identifier",
    "source_license_type",
    "license_class",
    "license_class_name",
    "license_class_note",
    "is_owner_builder",
    "license_expiration_date",
    "city_name",
    "state_code",
    "permit_issue_date",
    "license_class_rule_version",
    ...PROVENANCE,
  ]);
  expect((await columns("property")).slice(-3)).toEqual([
    "effective_roof_year",
    "roof_year_permit_number",
    "roof_year_rule_version",
  ]);
  expect(await columns("property")).toContain("permit_data_available");
});

test("work_desc is in no published table, nor its text", async () => {
  for (const t of PUBLISHED_TABLES) {
    const cols = await columns(t);
    for (const f of PERMIT_FLAG_ONLY_FIELDS) expect(cols, t).not.toContain(f);
    const text = JSON.stringify(await rows(`select * from ${t}`));
    expect(text, t).not.toMatch(/555-1234|ATTN|REROOF/);
  }
});

test("no published table has a personal-data column", async () => {
  for (const t of PUBLISHED_TABLES)
    expect(personalDataColumns(await columns(t)), t).toEqual([]);
});

test("only the published tables and the inputs remain", async () => {
  expect(
    (
      await rows("select table_name from information_schema.tables order by 1")
    ).map((r) => r.table_name),
  ).toEqual([
    "contractor_raw",
    "permit",
    "permit_contractor",
    "permit_parcel",
    "permit_raw",
    "property",
  ]);
});

test("permit rows: dates, ZIP, status class, open duration, join, provenance", async () => {
  const r = await rows(`
    select permit_number, postal_code, permit_issue_date::varchar issued, application_received_date::varchar received,
      status_date::varchar status_date, permit_status_class, open_since::varchar open_since, open_days,
      join_method, unjoined_cause, source_http_method, source_name
    from permit order by permit_number`);
  expect(r).toEqual([
    {
      permit_number: "P01",
      postal_code: null,
      issued: "2015-01-02",
      received: null,
      status_date: "2015-03-04",
      permit_status_class: "closed",
      open_since: null,
      open_days: null,
      join_method: "direct",
      unjoined_cause: null,
      source_http_method: "GET",
      source_name: "fixture permits",
    },
    {
      permit_number: "P02",
      postal_code: "90002",
      issued: "2015-01-02",
      received: null,
      status_date: "2015-03-04",
      permit_status_class: "open-issued",
      open_since: "2015-01-02",
      open_days: 4332,
      join_method: "address",
      unjoined_cause: null,
      source_http_method: "GET",
      source_name: "fixture permits",
    },
    {
      permit_number: "P03",
      postal_code: null,
      issued: null,
      received: "2024-02-03",
      status_date: "2015-03-04",
      permit_status_class: "open-application",
      open_since: "2024-02-03",
      open_days: 1013,
      join_method: null,
      unjoined_cause: "apn-missing/no-usable-address",
      source_http_method: "GET",
      source_name: "fixture permits",
    },
    {
      permit_number: "P04",
      postal_code: null,
      issued: "2015-01-02",
      received: null,
      status_date: "2015-03-04",
      permit_status_class: "unmapped",
      open_since: null,
      open_days: null,
      join_method: "direct",
      unjoined_cause: null,
      source_http_method: "GET",
      source_name: "fixture permits",
    },
  ]);
  expect(stats.unmapped_statuses).toEqual({ "Permit Revoked": 1 });
  expect(stats.status_classes).toEqual({
    closed: 1,
    "open-application": 1,
    "open-issued": 1,
    unmapped: 1,
  });
});

test("contractor rows: classes, owner-builder and N/A without a license number", async () => {
  const r = await rows(`
    select permit_number, contractors_business_name, license_identifier, source_license_type, license_class,
      license_class_note, is_owner_builder, license_expiration_date::varchar exp, city_name, state_code
    from permit_contractor order by permit_number, source_license_type`);
  expect(r).toEqual([
    {
      permit_number: "P01",
      contractors_business_name: "FIXTURE ROOFING CO",
      license_identifier: "123456",
      source_license_type: "C39",
      license_class: "C-39",
      license_class_note: null,
      is_owner_builder: false,
      exp: "2027-01-31",
      city_name: "LOS ANGELES",
      state_code: "CA",
    },
    {
      permit_number: "P01",
      contractors_business_name: "OWNER-BUILDER",
      license_identifier: null,
      source_license_type: "NA",
      license_class: null,
      license_class_note: "owner-builder",
      is_owner_builder: true,
      exp: "2027-01-31",
      city_name: "LOS ANGELES",
      state_code: "CA",
    },
    {
      permit_number: "P02",
      contractors_business_name: "FIXTURE ROOFING CO",
      license_identifier: "123456",
      source_license_type: "C93",
      license_class: null,
      license_class_note: "unmapped",
      is_owner_builder: false,
      exp: null,
      city_name: "LOS ANGELES",
      state_code: "CA",
    },
    {
      permit_number: "P09",
      contractors_business_name: null,
      license_identifier: null,
      source_license_type: "N/A",
      license_class: null,
      license_class_note: null,
      is_owner_builder: false,
      exp: "2027-01-31",
      city_name: "LOS ANGELES",
      state_code: "CA",
    },
  ]);
  expect(stats.unmapped_license_types).toEqual({ C93: 1 });
  expect(stats.contractors).toEqual({
    rows: 4,
    permits: 3,
    permits_in_permit_table: 2,
    owner_builder_rows: 1,
    rows_without_license_number: 2,
  });
});

test("the same inputs build identical tables", async () => {
  const again = await build();
  for (const t of PUBLISHED_TABLES)
    expect(await rows(`select * from ${t}`, again.c), t).toEqual(
      await rows(`select * from ${t}`),
    );
  expect(again.stats).toEqual(stats);
  again.c.closeSync();
  again.db.closeSync();
});

test("a source date that is not a date fails the build", async () => {
  const bad = await DuckDBInstance.create(":memory:");
  const bc = await bad.connect();
  await setupTables(bc, ROLL, [{ permit_nbr: "P01", status_date: "soon" }], []);
  await expect(buildPermitTables(bc, OPTS)).rejects.toThrow(/soon/);
  bc.closeSync();
  bad.closeSync();
});
