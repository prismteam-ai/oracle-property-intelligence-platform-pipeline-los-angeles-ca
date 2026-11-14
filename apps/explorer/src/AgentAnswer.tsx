import {
  GAP_CONTRACTOR_NO_WINDOW,
  GAP_CONTRACTOR_WINDOW_UNREAD,
} from "../../../packages/agent/src/contractor-coverage.ts";
import { STANDARD_GAPS } from "../../../packages/agent/src/policy.ts";
import type { AnswerResponse, Citation } from "./agent-api.ts";
import { Markdown } from "./markdown.tsx";

/**
 * A gap every answer states (STANDARD_GAPS, with the contractor gap as contractor-coverage.ts words it for the
 * run's window), as opposed to a gap of this answer. The standing ones are listed under "Always true".
 */
export function isStandingGap(gap: string): boolean {
  return (
    STANDARD_GAPS.includes(gap) ||
    gap === GAP_CONTRACTOR_NO_WINDOW ||
    gap === GAP_CONTRACTOR_WINDOW_UNREAD ||
    /^No contractor license data after [A-Z][a-z]+ \d{4}\.$/.test(gap) ||
    /^The contractor rows \(.+\) cover permits issued \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(by .+\)\.$/.test(
      gap,
    )
  );
}

/** The answer's gaps: this answer's own first, then the standing ones. */
export function splitGaps(gaps: readonly string[]): {
  specific: string[];
  standing: string[];
} {
  return {
    specific: gaps.filter((g) => !isStandingGap(g)),
    standing: gaps.filter(isStandingGap),
  };
}

const KINDS: ReadonlyArray<[Citation["kind"], string]> = [
  ["parcel", "Parcels"],
  ["permit", "Permits"],
  ["contractor", "Contractor rows (by permit)"],
];

/** One answer as §8 of the hosting plan renders it. */
export function AgentAnswerView({ answer }: { answer: AnswerResponse }) {
  const gaps = splitGaps(answer.gaps);
  return (
    <div
      className="agent-answer"
      data-testid="agent-answer"
      data-status={answer.status}
    >
      <div className="agent-text" data-testid="agent-text">
        <Markdown text={answer.text} flagged={answer.unverified_ids} />
      </div>
      {answer.unverified_ids.length > 0 && (
        <p className="note" data-testid="agent-unverified">
          Unverified IDs (not returned by any tool in this answer; treat them as
          unconfirmed): {answer.unverified_ids.join(", ")}
        </p>
      )}
      <details data-testid="agent-how">
        <summary>How I got this</summary>
        <p>{answer.reasoning}</p>
        {answer.assumptions.length > 0 && (
          <>
            <b>Assumptions</b>
            <ul>
              {answer.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </>
        )}
      </details>
      <h4>Sources</h4>
      {answer.records.length === 0 ? (
        <p data-testid="agent-sources-none">No records cited.</p>
      ) : (
        KINDS.map(([kind, label]) => {
          const rows = answer.records.filter((r) => r.kind === kind);
          if (!rows.length) return null;
          return (
            <div key={kind} className="table-wrap">
              <table data-testid="agent-sources" data-kind={kind}>
                <caption>{label}</caption>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Source</th>
                    <th>License</th>
                    <th>Attribution</th>
                    <th>Collected at</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}/${r.id}`}>
                      <td className="mono">{r.id}</td>
                      <td>{r.source_name}</td>
                      <td>{r.license ?? "—"}</td>
                      <td>{r.attribution ?? "—"}</td>
                      <td>{r.collected_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })
      )}
      <h4>Gaps</h4>
      {gaps.specific.length > 0 && (
        <ul data-testid="agent-gaps">
          {gaps.specific.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
      <b>Always true</b>
      <ul data-testid="agent-standing-gaps">
        {gaps.standing.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
    </div>
  );
}
