/** Features the pipeline story lists that are not in this increment (shown disabled, with the reason). */
const FUTURE = [
  [
    "Permit and contractor rows on IPFS",
    "Not published. The City building-permit sets state no license. The contractor view is CC BY 4.0 but is held back: some of its business names may be personal names, and a publication cannot be withdrawn. Only a County roll extract is eligible for publication.",
  ],
  [
    "A publish step in the app",
    "Publication to IPFS is run by hand, after a person reviews the files. A step in the app with review and approval is not built.",
  ],
  [
    "Permits outside the City of Los Angeles",
    "LADBS permits cover the City of Los Angeles only; the other 88 jurisdictions have no classified permit source yet.",
  ],
  [
    "BBB ratings and CSLB license status",
    "No BBB or CSLB source is ingested (contractor rows come from the LADBS contractor view; BBB shows as not available).",
  ],
  ["Business records", "California Secretary of State adapter later."],
  [
    "Ownership (out-of-area owners)",
    "The open roll has no owner mailing address; not available.",
  ],
] as const;

export function Placeholders() {
  return (
    <section>
      <h2>Coming next</h2>
      <div className="cards">
        {FUTURE.map(([title, why]) => (
          <div
            key={title}
            className="placeholder"
            aria-disabled="true"
            data-testid="placeholder"
          >
            <b>{title}</b>
            <p>{why}</p>
            <button disabled>Not available yet</button>
          </div>
        ))}
      </div>
    </section>
  );
}
