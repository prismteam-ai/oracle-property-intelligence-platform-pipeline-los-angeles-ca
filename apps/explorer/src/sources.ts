import type {
  ApiClient,
  SourceKind,
  SourceRow,
  Sources,
} from "@oracle-la/api-client";

/**
 * explorer.sources, fetched at most once per session (about 1.4 MB with the roll's pages) and shared by
 * the Sources, Records and Long-open tabs. A failed fetch is not kept, so the next tab visit retries.
 */
export type LoadSources = () => Promise<Sources>;
export function sourcesLoader(api: ApiClient): LoadSources {
  let p: Promise<Sources> | undefined;
  return () =>
    (p ??= api.explorer.sources.query().catch((e: unknown) => {
      p = undefined;
      throw e;
    }));
}

/** The changes this pipeline made to a source, where its license asks for them to be stated (CC BY 4.0). */
export const CHANGES_MADE: Record<SourceKind, string | null> = {
  parcel: null,
  permit: null,
  contractor: "license classes normalized",
};

/** The attribution line wherever contractor rows show, from the source's own license and attribution. */
export const contractorAttribution = (s: SourceRow) =>
  `Contains data from ${s.attribution}, licensed under ${s.license}; ${CHANGES_MADE.contractor}.`;

/** A source's coverage window as served: "permit_issue_date 2013-01-02 to 2023-05-19"; null without one. */
export const coverageText = (s: SourceRow): string | null =>
  s.coverage
    ? `${s.coverage.field} ${s.coverage.first} to ${s.coverage.last}`
    : null;

/**
 * The note wherever contractor rows show: the attribution, then the source's window ("Contractor rows exist
 * only for permits issued 2013-01-02 to 2023-05-19 (permit_issue_date).") when the source states one.
 */
export const contractorNote = (s: SourceRow): string =>
  s.coverage
    ? `${contractorAttribution(s)} Contractor rows exist only for permits issued ${s.coverage.first} to ${s.coverage.last} (${s.coverage.field}).`
    : contractorAttribution(s);

/** "2026-11-12T13:10:47.174Z → …" as recorded; one time when first and last are equal. */
export const retrieved = (s: SourceRow) =>
  s.first_retrieved_at === s.last_retrieved_at
    ? s.first_retrieved_at
    : `${s.first_retrieved_at} → ${s.last_retrieved_at}`;
