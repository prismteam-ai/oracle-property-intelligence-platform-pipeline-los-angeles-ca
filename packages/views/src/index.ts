export {
  EARTH_RADIUS_MILES,
  lit,
  OPEN_ISSUED,
  permitViewsSql,
  propertyViewsSql,
  runViewsSql,
  type DataPaths,
  type PermitPaths,
} from "./sql.ts";
export {
  daysFromYears,
  longOpenRule,
  roofAgeRule,
  type LongOpenRule,
  type RoofAgeRule,
} from "./rule.ts";

/** Views and macros the apps may query. Nothing else is part of the contract. */
export const CONTRACT = {
  views: [
    "oracle.v_property",
    "oracle.v_property_provenance",
    "oracle.v_permit",
    "oracle.v_permit_parcel",
    "oracle.v_permit_contractor",
    "oracle.v_permit_provenance",
    "oracle.v_source_page",
    "oracle.v_source",
    "oracle.v_run",
    "oracle.v_run_history",
  ],
  macros: [
    "oracle.roof_age_candidates",
    "oracle.long_open_permits",
    "oracle.long_open_parcels",
    "oracle.haversine_miles",
  ],
} as const;
