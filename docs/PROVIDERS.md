# Planner providers

The planner sits behind one interface (`Planner` in `server/src/planner/types.ts`), and `makePlanner` in `server/src/planner/index.ts` picks the provider. With `PLANNER` unset, a Token Plan key (`QWEN_API_KEY`) selects `qwen` on `deepseek-v4.1-flash-1017`, the setup [BENCHMARK.md](../BENCHMARK.md) measured; without one, `claude-cli` runs on `claude-haiku-5-5`. Every command (`serve`, `ask`, `probe:planner`, `eval:scenarios`) prints the provider it picked on stderr, so an eval can't run on the wrong one unnoticed. Set `PLANNER=qwen`, `PLANNER=claude-cli` or `PLANNER=codex-cli` to force one.

**A new provider is one file.** `server/src/planner/qwen.ts` is a direct HTTP provider (OpenAI-compatible chat completions, JSON-schema output, retries with backoff, timeouts) behind the same `Planner` interface. Adding it took that file and one branch in `makePlanner`; nothing in retrieval, compiling, execution or approval changed. An Anthropic API provider would be the same shape.

**Every turn has a budget** (`server/src/planner/turn.ts`): at most 8 planner calls, repairs and look-ups included, and 180 seconds. Each call's timeout is cut to whatever time the turn has left. A web client that closes the stream (a closed tab, a reload) aborts the call in flight. A turn that runs out of budget, or is cancelled, changes nothing. Approved runs are not cancelled by a disconnect.

**Every planner call is traced.** The `planner.reply` event, and `plannerCalls` on each turn in `eval/results/*.json`, record the call number, model, a hash of the system prompt and of the user prompt, wall-clock and model latency, provider attempts, model requests, whether it was a repair, and token usage.

## Qwen Token Plan (default, benchmarked)

The Qwen provider calls the Token Plan's OpenAI-compatible endpoint directly, with no CLI in
between. Get an `sk-sp-` key from the Token Plan console (Singapore only) and set it as
`QWEN_API_KEY` in your local `.env`. With `PLANNER` unset, the key alone selects this provider;
the literal `sk-sp-...` placeholder counts as no key. Then run any command from `server/`:

```sh
npm run probe:planner
npm run serve
npm run ask -- "create a task to call Jo"
```

`QWEN_MODEL` and `QWEN_FAST_MODEL` select the strong/fast models (`QWEN_MODEL` defaults to
`deepseek-v4.1-flash-1017`, `QWEN_FAST_MODEL` to `QWEN_MODEL`). Thinking is off (`enable_thinking: false`);
set `QWEN_THINKING=1` to turn it on. `QWEN_BASE_URL` defaults to
`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`; use
`QWEN_BASE_URL=https://token-plan.maas.qwencloudapi.com/compatible-mode/v1` for QwenCloud.
Token Plan keys must not be pointed at a pay-as-you-go endpoint. The adapter sends the planner
system/user messages plus the `submit_plan` JSON Schema and leaves tools out. Calls have a
120-second deadline (`QWEN_TIMEOUT_MS`), cancellation and a 4 MiB reply cap. A dropped connection,
a 5xx or a 429 with a short `Retry-After` is retried once; a quota error fails at once. A reply cut
off at the token limit or blocked by the content filter is reported as such.
Token Plan usage is prepaid, so USD cost stays unknown in the UI and reports; BENCHMARK.md prices tokens at list rates.

The reply format follows the model. Where the endpoint takes it, the request carries
`response_format: json_schema`; where it doesn't, it asks for a JSON object and puts the schema in
the system message. DeepSeek has no `json_schema` on the Token Plan and answers HTTP 400 "This
response_format type is unavailable now", so the model picks the format before the first call, and a
400 that blames the format is retried once as `json_object` and that model is remembered for the
rest of the process. `QWEN_RESPONSE_FORMAT=json_schema|json_object` pins the choice; leave it unset.
Plans are validated and repaired either way.

```sh
QWEN_MODEL=qwen3.8-flash npm run serve   # the Qwen flagship on the same key; no format flag needed
```

Measured 2026-10-25 on the module scenarios with real list rates (regression: 23 scenarios x 3
repeats; development: 45 scenarios):

