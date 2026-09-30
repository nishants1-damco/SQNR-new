// Reconstruction eval harness (plan §9.7.3, §18.1), replacing the original
// `scripts/run-eval.ts`.
//
//   pnpm eval                          score every fixture; replay recorded captures
//   pnpm eval --provider claude        run captures live on Claude (needs ANTHROPIC_API_KEY)
//   pnpm eval --provider ollama        run captures on the local model (pnpm infra:llm)
//   pnpm eval --provider claude --record          ...and save the replies for replay
//   pnpm eval --provider claude --effort reconstruction=medium,review=low
//   pnpm eval --fixture living-room-1  one fixture only
//   pnpm eval --json results.json      machine-readable results
//
// Replay (the default, and what CI runs) needs no model and no key: it
// answers from `replies.<provider>.json` and checks the deterministic parts
// of the pipeline still produce the same room. Live runs measure the model
// itself, and report tokens and cost per fixture, for the effort sweep and
// the prompt-caching experiment.
//
// Exit code is 1 when a fixture that has results fails a tolerance check.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadWorkerConfig } from "@spatial/config";
import {
  CLOUD_BUDGETS,
  type Effort,
  LOCAL_BUDGETS,
  type LlmProvider,
  openGate,
  ProviderFactory,
  silentLogger,
} from "@spatial/pipeline";
import { loadFixtures, loadReplies } from "./fixtures";
import { RecordingProvider, ReplayProvider } from "./providers";
import { CaptureRunner } from "./run-capture";
import { type FixtureResult, scoreFixture } from "./score";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function parseEffort(value: string | undefined): Partial<Record<string, Effort>> | undefined {
  if (!value) return undefined;
  const out: Partial<Record<string, Effort>> = {};
  for (const pair of value.split(",")) {
    const [step, level] = pair.split("=").map((s) => s.trim());
    if (!step || !EFFORTS.includes(level as Effort)) {
      throw new Error(`--effort expects step=level pairs (${EFFORTS.join("|")}), got "${pair}"`);
    }
    out[step] = level as Effort;
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      record: { type: "boolean", default: false },
      effort: { type: "string" },
      fixture: { type: "string" },
      json: { type: "string" },
      fixtures: { type: "string" },
    },
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = values.fixtures ?? join(here, "..", "fixtures");
  if (values.provider && values.provider !== "claude" && values.provider !== "ollama") {
    throw new Error("--provider must be claude or ollama");
  }
  const live = values.provider as "claude" | "ollama" | undefined;
  const effort = parseEffort(values.effort);

  let factory: ProviderFactory | null = null;
  if (live) {
    const config = loadWorkerConfig();
    factory = new ProviderFactory(
      {
        anthropic: {
          apiKey: config.llm.anthropic.apiKey,
          model: config.llm.models.claude,
          fallbackModel: config.llm.anthropic.fallbackModel,
          refusalFallbacks: config.llm.anthropic.refusalFallbacks,
        },
        local: {
          enabled: true,
          baseUrl: config.llm.localBaseUrl,
          model: config.llm.models.ollama,
        },
      },
      openGate,
      silentLogger,
    );
  }

  const fixtures = loadFixtures(fixturesDir).filter(
    (f) => !values.fixture || f.name === values.fixture || f.fixture.id === values.fixture,
  );
  let runner: CaptureRunner | null = null;
  const results: (FixtureResult & { mode: string; cost_usd?: number | null; drift?: number })[] =
    [];

  try {
    for (const f of fixtures) {
      if (f.capture) {
        let provider: LlmProvider;
        let recorder: RecordingProvider | null = null;
        let replay: ReplayProvider | null = null;
        if (factory && live) {
          provider = factory.create(live);
          if (values.record) provider = recorder = new RecordingProvider(provider);
        } else {
          // Replay a Claude recording if there is one, else a local-model one.
          const kind = loadReplies(f.capture.dir, "claude") ? "claude" : "ollama";
          const recorded = loadReplies(f.capture.dir, kind);
          if (!recorded) {
            results.push({ id: f.fixture.id, status: "no_data", failures: [], mode: "replay" });
            continue;
          }
          provider = replay = new ReplayProvider(recorded, {
            kind,
            primaryModel: `replay:${kind}`,
            fallbackModel: `replay:${kind}`,
            budgets: kind === "claude" ? CLOUD_BUDGETS : LOCAL_BUDGETS,
          });
        }
        runner ??= await CaptureRunner.start();
        const run = await runner.run(f.capture, provider, effort ? { effort } : {});
        if (recorder && !run.error) {
          const path = join(f.capture.dir, `replies.${live}.json`);
          writeFileSync(path, `${JSON.stringify(recorder.replies, null, 2)}\n`);
          console.log(`  recorded ${path}`);
        }
        const scored = run.actual
          ? scoreFixture(f.fixture, run.actual)
          : { id: f.fixture.id, status: "fail" as const, failures: [`run failed: ${run.error}`] };
        results.push({
          ...scored,
          mode: live ? `live:${live}` : "replay",
          cost_usd: run.usage.estimated_cost_usd,
          ...(replay ? { drift: replay.drift } : {}),
        });
      } else if (f.actual) {
        results.push({ ...scoreFixture(f.fixture, f.actual), mode: "actual.json" });
      } else {
        results.push({ id: f.fixture.id, status: "no_data", failures: [], mode: "-" });
      }
    }
  } finally {
    await runner?.close();
  }

  console.log("Eval results:");
  for (const r of results) {
    const badge = r.status === "pass" ? "OK  " : r.status === "fail" ? "FAIL" : "SKIP";
    const extra = [
      r.mode,
      r.cost_usd != null && r.mode.startsWith("live") ? `$${r.cost_usd}` : null,
      r.drift ? `replay drift ${r.drift}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`  [${badge}] ${r.id} (${extra})`);
    for (const failure of r.failures) console.log(`         - ${failure}`);
  }
  if (values.json) writeFileSync(values.json, `${JSON.stringify(results, null, 2)}\n`);
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("eval crashed:", err);
  process.exit(1);
});
