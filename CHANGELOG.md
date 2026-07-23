# Changelog

## 1.2.0 — 2026-07-23

### Changed
- **All three token-efficiency flags now default OFF.** `glm-budget-nudge`,
  `glm-clear-thinking`, and `glm-skip-short-thinking` shipped defaulting to
  `true` in 1.1.x. Per [z.ai Thinking Mode docs](https://docs.z.ai/guides/capabilities/thinking-mode),
  Preserved Thinking (`clear_thinking: false`) is **on by default on the
  coding endpoint** specifically because it "increases cache hit rates —
  saving tokens in real tasks." All three flags undermine that caching:
  - `glm-clear-thinking` forces `clear_thinking: true`, stripping
    `reasoning_content` each turn so the next-turn prefix no longer
    byte-matches the server cache (full re-bill, e.g. "Cache miss: 140k
    tokens re-billed").
  - `glm-budget-nudge` rewrites the system prompt every turn (prefix drift)
    and injects a timestamped `[system reminder: ...]` user message when the
    ratchet fires (non-deterministic prefix).
  - `glm-skip-short-thinking` toggles `thinking.type` between `enabled` and
    `disabled` turn-to-turn (request-shape change).

  Existing users who persisted a value via `/glm-tweaks` keep their choice —
  the file-backed store still wins over the default. **Users who never ran
  `/glm-tweaks` were silently running all three tweaks ON under 1.1.x** (that
  was the implicit default); after upgrading they flip to OFF. If you were
  relying on them, re-enable with `/glm-tweaks` or
  `pi config set <flag> true`. New installs get the cache-safe defaults.

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