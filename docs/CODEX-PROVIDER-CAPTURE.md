# Codex provider: actual request capture

Captured on 2026-10-22 using Codex CLI **0.159.0**, **gpt-6-luna**, low reasoning,
and the existing `CodexCliPlanner`. The synthetic request created a contact plan
for Jo Park, using the real planner instructions/schema and one action card.

## Findings

| Aspect | Intended direct LLM request | Captured Codex request |
| --- | --- | --- |
| Custom planner instructions | Our instructions | Preserved verbatim as a developer message |
| User prompt | Our CRM input | Preserved verbatim |
| Output schema | Our submit-plan schema | Unchanged |
| Extra instructions | None | Skills, permissions, collaboration mode and agent-coordination instructions |
| Tool definitions | Empty | 10 definitions, including `functions.exec` and `collaboration.spawn_agent` |
| `tool_choice` | `none` | `auto` |
| Environment context | Our CRM context/clock | Additional working directory, shell, date and timezone |
| Serialized body | 6,252 bytes | 30,153 bytes (~4.8×; this is not a token estimate) |

**The current disabling flags did not remove all model-visible skills and tools
in this runtime. Do not describe this provider as a raw, prompt-only, tool-free
LLM call.** Our custom prompt is used, but the full request includes additional
Codex context. Advertised tools do not prove those tools could successfully
execute; execution capability was not tested by this capture.

The request reached OpenAI and returned the expected structured contact plan.
No CRM handler ran. This successful example does not establish that the extra
context is harmless for other requests or that other CLI versions behave alike.

## Capture method and evidence

A temporary per-process `openai_base_url` override routed the CLI through a
loopback WebSocket relay to the normal ChatGPT Codex endpoint. Compression was
disabled for inspection. Two client messages were captured: a `generate:false`
prewarm, then the actual inference request summarized above. No authorization or
account headers were saved. The capture does not reveal server-side additions.

Local evidence (not tracked in this repository):

`/Users/tejas/.codex/visualizations/2026/10/22/01a16310-2174-74d2-944e-34d60938717b/codex-request-capture/`

Key files: `actual-request.json`, `desired-request.json`, `comparison.json`,
`model-response.json`, and the reproducible capture script `capture.mts`.
