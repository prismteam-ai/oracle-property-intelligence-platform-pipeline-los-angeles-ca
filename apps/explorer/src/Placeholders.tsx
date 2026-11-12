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
  ["Agent query (natural language)", "Not in this increment (no Bedrock)."],
  ["MCP interface", "Planned over the same SQL views."],
  [
    "Permits and long-open roofing permits",
    "Permits are not harvested yet (88 jurisdictions unclassified; LADBS later).",
  ],
  [
    "Contractors and BBB ratings",
    "Depends on permits (CSLB, BBB enrichment later).",
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
