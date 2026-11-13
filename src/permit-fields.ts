/**
 * Fields staged from the two LADBS caches on data.lacity.org (src/stage-permits.ts and
 * src/stage-contractors.ts). Everything else a cached row holds is dropped at staging:
 *  - permits: pin_nbr, lat, lon, type_lat_lon (there is no coordinate matching), use_code, use_desc,
 *    valuation, square_footage, construction, solar, cofo_date and refresh_time;
 *  - contractors: nothing (the cache was fetched with exactly these columns).
 * test/permit-fields.test.ts checks these lists.
 */
export const PERMIT_FIELDS = [
  "permit_nbr",
  "apn",
  "primary_address",
  "zip_code",
  "permit_type",
  "permit_sub_type",
  "business_unit",
  "work_desc",
  "submitted_date",
  "issue_date",
  "status_desc",
  "status_date",
] as const;

/**
 * Staged only to set the roofing flags, never written to a published table: the free text holds
 * people's names. It stays in the ignored data/work staging file.
 */
export const PERMIT_FLAG_ONLY_FIELDS = ["work_desc"] as const;

/** The contractor rows' columns (view 8guu-8f5m), all staged. */
export const CONTRACTOR_FIELDS = [
  "pcis_permit",
  "contractors_business_name",
  "license",
  "license_type",
  "license_expiration_date",
  "contractor_city",
  "contractor_state",
  "issue_date",
] as const;
