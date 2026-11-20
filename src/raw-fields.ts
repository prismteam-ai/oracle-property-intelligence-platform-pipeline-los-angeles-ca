/**
 * The roll attributes downloaded from the assessor roll query API (outFields): exactly the
 * columns the build reads in src/property-sql.ts, plus OBJECTID, the paging key
 * (orderByFields). Nothing else is downloaded, so roll values, exemptions and building
 * details the build does not use never reach data/raw. test/raw-fields.test.ts holds the
 * list to the build SQL and to the personal-data column pattern.
 */
export const RAW_FIELDS = [
  "OBJECTID",
  "AIN",
  "AssessorID",
  "YearBuilt",
  "EffectiveYearBuilt",
  "UseType",
  "UseCode",
  "UseCodeDescChar1",
  "UseCodeDescChar2",
  "UseCodeDescChar3",
  "UseCodeDescChar4",
  "PropertyLocation",
  "SitusHouseNo",
  "SitusFraction",
  "SitusDirection",
  "SitusStreet",
  "SitusUnit",
  "SitusCity",
  "SitusZIP5",
  "SitusZIP",
  "CENTER_LAT",
  "CENTER_LON",
  "TaxRateArea_CITY",
  "RollYear",
  "RecordingDate",
  "Roll_LandBaseYear",
] as const;