| model | regression | development | median turn | $/turn |
| --- | --- | --- | --- | --- |
| qwen3.8-flash | 90.9% | 97.8% | 5.0 s / 3.2 s | 0.00044 / 0.00063 |
| deepseek-v4.1-flash-1017 (adapter default) | 95.7% | 97.8% | 1.9 s / 1.1 s | 0.00048 / 0.00065 |

DeepSeek's regression figure is the lower of two batches (the other was 98.6%) and Qwen's is a
four-batch mean; a single batch moves by 1-3 points, so read gaps under ~5 points as noise. Batches:
`eval/results/scenarios-ds-default-check-*.json`, `scenarios-base-ds-reg-3x-jo.json`,
`scenarios-reg-fix{4,5,6,7}-qf-3x.json`, `scenarios-dev-smoke-compilerfix.json`.

## Claude CLI (fallback without a Token Plan key)

`server/src/planner/claude-cli.ts` runs `claude -p` on a Claude subscription, with a clean environment, no tools and a JSON-schema output. It needs only an authenticated Claude CLI (`claude auth login`) with available quota. This project has no Anthropic API key, and a subscription login must not be used for raw API calls, so every Claude number in the git history was measured this way; the final benchmark uses DeepSeek instead.

Set `CLAUDE_MODEL` (and optionally `CLAUDE_FAST_MODEL`) for another Claude model, for example `claude-sonnet-5-5` for the strong tier. Give the full id, not the `haiku` alias: Claude CLI 2.1.284 maps the alias to `claude-haiku-4-5-20251001`, which scored 91.3% on the 23-scenario regression suite at a 23.9 s median turn, against 100% over 8 repeats at 7.2 s for `claude-haiku-5-5`. The CLI logs `claude-haiku-5-5` as `unrecognized_model` but serves it.

It has four limits:

- **Cost is an estimate.** Dollars are Claude Code's own figure at API list prices (`total_cost_usd`); nothing was billed. Input, cache-read, cache-write, output and thinking tokens are reported separately.
- **No temperature control,** so every scenario runs three times.
- **No control over cache breakpoints.** Claude Code places them. The app keeps the system prompt byte-identical between calls so the prefix can be read from cache.
- **Latency includes the CLI.** Each call starts a `claude` process (about 0.7 s). The planner answers as soon as the result JSON is printed, without waiting about 0.8 s for the process to exit, and records the CLI's reported model time (`apiMs`) beside the wall clock. The earlier Haiku benchmark had a direct p50 of 8.1 s for this reason.

## Codex subscription (optional)

Install Codex CLI and run `codex login` with ChatGPT sign-in. The adapter is verified with
CLI 0.159.0. Set `PLANNER=codex-cli` in your local `.env`, or select it for one command
from `server/`:

```sh
PLANNER=codex-cli npm run probe:planner
PLANNER=codex-cli npm run serve
PLANNER=codex-cli npm run ask -- "create a task to call Jo"
```

`CODEX_MODEL` and `CODEX_FAST_MODEL` select the strong/fast models (default `gpt-6.1-sol`).
Set both to `gpt-6-luna` to use GPT-6 Luna. `CODEX_REASONING` and `CODEX_FAST_REASONING`
accept `low`, `medium`, `high` or `xhigh` (default `low`; fast inherits strong if omitted).
Model access depends on your account. `CODEX_BIN` optionally selects an executable;
`CODEX_HOME` may select your existing CLI authentication directory.
Card generation stays on Claude so its provenance stamp remains accurate.
GPT-6.1 Sol and GPT-6 Luna were used through it during development; the benchmark numbers are DeepSeek's.

The adapter uses the Codex runtime, rather than raw model API calls. It supplies our planner
instructions, request and output schema, while Codex adds runtime framing. **The captured request
still advertised skills and tools despite the disabling flags.** Do not treat the adapter as a tool-free or prompt-only inference boundary.

This is a trusted local development provider. It strips inherited API credentials, checks the
current login before enforcing ChatGPT authentication, uses a private working directory and
read-only sandbox, and requests restricted runtime capabilities. Unexpected tool events and
configuration errors fail the request; this cannot undo any tool action already started by
the runtime. Keep it out of public or untrusted services. For raw API-key calls, use the Qwen
provider above.

Calls have a 120-second deadline, bounded output, cancellation and temporary-file cleanup.
Subscription usage consumes your shared allowance; USD cost remains unknown in the UI, scenario
results and benchmark reports, with no automatic API fallback. The app still validates plans
and owns CRM execution and confirmation. See the
[official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
