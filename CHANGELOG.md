# Changelog

## 1.0.0 — 2026-06-24

Initial release. Pi-native tweaks for Z.AI's GLM-5.2.

### Thinking-level UI restriction
- `session_start` hook re-registers `zai/glm-5.2` with the OpenAI-compat
  endpoint (`https://api.z.ai/api/coding/paas/v4`) and a tight
  `thinkingLevelMap` exposing only the three GLM-5.2-supported levels:
  `off`, `high` (Pi `high` → `reasoning_effort: "high"`), and `max` (Pi
  `xhigh` → `reasoning_effort: "max"`). Minimal / low / medium are hidden.
- `model_select` hook auto-clamps a stale hidden level to `high` and
  shows a notification, then sets the footer status to
  `thinking: off | high | max`.
- Native `thinkingFormat: "zai"` so Pi's openai-completions transport
  emits the correct `thinking: { type }` and `reasoning_effort` fields
  without any custom payload rewriting.

### Token-efficiency tweaks
- **`before_agent_start` hook**: appends a soft thinking-budget fragment
  to the system prompt on every zai/glm-5.2 turn (cap thinking at ~500
  tokens, take tool calls every 200-300 thinking tokens). The fragment
  is appended via `event.systemPrompt + fragment` so other extensions
  (pi-go-review, pi-rust-review, CLAUDE.md loaders) still see their
  upstream prompt.
- **`context` hook** (intra-loop ratchet): sums `reasoning_content` from
  prior assistant messages in the current agent loop (the one started
  by the most recent user prompt). If cumulative exceeds ~2000 characters
  (roughly 500 English tokens), injects a one-shot user-side hint to
  push the model back toward tool calls. Fires at most once per loop.
- **`before_provider_request` hook**: per-request payload mutation guarded
  on `ctx.model` so tweaks never bleed onto other models in multi-model
  sessions. Two wirings:
  - Forces `thinking.clear_thinking: true` on every request. The coding
    endpoint defaults to preserved thinking, which silently compounds
    `reasoning_content` across turns. At $4.4/MTok output, this is real
    money saved.
  - On user prompts under 80 chars, forces `thinking.type: "disabled"`
    for that turn. Trivial questions don't need deep thinking.
- **Three Pi-idiomatic flags** (auto-surface in `pi config`):
  - `glm-budget-nudge` (default `true`)
  - `glm-clear-thinking` (default `true`)
  - `glm-quick-disable` (default `true`)

### What the tweaks cannot do
- Cap thinking tokens at a wire level (Z.AI does not expose a budget param).
- Inject text mid-stream (no Pi hook for streaming chunk mutation).
- Force a tool call (system prompt can ask; nothing enforces it).
- Lower `reasoning_effort` per-request — per
  [KiwiGaze/glm-for-copilot #7](https://github.com/KiwiGaze/glm-for-copilot/issues/7)
  it is a no-op on `/chat/completions`.

### Notes
- Idempotent: re-registering on every `session_start` is cheap and keeps
  the model in sync if `models.json` is edited between sessions.
- Auth is untouched — the extension relies on the standard ZAI auth
  resolution (`ZAI_API_KEY`, `/login`, or `models.json` `apiKey`).
- `registerFlag` calls live at the factory top-level (static setup), not
  inside `session_start` — otherwise user preferences would reset on
  every `/new` or `/reload`.
- `baseUrl` is set both at provider level (required by validation) and
  per-model in `GLM52_MODEL` (per-model wins at request time, so any
  custom `baseUrl` the user has on other `zai/*` models is preserved).