/**
 * Offline `Judge` for the harness.
 *
 * Predictable, network-free answers keyed by question id. `decide()` (worker A, `src/decide/**`)
 * is the only consumer; the harness injects this into arms B/C when no real API key is present.
 *
 * The `Judge` / `SystemOneRequest` / `SystemOneResult` types are owned by worker A and re-exported
 * from `src/decide/index.ts` (see docs/CONTRACTS.md §1). The import below is type-only, so this
 * module has no runtime dependency on `src/decide/**`.
 */
import type {
  Judge,
  SystemOneAnswer,
  SystemOneRequest,
  SystemOneResult,
} from "../../src/decide/index.ts";

/** Per-question script entry. Everything is optional and has a documented default. */
export interface FakeJudgeScriptEntry {
  /** noul: scripted P(true) in [0,1]. Default `0.9`. */
  noul?: number;
  /** choice: scripted chosen option label. Default: the first key of the question's `criteria`. */
  choice?: string;
  /** score: scripted expected score. Default `0`. */
  score?: number;
  /** All modes: scripted confidence. Default `0.9`. */
  confidence?: number;
}

/** A `Judge` with an inspectable request log. Still assignable to plain `Judge`. */
export interface FakeJudge extends Judge {
  /** Every request seen so far, in order. Returned live (do not mutate in tests unless intended). */
  readonly requests: readonly SystemOneRequest[];
  /** Clears the request log. */
  reset(): void;
}

export const FAKE_JUDGE_MODEL = "fake-judge";

const DEFAULT_NOUL = 0.9;
const DEFAULT_SCORE = 0;
const DEFAULT_CONFIDENCE = 0.9;

/** First key of a JSON object, or `undefined` when `criteria` is not a plain object. */
function firstKey(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 ? keys[0] : undefined;
}

function buildAnswer(
  question: { type: "noul" | "choice" | "score"; criteria?: unknown },
  entry: FakeJudgeScriptEntry,
): SystemOneAnswer {
  const confidence = entry.confidence ?? DEFAULT_CONFIDENCE;
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: entry.noul ?? DEFAULT_NOUL, confidence };
    case "choice": {
      const choice = entry.choice ?? firstKey(question.criteria) ?? "";
      return { type: "choice", choice, confidence };
    }
    case "score":
      return { type: "score", score: entry.score ?? DEFAULT_SCORE, confidence };
  }
}

/**
 * Build a deterministic, offline `Judge` from a script keyed by question id.
 *
 * Unknown ids throw (fail loud, per docs/CONTRACTS.md §1) — the harness must never
 * silently invent a verdict.
 */
export function createFakeJudge(script: Record<string, FakeJudgeScriptEntry>): FakeJudge {
  const requests: SystemOneRequest[] = [];

  const judge: FakeJudge = {
    modelId: FAKE_JUDGE_MODEL,
    get requests(): readonly SystemOneRequest[] {
      return requests;
    },
    reset(): void {
      requests.length = 0;
    },
    async systemOne(
      req: SystemOneRequest,
      opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<SystemOneResult> {
      if (opts?.signal?.aborted === true) {
        throw new Error("fake-judge: aborted before answering");
      }
      requests.push(req);

      const answers: Record<string, SystemOneAnswer> = {};
      for (const [id, question] of Object.entries(req.questions)) {
        const entry = script[id];
        if (entry === undefined) {
          const known = Object.keys(script).sort().join(", ") || "(none)";
          throw new Error(
            `fake-judge: no scripted answer for question id "${id}" (scripted ids: ${known})`,
          );
        }
        answers[id] = buildAnswer(question, entry);
      }

      // Synthetic usage — this is not a measurement of anything real. It only keeps the
      // `SystemOneResult` shape complete.
      const inputTokens = JSON.stringify(req).length;
      const outputTokens = Object.keys(answers).length * 8;
      return {
        model: FAKE_JUDGE_MODEL,
        answers,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      };
    },
  };

  return judge;
}
