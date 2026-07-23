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
4. **`/glm-tweaks` command** — status panel + flag toggle from inside Pi (see [`/glm-tweaks` command](#glm-tweaks-command)).

`Shift+Tab`, `/thinking`, and the level picker all see only the three GLM-5.2 modes.

## Token-efficiency tweaks

GLM-5.2 overthinks on long agent loops — it can spend an entire turn on `reasoning_content` without taking a tool call. The Z.AI API does not expose a `max_thinking_tokens` parameter, so the post that popularised this observation does it at the provider layer (mid-stream injection). We can't intercept the stream, but we can approximate the win with three opt-in tweaks.

**Two of the three default OFF; `glm-budget-nudge` defaults ON.** Per [docs.z.ai Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode), Preserved Thinking (`clear_thinking: false`) is **on by default on the coding endpoint** precisely because it "increases cache hit rates — saving tokens in real tasks." The budget nudge keeps that property (it appends a fixed fragment, so the prefix stays byte-stable); `glm-clear-thinking` and `glm-skip-short-thinking` do not, so they stay opt-in for users who have measured that thinking tokens, not cache misses, are their real cost driver.

| Flag | Default | What it does |
| --- | --- | --- |
| `glm-budget-nudge` | `true` | Appends a constant thinking-budget fragment to the system prompt on every zai/glm-5.2 turn, steering the model toward committing to a tool call before it spirals into overthinking. **Cache:** safe — the fragment is a fixed string, so the appended system prompt stays byte-identical turn to turn and the cached prefix is reused. (The earlier mid-loop ratchet appended a reactive `[system reminder: ...]` message after the last tool result; that hint sat between the cached prefix and the model's next turn, displacing it from the cache and forcing a one-time re-ingest. It fired when reasoning was largest, so it is gone.) |
| `glm-clear-thinking` | `false` | Forces `clear_thinking: true` on every request, opting out of z.ai Preserved Thinking. Preserved Thinking is the coding endpoint's default and is what keeps the prefix byte-stable across turns (so it caches). Disabling it re-bills the full prefix every turn — usually a net loss. |
| `glm-skip-short-thinking` | `false` | For user prompts under 80 chars, forces `thinking.type: "disabled"` for that turn. **Cache:** toggling thinking on/off across turns based on prompt length changes the reasoning_content sequence z.ai caches, so follow-up turns on the same session re-bill instead of hitting the cached prefix. |

All three flags surface in `pi config` and Pi's flag editor — `pi config set glm-clear-thinking true` to enable one of the opt-ins. Or flip them from inside Pi with `/glm-tweaks`.

## `/glm-tweaks` command

An in-session command for inspecting and flipping the flags above without leaving Pi.

| Invocation | Effect |
| --- | --- |
| `/glm-tweaks` (TUI) | Opens an interactive settings menu (the same `SettingsList` component `/settings` uses). Flip any combination of flags, then a single reload fires on close to apply them all. |
| `/glm-tweaks` (non-TUI / RPC) | Falls back to a read-only status panel (active model, thinking level vs the `off \| high \| max` map, and each flag's on/off state). |
| `/glm-tweaks toggle <flag>` | One-shot flip: persists, then reloads. |
| `/glm-tweaks <flag>` | Shorthand one-shot toggle (flag name without the `toggle` keyword). |

The command offers tab-completion for `toggle` and the three flag names.

**Why a reload per apply.** Pi's extension API exposes `getFlag` but no live `setFlag`, and flag values are read into memory at load time. So changes persist via `pi config set` and a `/reload` picks them up. The interactive menu stages all your flips and reloads once on close; the one-shot toggle reloads immediately. In both cases the command notifies (`Applied 2 change(s). Reloading...`) before reloading. If you'd rather avoid reload churn entirely, set flags directly in `pi config` / the flag editor and reload once at your convenience.

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