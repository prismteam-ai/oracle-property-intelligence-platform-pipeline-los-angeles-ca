export {
  EARTH_RADIUS_MILES,
  lit,
  propertyViewsSql,
  runViewsSql,
  type DataPaths,
} from "./sql.ts";
export { roofAgeRule, type RoofAgeRule } from "./rule.ts";

/** Views and macros the apps may query. Nothing else is part of the contract. */
export const CONTRACT = {
  views: [
    "oracle.v_property",
    "oracle.v_property_provenance",
    "oracle.v_source_page",
    "oracle.v_source",
    "oracle.v_run",
    "oracle.v_run_history",
  ],
  macros: ["oracle.roof_age_candidates", "oracle.haversine_miles"],
} as const;
