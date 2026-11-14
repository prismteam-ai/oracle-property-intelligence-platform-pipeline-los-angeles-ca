/** Features the pipeline story lists that are not in this increment (shown disabled, with the reason). */
const FUTURE = [
  [
    "IPFS artifact manifest and CIDs",
    "Publication is blocked until republication rights under the LA County eGIS terms are confirmed.",
  ],
  [
    "Retrieval from two public IPFS gateways",
    "Follows the manifest; nothing is published yet.",
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
