import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AnswerError,
  failureMessage,
  stoppedMessage,
  type AgentApi,
  type AgentCenter,
  type AnswerResponse,
  type Conversation,
} from "./agent-api.ts";
import { AgentAnswerView } from "./AgentAnswer.tsx";
import { readNumber } from "./numeric.ts";
import { createWarmup, HOLD_MAX_MS, type Warmup } from "./warmup.ts";

/** The notice under the question box. */
export const NOTICE =
  "Your question, the center and the data the agent reads are sent to Anthropic to answer it.";

type Status = "idle" | "waking" | "working";

interface Turn {
  question: string;
  answer: AnswerResponse;
}

/** The center from the optional latitude and longitude fields: none, a center, or why it is not valid. */
export function centerFrom(
  lat: string,
  lon: string,
): { center?: AgentCenter; error?: string } {
  if (!lat.trim() && !lon.trim()) return {};
  if (!lat.trim() || !lon.trim())
    return { error: "Enter both latitude and longitude, or neither." };
  const la = readNumber(lat, { label: "Latitude", min: -90, max: 90 });
  if ("error" in la) return la;
  const lo = readNumber(lon, { label: "Longitude", min: -180, max: 180 });
  if ("error" in lo) return lo;
  return {
    center: { lat: la.value, lon: lo.value, label: "coordinates entered" },
  };
}

/**
 * The "Ask the agent" tab. Kept mounted while other tabs show, so the
 * conversation (history, session, signature) lives in component state only, never in storage; "New
 * conversation" drops it. The Send button is never disabled: a question asked during the warm-up is held with a
 * "waking up" status; a question asked while an answer is pending stays in the box with a note.
 */
export function AskAgent({
  agent,
  warmData,
  active,
}: {
  agent: AgentApi;
  /** One data API request (meta.info), not batched. */
  warmData: () => Promise<unknown>;
  /** True while the tab shows: opening it starts the warm-up. */
  active: boolean;
}) {
  const [warmup] = useState<Warmup>(() =>
    createWarmup({ warmAgent: () => agent.warm(), warmData }),
  );
  const [question, setQuestion] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const conversation = useRef<Conversation | undefined>(undefined);
  const pending = useRef(false);
  /** Bumped by "New conversation": an answer to an older conversation is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    if (active && !warmup.running() && warmup.stale()) void warmup.start();
  }, [active, warmup]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const asked = question;
    const q = asked.trim();
    if (!q) return setMessage("Type a question first.");
    if (pending.current)
      return setMessage(
        "Still working on the previous question: this one stays in the box until that answer is in.",
      );
    const c = centerFrom(lat, lon);
    if (c.error) return setMessage(c.error);
    pending.current = true;
    const gen = generation.current;
    setMessage(undefined);
    try {
      // Re-warm: the data API instances may be cold again.
      if (!warmup.running() && warmup.stale()) void warmup.start();
      if (warmup.running()) {
        setStatus("waking");
        await warmup.hold();
      }
      setStatus("working");
      const conv = conversation.current;
      const res = await agent.answer({
        question: q,
        ...(c.center ? { center: c.center } : {}),
        ...(conv
          ? {
              history: conv.history,
              session: conv.session,
              signature: conv.signature,
            }
          : {}),
      });
      if (gen !== generation.current) return;
      if (res.status === "stopped") {
        setMessage(stoppedMessage(res));
        return;
      }
      // Answered or refused: a normal message; the conversation continues from what the server signed.
      conversation.current = {
        history: res.history,
        session: res.session,
        signature: res.signature,
      };
      setTurns((t) => [...t, { question: q, answer: res }]);
      setQuestion((cur) => (cur === asked ? "" : cur));
    } catch (err) {
      if (gen !== generation.current) return;
      setMessage(
        err instanceof AnswerError
          ? err.message
          : failureMessage({ kind: "network" }),
      );
    } finally {
      // After "New conversation" the newer state owns these.
      if (gen === generation.current) {
        pending.current = false;
        setStatus("idle");
      }
    }
  };

  const newConversation = () => {
    generation.current++;
    conversation.current = undefined;
    pending.current = false;
    setTurns([]);
    setMessage(undefined);
    setStatus("idle");
  };

  return (
    <section className="ask-agent">
      <h2>Ask the agent</h2>
      {turns.length > 0 && (
        <ol className="agent-turns" data-testid="agent-turns">
          {turns.map((t, i) => (
            <li key={i} data-testid="agent-turn">
              <p className="agent-question">
                <b>You asked:</b> {t.question}
              </p>
              <AgentAnswerView answer={t.answer} />
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={(e) => void send(e)} data-testid="agent-form">
        <label className="agent-box">
          {turns.length ? "Follow-up question" : "Question"}
          <textarea
            name="question"
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Which properties within five miles of Van Nuys have roofs older than 15 years?"
          />
        </label>
        <fieldset className="inline">
          <legend>Center (optional: or name a place in the question)</legend>
          <label>
            Latitude
            <input
              name="center-lat"
              inputMode="decimal"
              autoComplete="off"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </label>
          <label>
            Longitude
            <input
              name="center-lon"
              inputMode="decimal"
              autoComplete="off"
              value={lon}
              onChange={(e) => setLon(e.target.value)}
            />
          </label>
        </fieldset>
        <p className="notice" data-testid="agent-notice">
          {NOTICE}
        </p>
        <p>
          <button type="submit" data-testid="agent-send">
            Send
          </button>{" "}
          <button
            type="button"
            data-testid="agent-new"
            onClick={newConversation}
          >
            New conversation
          </button>
        </p>
      </form>
      {status !== "idle" && (
        <p className="status" data-testid="agent-status" data-state={status}>
          {status === "waking"
            ? `Waking up the agent and the data API… your question is sent as soon as they answer (at most ${HOLD_MAX_MS / 1000} s).`
            : "Working on the answer… (usually 15–25 s)"}
        </p>
      )}
      {message && (
        <p className="error" data-testid="agent-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
