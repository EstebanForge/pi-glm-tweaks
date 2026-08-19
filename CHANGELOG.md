# Changelog

## 1.4.0 — 2026-08-19

### Added
- **API route selection (`glm-api-route`: `coding` | `anthropic`).** Both
  z.ai GLM Coding Plan protocols are now user-selectable per installation
  (same key, same credits — [docs](https://docs.z.ai/devpack/quick-start)):
  - `coding` (default, unchanged): OpenAI Chat Completions at
    `api.z.ai/api/coding/paas/v4` with implicit prefix caching and the
    documented `thinking` + `reasoning_effort` contract.
  - `anthropic`: Anthropic Messages at `api.z.ai/api/anthropic`, activating
    Pi's native `cache_control` breakpoints. Verified by live probe: a
    repeated ~122k-token prefix read 122,560/122,581 tokens from cache.
    Thinking is translated per-request to z.ai's probed shape
    (`thinking: {type: "enabled", reasoning_effort: "low|high|max"}` —
    nested, never `disabled`, which the endpoint silently ignores).
  - Switch via `/glm-tweaks route <coding|anthropic>` or the interactive
    menu; applied through the existing persist + reload path.
- Footer chip showing the active route (`OAI` / `ANT`) next to the thinking
  chip, cleared on non-GLM model select.
- `lib/flag-settings.ts` widened to `boolean | string` values
  (`loadSettings` / `loadStringSettings` / `saveSetting`); pre-1.4 settings
  files load unchanged.
- Tests for route registration, thinking replacement, the
  disabled-silent-ignore hazard, coding-route isolation, and the
  cross-session settings-flip regression.

### Notes
- **Peer-reviewed** (two rounds): the anthropic request-shape branch keys
  off the registered model's `api` field, not a fresh settings read, so a
  concurrent pi session flipping the route on disk cannot miswire another
  session's requests. `supportsLongCacheRetention` is pinned `false` on the
  anthropic route until z.ai documents `ttl:"1h"`.
- The anthropic route reports `cache_read_input_tokens` but no
  `cache_creation_input_tokens`, so Pi's cache-write column reads 0 there
  (display only; cached tokens still bill at the discounted rate).
- Switching routes mid-conversation replays prior turns' reasoning as plain
  text (Pi degrades thinking blocks without signatures on replay); start a
  fresh session for a clean A/B.

## 1.3.0 — 2026-08-14

### Added
- **GLM-5.3 support.** New `MODEL_SPECS` table drives everything: the
  extension now patches `glm-5.2`, `glm-5.3`, and the 1M-context
  `glm-5.3[1m]` Coding Plan route, each with its own thinking map. GLM-5.3
  removed `thinking.type: "disabled"` (direct API rejects it) and added a
  real `low` wire level, so 5.3 maps Pi `off`/`low` to
  `thinking enabled + reasoning_effort: "low"` (z.ai's documented
  migration) and hides `minimal`/`medium`. Footer hint and clamp messages
  are derived per model (`low | high | max` on 5.3, `off | high | max` on
  5.2).
- `glm-skip-short-thinking` on 5.3 now forces `enabled` + `low` instead
  of the rejected `disabled`.
- Tests: session_start registration coverage for the multi-spec build
  (5.3 map, pass-through of untargeted models, no-op when no target).
- **Forward compatibility for glm-5.4+.** `resolveSpec()`: an unknown
  `glm-5.N` with N >= 3 (including `[1m]`) inherits the glm-5.3 spec, so a
  rushed 5.4 release works day one. Explicit `MODEL_SPECS` entries always
  win; glm-4.x and future glm-6 are excluded (unknown wire contracts).
- **Request-layer `disabled` guard for 5.3+** (peer-review fix): Pi's zai
  transport (openai-completions.js) sends `thinking.type:"disabled"`
  whenever the reasoning effort is undefined — exactly the Pi level-`off`
  path — and the model's `thinkingLevelMap` is never consulted there, so
  the map's `off:"low"` entry alone could not prevent a rejected request.
  `before_provider_request` now unconditionally rewrites `disabled` to
  `enabled` + `reasoning_effort:"low"` on any spec with
  `canDisableThinking: false`. New test exercises the wire payload
  directly (5.3 rewritten, 5.2 untouched).

## 1.2.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.2.0 — 2026-07-23

### Changed
- **Token-efficiency flags rebalanced for cache safety.**
  `glm-clear-thinking` and `glm-skip-short-thinking` now default OFF, and
  `glm-budget-nudge` defaults ON but cache-safe. All three shipped defaulting
  to ON in 1.1.x, and each broke the z.ai server cache in a different way.
  Per [z.ai Thinking Mode docs](https://docs.z.ai/guides/capabilities/thinking-mode),
  Preserved Thinking (`clear_thinking: false`) is **on by default on the
  coding endpoint** specifically because it "increases cache hit rates —
  saving tokens in real tasks" by keeping `reasoning_content` byte-identical
  across turns.
  - `glm-clear-thinking` forced `clear_thinking: true`, stripping
    `reasoning_content` each turn so the next-turn prefix no longer
    byte-matched the server cache (full re-bill, e.g. "Cache miss: 140k
    tokens re-billed"). Now defaults OFF.
  - `glm-budget-nudge` rewrites the system prompt every turn and (in 1.1.x)
    appended a reactive `[system reminder: ...]` user message after the last
    tool result when the ratchet fired. The constant fragment append is
    cache-safe on its own; the ratchet is not (see Removed), so the ratchet
    is gone and the flag keeps just the fragment, defaulting ON.
  - `glm-skip-short-thinking` toggles `thinking.type` between `enabled` and
    `disabled` turn-to-turn (request-shape change). Now defaults OFF.

  Existing users who persisted a value via `/glm-tweaks` keep their choice —
  the file-backed store still wins over the default. **Users who never ran
  `/glm-tweaks` were silently running the 1.1.x behavior (fragment + ratchet
  + clear-thinking + skip-short, all ON);** after upgrading they get the
  fragment only. Re-enable the others with `/glm-tweaks` or
  `pi config set <flag> true`.

### Removed
- **Mid-loop ratchet injection deleted.** Previously, when cumulative
  `reasoning_content` in the current agent loop exceeded ~2000 chars, the
  `context` hook appended a `[system reminder: ...]` user message after the
  last tool result to push the model toward a tool call. The hint sat between
  the cached prefix and the model's about-to-generate next turn, displacing
  that turn from the next call's cache-reusable prefix and forcing a
  one-time re-ingest of the fired turn's tokens (a one-shot cost, not a
  per-turn re-bill — the hint was ephemeral and gone from the next call). It
  also fired precisely when reasoning was largest, so it re-ingested the
  biggest block — the opposite of the intent. The upfront system-prompt
  fragment covers the same intent (steer toward a tool call before
  overthinking) without displacing the cached tail, so the reactive ratchet
  is gone. The `RATCHET_THRESHOLD_CHARS` constant and the `loop.ratchetFired`
  field are removed with it.

## 1.1.2 — 2026-07-21

### Fixed
- **Flag toggles no longer crash.** `/glm-tweaks <flag>` and the
  `/glm-tweaks` menu both tried to persist via `pi config set`, which is
  not a real command (`pi config` only accepts `-l/--approve/--no-approve`;
  any positional arg throws "Unexpected argument" and exits 1). Every toggle
  therefore failed with `Failed to apply: <flag>`.
  - Flags now persist to a tiny file-backed store (`<piDir>/pi-glm-tweaks.json`,
    `piDir = PI_CODING_AGENT_DIR || ~/.pi/agent`), seeded into `registerFlag`
    at load. `pi config set` is gone; toggles call `saveFlagSetting` then
    `/reload` (the reload re-seeds the flag from disk).
  - Settings now survive a full pi restart too — the old mechanism never
    persisted at all (extension flags are in-memory only; there is no CLI for
    them).
- New `lib/flag-settings.ts` mirrors the file-backed pattern already proven in
  `pi-asana` and `pi-slack-me`. `lib/` added to the published `files`.

## 1.1.1 — 2026-06-24

### Added
- **`/glm-tweaks` slash command** — in-session flag management.
  - **`/glm-tweaks` (TUI):** opens an interactive `SettingsList` menu — the
    same component `/settings` uses — so users can navigate and flip
    multiple flags in one visit. Changes stage in-memory; a single reload
    fires on close to apply them all.
  - **`/glm-tweaks` (non-TUI / RPC):** falls back to a read-only status
    panel (active model, thinking level vs the `off | high | max` wire map,
    each flag's on/off state). Custom components are terminal-only.
  - **`/glm-tweaks toggle <flag>`** (shorthand: `/glm-tweaks <flag>`):
    one-shot flip — persists via `pi config set`, then reloads.
  - Tab-completion for `toggle` and the three flag names, including after
    a trailing space.
  - Necessitated by the API surface: Pi's extension API exposes `getFlag`
    but no live `setFlag`, so changes persist via `pi config set` and a
    `/reload` picks them up. Flags remain editable via `pi config` / the
    flag editor without the command.
- Consolidated the three flags into a single `FLAGS` source-of-truth const
  (name, label, description) driving `registerFlag`, the menu, autocomplete,
  and the toggle.

### Changed
- Added `@earendil-works/pi-tui` as a devDependency so `SettingsList` /
  `Text` / `Container` / `SettingItem` resolve at type-check time (runtime
  re-aliases to Pi's bundled copy via the extension loader).

### Notes
- **Interactive menu error handling:** the persist loop checks `result.code`
  per flag, collects failures, and errors out without reloading if any
  write failed. Net-zero flips (a flag toggled on then off) are filtered
  against the live value, so reload only fires when something actually
  moved.
- **Intra-loop ratchet:** the `context` hook sums assistant thinking from
  `content[]` `ThinkingContent` blocks (`{type:"thinking", thinking:string}`)
  in the current agent loop, injecting a one-shot hint past ~2000 chars.
  Still needs confirmation against a live zai/glm-5.2 loop where thinking
  actually surfaces in `event.messages`.

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
- **`context` hook** (intra-loop ratchet): sums assistant thinking from
  `content[]` `ThinkingContent` blocks in prior messages in the current
  agent loop (the one started by the most recent user prompt). If
  cumulative exceeds ~2000 characters (roughly 500 English tokens),
  injects a one-shot user-side hint to push the model back toward tool
  calls. Fires at most once per loop.
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
  - `glm-skip-short-thinking` (default `true`)

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