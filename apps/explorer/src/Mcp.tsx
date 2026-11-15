import { useState } from "react";
import {
  EXAMPLE,
  MCP_SERVER_NAME,
  mcpTools,
  runExample,
  type McpToolResult,
} from "./mcp-tools.ts";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** The result's text parsed back, for the summary line (the raw result is shown as it is). */
function summary(r: McpToolResult): string {
  try {
    const body = JSON.parse(r.content[0]?.text ?? "") as {
      result?: { count?: number; items?: unknown[]; error?: string };
      records?: unknown[];
      gaps?: unknown[];
    };
    if (r.isError) return `isError: ${body.result?.error ?? "tool error"}`;
    return `${body.result?.count?.toLocaleString("en-US") ?? "?"} matching parcels, ${body.result?.items?.length ?? 0} returned, ${body.records?.length ?? 0} records cited, ${body.gaps?.length ?? 0} gaps`;
  } catch {
    return "unreadable result";
  }
}

/**
 * The "MCP" tab: the MCP server's tools from its own definitions, one live example through
 * the data API in the tool-result shape, and how to connect a client to the local stdio server. No new AWS resource:
 * the example reads the data API with this site's token, as the Radius query tab does.
 */
export function Mcp({
  apiUrl,
  apiToken,
}: {
  apiUrl: string;
  apiToken: string;
}) {
  const [tools] = useState(mcpTools);
  const [run, setRun] = useState<{
    loading?: boolean;
    result?: McpToolResult;
    error?: string;
  }>({});
  const start = () => {
    setRun({ loading: true });
    runExample({ apiUrl, apiToken }).then(
      (result) => setRun({ result }),
      (e: Error) => setRun({ error: e.message }),
    );
  };
  return (
    <section className="mcp">
      <h2>MCP interface</h2>
      <p>
        The local MCP server <code>{MCP_SERVER_NAME}</code> (stdio,{" "}
        <code>apps/agent-mcp</code>) offers the agent&apos;s {tools.length}{" "}
        tools to any MCP client. The list below is built from the same
        definitions the server registers (name, description, input schema).
        Every result is JSON text <code>{"{ result, records, gaps }"}</code>.
      </p>
      <h3>Tools</h3>
      <div data-testid="mcp-tools">
        {tools.map((t) => (
          <article key={t.name} className="mcp-tool" data-testid="mcp-tool">
            <h4 className="mono" data-testid="mcp-tool-name">
              {t.name}
            </h4>
            <p data-testid="mcp-tool-description">{t.description}</p>
            <details>
              <summary>Input schema</summary>
              <pre className="mono" data-testid="mcp-tool-schema">
                {pretty(t.inputSchema)}
              </pre>
            </details>
          </article>
        ))}
      </div>
      <h3>Live example: the radius query</h3>
      <p>
        <code>tools/call</code> of <code>{EXAMPLE.tool}</code> with these
        arguments, run in this page through the tool code the server uses, over
        the data API:
      </p>
      <pre className="mono" data-testid="mcp-example-args">
        {pretty({ name: EXAMPLE.tool, arguments: EXAMPLE.arguments })}
      </pre>
      <p>
        <button
          type="button"
          data-testid="mcp-example-run"
          onClick={start}
          disabled={run.loading}
        >
          Run the example
        </button>
      </p>
      {run.loading && <p data-testid="mcp-example-status">Running…</p>}
      {run.error && <p className="error">{run.error}</p>}
      {run.result && (
        <>
          <p data-testid="mcp-example-summary">{summary(run.result)}</p>
          <pre className="mono mcp-result" data-testid="mcp-example-result">
            {pretty(run.result)}
          </pre>
        </>
      )}
      <h3>Connecting a client to the local server</h3>
      <ol>
        <li>
          On the machine where the MCP client runs: Node 22.18 or later and a
          checkout of this repository with its dependencies installed.
        </li>
        <li>
          A token file for the <code>mcp</code> API client (data routes only;
          not this site&apos;s token): JSON{" "}
          <code>{'{ "apiToken": "<token>" }'}</code> with mode 0600 (
          <code>chmod 600 &lt;token-file&gt;</code>). The token is never an
          argument or an environment variable.
        </li>
        <li>
          Register the server with the client as a stdio command, for example in
          Claude Code:
          <pre className="mono" data-testid="mcp-connect">
            {`claude mcp add ${MCP_SERVER_NAME} -- node <checkout>/apps/agent-mcp/src/server.ts --api-url ${apiUrl} --token-file <token-file>`}
          </pre>
          or in a client&apos;s JSON configuration:
          <pre className="mono">
            {pretty({
              mcpServers: {
                [MCP_SERVER_NAME]: {
                  command: "node",
                  args: [
                    "<checkout>/apps/agent-mcp/src/server.ts",
                    "--api-url",
                    apiUrl,
                    "--token-file",
                    "<token-file>",
                  ],
                },
              },
            })}
          </pre>
        </li>
        <li>
          The server reads the data API as the hosted agent does (at most 2
          calls in flight, one retry, a gap when a route is not read); without
          options it reads the latest run of a checkout that has the run&apos;s
          data files instead. See <code>apps/agent-mcp/README.md</code>.
        </li>
      </ol>
    </section>
  );
}
