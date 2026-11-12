import { hash } from "./store";
export interface DecisionEvent {
  sequence: number; strategy: string; mode: "PAPER"; policyHash: string; policyRevision: number;
  epoch: number; configRevision: number; at: number; kind: string; reason: string;
  input: unknown; result: unknown; previous: string; digest: string;
}
export function appendEvent(events: DecisionEvent[], context: Omit<DecisionEvent, "sequence" | "previous" | "digest">) {
  if (events.length >= 4096) throw Error("Decision archive capacity; stop and archive offline");
  const entry = { ...context, input: redact(context.input), result: redact(context.result), sequence: events.length, previous: events.at(-1)?.digest ?? "" };
  events.push({ ...entry, digest: hash(entry) });
}
function redact(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redact);
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, /secret|private|password|authorization|signature|credential|api.?key|seed/i.test(key) ? "[REDACTED]" : redact(value)]));
  return input;
}
export function replay(events: DecisionEvent[]) {
  let previous = "";
  events.forEach((event, i) => {
    const { digest, ...body } = event;
    if (body.sequence !== i || body.previous !== previous || digest !== hash(body)) throw Error("Decision replay mismatch");
    previous = digest;
  });
  return previous;
}
