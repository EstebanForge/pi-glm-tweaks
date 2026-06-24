# @estebanforge/pi-glm-tweaks

Pi-native tweaks for Z.AI's **GLM-5.2**. Restricts the Pi thinking-level UI to the three modes GLM-5.2 actually supports (**off**, **high**, **max**), wires the native `thinkingFormat:"zai"` translation, and auto-clamps any stale level when the model is selected.

## Install

```
pi install npm:@estebanforge/pi-glm-tweaks
```

Works with Pi's built-in `zai/glm-5.2` model out of the box, or a custom entry in `~/.pi/agent/models.json`. The extension re-registers it with the OpenAI-compat endpoint and the proper thinking map. Other Z.AI models (`zai/glm-4.7`, `zai/glm-5-turbo`, `zai/glm-5.1`, plus any custom entries) are preserved across the re-registration.

## What it does

GLM-5.2 ships three thinking modes (per [docs.z.ai](https://docs.z.ai/guides/capabilities/thinking)):

| Pi thinking level | GLM-5.2 wire |
| --- | --- |
| `off` | `thinking: { type: "disabled" }` |
| `high` | `thinking: { type: "enabled" }` + `reasoning_effort: "high"` |
| `max` (Pi `xhigh`) | `thinking: { type: "enabled" }` + `reasoning_effort: "max"` |

Pi natively exposes six thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). GLM-5.2 doesn't really fit the middle four — `low`/`medium` get mapped to `high` server-side, `minimal` skips thinking, and `xhigh` is the only way to reach `reasoning_effort: "max"`.

This extension collapses that mismatch:

1. **Re-registers `zai/glm-5.2`** on `session_start` with `api: "openai-completions"`, `baseUrl: https://api.z.ai/api/coding/paas/v4`, `compat.thinkingFormat: "zai"`, and a tight `thinkingLevelMap`:
   ```ts
   {
     minimal: null,  // hidden
     low: null,      // hidden
     medium: null,   // hidden
     high:   "high", // → reasoning_effort: "high"
     xhigh:  "max",  // → reasoning_effort: "max"
     // off omitted → supported, sends thinking.type = "disabled"
   }
   ```
2. **Auto-clamps on `model_select`** — if the current level is one we hid (e.g. you switched from a model that allowed `medium`), quietly bump to `high` and notify.
3. **Footer hint** — sets `ctx.ui.setStatus("glm-thinking", "thinking: off | high | max")` while GLM-5.2 is the active model.

`Shift+Tab`, `/thinking`, and the level picker all see only the three GLM-5.2 modes.

## Token-efficiency tweaks

GLM-5.2 overthinks on long agent loops — it can spend an entire turn on `reasoning_content` without taking a tool call. The Z.AI API does not expose a `max_thinking_tokens` parameter, so the post that popularised this observation does it at the provider layer (mid-stream injection). We can't intercept the stream, but we can approximate the win with three cheap, opt-out tweaks:

| Flag | Default | What it does |
| --- | --- | --- |
| `glm-budget-nudge` | `true` | (a) Appends a soft thinking-budget fragment to the system prompt on every zai/glm-5.2 turn. (b) Per LLM call, sums `reasoning_content` across prior assistant messages in the current agent loop (the one started by the most recent user prompt); if cumulative exceeds ~2000 characters (roughly 500 English tokens), injects a one-shot hint to push the model back toward tool calls. Fires at most once per loop. The hint appears in the conversation panel as a user message prefixed `[system reminder: ...]` — that is intentional, so you can see when the ratchet fired. |
| `glm-clear-thinking` | `true` | Forces `clear_thinking: true` on every request. The coding endpoint (`api.z.ai/api/coding/paas/v4`) defaults to preserved thinking, which silently compounds `reasoning_content` across turns. At $4.4/MTok output, this is real money. |
| `glm-quick-disable` | `true` | For user prompts under 80 chars, forces `thinking.type: "disabled"` for that turn. Trivial questions ("what time is it") don't need deep thinking. |

All three flags surface in `pi config` and Pi's flag editor — `pi config set glm-budget-nudge false` to disable.

### What the tweaks cannot do

- Cap thinking tokens at a wire level. Z.AI does not expose a thinking budget param.
- Inject text mid-stream. No Pi hook for streaming chunk mutation.
- Force the model to call a tool. The system prompt can ask; nothing forces it.
- Lower `reasoning_effort` per-request. Per [KiwiGaze/glm-for-copilot #7](https://github.com/KiwiGaze/glm-for-copilot/issues/7) it's a no-op on `/chat/completions`.

## Why this exists

Pi's built-in `thinkingFormat: "zai"` (in `openai-completions.js`) already knows the wire translation. The catch is that GLM-5.2's user-defined model in `models.json` typically lacks a `thinkingLevelMap`, so the UI shows all six levels and sends invalid combinations on hidden ones. This extension fills that gap automatically — no manual `models.json` editing.

## Compatibility

- Pi (`@earendil-works/pi-coding-agent`) — any version with `registerProvider` taking effect post-bind and `thinkingFormat: "zai"` support, plus the `before_agent_start` / `context` / `before_provider_request` / `registerFlag` hooks.
- Z.AI API key — resolved through Pi's standard auth storage (env var `ZAI_API_KEY`, `/login`, or `models.json` provider `apiKey`). The extension does not configure auth.

## License

MIT