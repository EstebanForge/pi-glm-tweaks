/**
 * pi-glm-tweaks — Pi-native tweaks for Z.AI's GLM coding models
 * (glm-5.2, glm-5.3, glm-5.3[1m]).
 *
 * Restricts the Pi thinking-level UI to the modes each GLM model actually
 * supports, wires the native `thinkingFormat: "zai"` wire
 * translation, auto-clamps hidden levels, and applies token-efficiency
 * hygiene (per-turn system-prompt nudge, wire-level
 * clear_thinking and skip-short-thinking).
 *
 * Wire map (see https://docs.z.ai/guides/capabilities/thinking and
 * providers/openai-completions.js in pi-ai):
 *
 *   glm-5.2 (thinking can be disabled):
 *     Pi level  | thinking.type | reasoning_effort
 *     ----------|---------------|------------------
 *     off       | "disabled"    | (omitted)
 *     high      | "enabled"     | "high"
 *     xhigh     | "enabled"     | "max"
 *
 *   glm-5.3 / glm-5.3[1m] (thinking always on; thinking.type:"disabled"
 *   removed in 5.3 — direct API rejects it; migration is enabled +
 *   reasoning_effort "low"):
 *     Pi level  | thinking.type | reasoning_effort
 *     ----------|---------------|------------------
 *     off       | "enabled"     | "low"   (enforced by the request-layer
 *     low       | "enabled"     | "low"    guard below, NOT the map — Pi's
 *     high      | "enabled"     | "high"   zai transport sends "disabled"
 *     xhigh     | "enabled"     | "max"    whenever effort is undefined)
 *
 * Hidden levels are Pi-side concepts that don't map cleanly to the wire
 * (5.2: low/medium map server-side to "high", minimal is a no-op for Pi's
 * reasoning transport; 5.3: minimal/medium have no wire counterpart).
 * Showing them invites accidental footguns.
 *
 * Behavior:
 *   - On session_start, re-register the `zai` provider with every targeted
 *     GLM model redefined against the OpenAI-compat endpoint and its tight
 *     thinkingLevelMap. registerProvider takes effect immediately after
 *     bindCore (no /reload).
 *   - On model_select to a targeted zai model, clamp a stale hidden level
 *     to a supported one and notify. Set the footer status hint.
 *   - On model_select to any other model, clear the footer status.
 *   - On every user turn, inject a soft system-prompt budget fragment
 *     (`glm-budget-nudge`, default OFF — rewrites the system prompt every
 *     turn, which drifts the cached prefix).
 *   - Per LLM call, count cumulative reasoning_content; if over a
 *     threshold, inject a one-shot user-side hint to push the model back
 *     toward tool calls (`glm-budget-nudge`).
 *   - On every outgoing request, force `clear_thinking: true`
 *     (`glm-clear-thinking`, default OFF). The coding endpoint ships Preserved
 *     Thinking ON by default precisely to maximize cache hit rates (see
 *     z.ai Thinking Mode docs); forcing it off re-bills the full prefix
 *     every turn.
 *   - On short user prompts (<80 chars), use the lightest thinking mode
 *     to save tokens on trivial turns (`glm-skip-short-thinking`, default
 *     OFF — toggling request shape turn-to-turn reduces cache hits).
 *     glm-5.2: thinking.type="disabled"; glm-5.3: thinking stays enabled
 *     with reasoning_effort="low" (5.3 rejects "disabled").
 *
 * Auth is untouched. The provider's existing key (ZAI_API_KEY env, /login,
 * or models.json apiKey) continues to resolve against the new baseUrl.
 */
import { getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { loadFlagSettings, saveFlagSetting } from "../lib/flag-settings";

const PROVIDER = "zai";
const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

// Per-model tweaks table. One entry per targeted zai model id; everything
// downstream (re-registration, UI hiding, clamping, footer hint, wire
// mutation) derives from this map, so adding the next GLM release is a
// one-entry change (plus whatever z.ai changed on the wire).
interface GlmSpec {
	/** Display name for the re-registered model entry. */
	name: string;
	/** Pi thinking level -> wire reasoning_effort (null = hide in UI). */
	thinkingLevelMap: Record<string, string | null>;
	/**
	 * Whether `thinking.type: "disabled"` is legal for this model. True for
	 * glm-5.2; false for glm-5.3, which removed "disabled" — the direct API
	 * fails such requests (migration: enabled + reasoning_effort "low").
	 */
	canDisableThinking: boolean;
}

const MODEL_SPECS: Record<string, GlmSpec> = {
	"glm-5.2": {
		name: "GLM-5.2",
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		canDisableThinking: true,
	},
	"glm-5.3": {
		name: "GLM-5.3",
		thinkingLevelMap: { off: "low", minimal: null, medium: null, low: "low", high: "high", xhigh: "max" },
		canDisableThinking: false,
	},
	// 1M-context Coding Plan route (same model, bigger window).
	"glm-5.3[1m]": {
		name: "GLM-5.3 (1M)",
		thinkingLevelMap: { off: "low", minimal: null, medium: null, low: "low", high: "high", xhigh: "max" },
		canDisableThinking: false,
	},
};

// Forward-compat fallback: z.ai iterates GLM-5.x fast (5.2 -> 5.3 was one
// month apart) and 5.3 set the new contract (thinking always on, wire levels
// low|high|max). An UNKNOWN glm-5.N where N >= 3 inherits the 5.3 spec so a
// rushed 5.4 works on day one instead of falling back to Pi's unpatched
// six-level UI. Explicit MODEL_SPECS entries always win, so when 5.4's real
// contract is known a one-entry edit overrides the fallback. Deliberately
// NOT applied to glm-4.x or a future glm-6: those are unknown contracts,
// and guessing a wire shape there can send invalid requests.
// Note: \d+ also matches multi-digit minors (a hypothetical glm-5.10),
// which correctly sorts above 5.3 numerically — intended.
const FALLBACK_MIN_MINOR = 3;

function resolveSpec(id: string): GlmSpec | undefined {
	const exact = MODEL_SPECS[id];
	if (exact) return exact;
	const m = /^glm-5\.(\d+)(\[1m\])?$/.exec(id);
	if (m && Number(m[1]) >= FALLBACK_MIN_MINOR) {
		const base = MODEL_SPECS[m[2] ? "glm-5.3[1m]" : "glm-5.3"];
		return { ...base, name: id };
	}
	return undefined;
}

// Pi thinking levels hidden in the UI for a spec: every map entry mapped to
// null. Listed explicitly in the map so it stays grep-friendly.
function hiddenLevels(spec: GlmSpec): Set<string> {
	return new Set(Object.entries(spec.thinkingLevelMap).filter(([, v]) => v === null).map(([k]) => k));
}

// Wire-facing labels for the footer hint and the clamp notification. Order:
// "off" first when the spec supports disabling thinking, then the distinct
// reasoning_effort values in map order (5.2: off|high|max, 5.3: low|high|max).
function wireLabels(spec: GlmSpec): string[] {
	const labels = new Set<string>(spec.canDisableThinking && !("off" in spec.thinkingLevelMap) ? ["off"] : []);
	for (const v of Object.values(spec.thinkingLevelMap)) if (v !== null) labels.add(v);
	return [...labels];
}

// Token-efficiency tuning constant. Hardcoded for v1 — exposed as a flag
// would be over-engineering for a single-model extension.
const SHORT_PROMPT_THRESHOLD = 80;

// Token-efficiency flags. Single source of truth — drives registerFlag,
// the /glm-tweaks status display, autocomplete, and the toggle subcommand.
// glm-budget-nudge defaults ON (cache-safe: it appends a fixed fragment to
// the system prompt, so the prefix stays byte-identical turn to turn and the
// z.ai server cache is reused). The other two default OFF because they
// undermine the coding endpoint's Preserved Thinking caching
// (see docs.z.ai/guides/capabilities/thinking-mode). Users who want them can
// opt in via /glm-tweaks.
const FLAGS = [
	{
		name: "glm-budget-nudge",
		label: "Budget nudge",
		default: true,
		description:
			"Append a constant thinking-budget fragment to the system prompt on every targeted zai GLM turn (glm-5.2, glm-5.3, glm-5.3[1m]), steering the model toward committing to a tool call before overthinking. Cache-safe: the fragment is a fixed string, so the appended system prompt stays byte-identical turn to turn and the cached prefix is reused. (The earlier mid-loop ratchet appended a reactive hint message after the last tool result; the hint sat between the cached prefix and the model's next turn, displacing that turn from the cache and forcing a one-time re-ingest. It fired precisely when reasoning was largest, so it is gone.)",
	},
	{
		name: "glm-clear-thinking",
		label: "Clear thinking",
		default: false,
		description:
			"Force thinking.clear_thinking=true on every request, opting out of z.ai Preserved Thinking. Cache: Preserved Thinking (clear_thinking=false) is the coding endpoint's default because it keeps reasoning_content byte-identical across turns, which is exactly what the server caches; disabling it strips reasoning each turn so the next turn's prefix no longer matches the cache → full re-bill (e.g. 'Cache miss: 140k tokens re-billed').",
	},
	{
		name: "glm-skip-short-thinking",
		label: "Skip short thinking",
		default: false,
		description:
			"For user prompts under 80 chars, use the lightest thinking mode for that turn: glm-5.2 gets thinking.type=disabled; glm-5.3 gets thinking.type=enabled + reasoning_effort=low (5.3 rejects \"disabled\"). Cache: toggles thinking intensity across turns based on prompt length, which changes the reasoning_content sequence z.ai caches; follow-up turns on the same session re-bill instead of hitting the cached prefix.",
	},
] as const;

// Soft system-prompt fragment appended to every targeted zai GLM turn when
// the budget-nudge flag is on. No "I'm overthinking" ack string — that's
// unenforceable (model may or may not emit it, may emit it in Chinese,
// and we'd have to detect it).
const BUDGET_FRAGMENT = `

<glm-thinking-budget>
You are operating under a per-turn thinking budget. Behave accordingly:
- Cap each thinking block at ~500 tokens. Don't ruminate; commit to a tool call or response.
- Take a tool call every 200-300 thinking tokens. Don't sit and speculate without acting.
- Prefer a concrete tool call over further internal deliberation.
</glm-thinking-budget>`;

// Build the re-registered model entry for a targeted GLM id. `cost`
// mirrors the built-in (Z.AI does not publish per-token rates at the same
// time as launches; zeros is conservative). thinkingLevelMap doubles as
// UI-hide (`null`) and wire-level safety net: Pi's zai branch in
// openai-completions.js reads this map for reasoning_effort, and a null
// entry produces no reasoning_effort field on the wire. baseUrl is
// per-model (not provider-level) so we don't override any custom baseUrl
// the user may have set on other `zai/*` models. contextWindow stays 1M:
// glm-5.2 documented 1M, glm-5.3 same base with the [1m] Coding Plan route;
// the base 5.3 standard-API window was unpublished at launch.
function buildGlmModel(id: string, spec: GlmSpec) {
	return {
		id,
		name: spec.name,
		api: "openai-completions",
		baseUrl: ZAI_CODING_BASE_URL,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: spec.thinkingLevelMap,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			thinkingFormat: "zai" as const,
			zaiToolStream: true,
		},
	};
}

function specFor(model: { provider: string; id: string } | undefined | null): GlmSpec | undefined {
	return !!model && model.provider === PROVIDER ? resolveSpec(model.id) : undefined;
}

// Build the /glm-tweaks status panel. Read-only snapshot of the active
// model, current thinking level, and the on/off state of every flag.
function renderStatus(
	pi: ExtensionAPI,
	model: { provider: string; id: string } | undefined,
): string {
	const spec = specFor(model);
	const active = spec !== undefined;
	const level = pi.getThinkingLevel();
	const flagLines = FLAGS.map((f) => `  ${pi.getFlag(f.name) === true ? "[x]" : "[ ]"} ${f.name}`);
	return [
		`GLM tweaks — ${active ? `ACTIVE (${model!.provider}/${model!.id} selected)` : "inactive (select zai/glm-5.2, zai/glm-5.3, or a newer glm-5.x)"}`,
		`thinking: ${active ? `current=${level}, wire=${wireLabels(spec!).join("|")}` : "n/a"}`,
		"",
		"flags:",
		...flagLines,
		"",
		"toggle: /glm-tweaks toggle <flag>   (shorthand: /glm-tweaks <flag>)",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	// Register Pi-idiomatic flags at factory load time, NOT inside
	// session_start. registerFlag is static setup; calling it per session
	// would clobber user preferences on every /new or /reload. Defaults are
	// seeded from the persisted map in <piDir>/pi-glm-tweaks.json so toggles
	// survive pi restarts; missing/unknown flags fall back to the flag's own
	// `default` (cache-safe: all three token-efficiency flags default off).
	//
	// Persisted-wins is the load-bearing invariant for the v1.2.0 default
	// flip: a 1.1.2 user who explicitly toggled a flag to `true` (even though
	// that matched the old default, so the toggle looked like a no-op at the
	// time) has a real `{ "<flag>": true }` entry on disk today, and
	// `f.name in persisted` picks it up post-upgrade so their explicit
	// choice is preserved. The one-shot toggle handler persists every flip
	// unconditionally (no no-op skip), which is what makes this hold.
	const persisted = loadFlagSettings();
	for (const f of FLAGS) {
		pi.registerFlag(f.name, {
			description: f.description,
			type: "boolean",
			default: f.name in persisted ? persisted[f.name] : f.default,
		});
	}

	// /glm-tweaks — status display by default; `toggle <flag>` (or bare
	// `<flag>`) flips a boolean. ExtensionAPI exposes no live setFlag, so a
	// toggle is written to <piDir>/pi-glm-tweaks.json (lib/flag-settings.ts)
	// and then reloads the session so registerFlag re-seeds the in-memory
	// default from disk. ctx is stale after reload() — we notify first,
	// reload last, and return immediately.
	pi.registerCommand("glm-tweaks", {
		description: "GLM tweaks: show status, or toggle a flag. Usage: /glm-tweaks [toggle <flag>]",
		getArgumentCompletions: (prefix: string) => {
			// Preserve trailing space: `/glm-tweaks toggle ` (with space) means
			// the `toggle` token is complete and we should now suggest flags.
			// Trimming would collapse it to "toggle" and re-suggest the word.
			const trailingSpace = /\s$/.test(prefix);
			const tokens = prefix.trim().split(/\s+/).filter(Boolean);
			const flagNames = FLAGS.map((f) => f.name);
			const root = ["toggle", ...flagNames];
			// Suggest flag names once `toggle` is complete (either as the only
			// token with a trailing space, or with a partial flag typed).
			const toggleComplete =
				(tokens.length === 1 && tokens[0] === "toggle") ||
				(tokens.length >= 2 && tokens[0] === "toggle");
			if (toggleComplete) {
				const partial = tokens.length >= 2 ? tokens[tokens.length - 1] : "";
				const hits = flagNames.filter((n) => n.startsWith(partial));
				return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
			}
			if (tokens.length <= 1 && !trailingSpace) {
				const hits = root.filter((o) => o.startsWith(tokens[0] ?? ""));
				return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// Toggle mode: `/glm-tweaks toggle <flag>` or `/glm-tweaks <flag>`.
			// Direct one-shot flip — persists to the settings file then reloads.
			// Bare `/glm-tweaks toggle` (no flag) falls through to the menu.
			if (trimmed !== "" && trimmed !== "status" && trimmed !== "toggle") {
				const tokens = trimmed.split(/\s+/).filter(Boolean);
				const flagName = tokens[0] === "toggle" ? tokens[1] : tokens[0];
				const meta = FLAGS.find((f) => f.name === flagName);
				if (!meta) {
					ctx.ui.notify(
						`Unknown flag "${flagName}". Valid: ${FLAGS.map((f) => f.name).join(", ")}`,
						"warning",
					);
					return;
				}
				const current = pi.getFlag(meta.name) === true;
				const next = !current;
				if (!saveFlagSetting(meta.name, next)) {
					ctx.ui.notify(`Failed to persist ${meta.name} to settings file.`, "error");
					return;
				}
				ctx.ui.notify(`${meta.name}: ${current} → ${next}. Reloading...`, "info");
				await ctx.reload();
				return;
			}

			// Status/menu mode. In TUI, open an interactive SettingsList
			// (same component /settings uses) so the user can flip several
			// flags in one visit; changes persist to the settings file and a
			// single reload fires on close. Outside TUI (RPC/headless), fall
			// back to the read-only status panel — custom components are
			// terminal-only.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(renderStatus(pi, ctx.model), "info");
				return;
			}

			const active = specFor(ctx.model) !== undefined;
			const pending = new Map<string, boolean>();
			const items: SettingItem[] = FLAGS.map((f) => ({
				id: f.name,
				label: f.label,
				description: f.description,
				currentValue: pi.getFlag(f.name) === true ? "on" : "off",
				values: ["on", "off"],
			}));

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				const header = active
					? `GLM tweaks — ${ctx.model!.provider}/${ctx.model!.id} active`
					: "GLM tweaks — inactive (select zai/glm-5.2, zai/glm-5.3, or a newer glm-5.x)";
				container.addChild(new Text(theme.fg("accent", theme.bold(header)), 1, 1));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Stage the change; persist + reload on close, not here,
						// so the user can flip several flags per visit.
						pending.set(id, newValue === "on");
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			// Dialog closed. ctx is still valid here (reload is the only
			// staleness trigger, and we haven't called it yet). Drop net-zero
			// flips (a flag toggled on then off stages but changes nothing),
			// then persist genuine deltas and reload once if any moved.
			const deltas: Array<[string, boolean]> = [];
			for (const [name, val] of pending) {
				const currentlyOn = pi.getFlag(name) === true;
				if (currentlyOn === val) continue; // net-zero: toggled back to current
				deltas.push([name, val]);
			}
			if (deltas.length === 0) return;

			const failures: string[] = [];
			for (const [name, val] of deltas) {
				if (!saveFlagSetting(name, val)) failures.push(name);
			}
			if (failures.length > 0) {
				ctx.ui.notify(`Failed to persist: ${failures.join(", ")}`, "error");
				return;
			}
			ctx.ui.notify(`Applied ${deltas.length} change(s). Reloading...`, "info");
			await ctx.reload();
		},
	});

	// Per-loop mutable state. Node.js runs the extension hooks single-
	// threaded, so a closure-scoped object is safe and avoids re-reading
	// flags + recomputing in every hook. Reset on every before_agent_start.
	const loop: {
		shortPrompt: boolean;
	} = { shortPrompt: false };

	pi.on("session_start", async (_event, ctx) => {
		// Build the full `zai` provider model list, patching only targeted GLM
		// models. registerProvider replaces ALL models for the provider when models
		// are provided, so a single-entry list would silently drop
		// glm-4.7, glm-5-turbo, glm-5.1, and any user-added zai entries.
		const existing = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER);
		if (existing.length === 0) return;
		if (!existing.some((m) => resolveSpec(m.id) !== undefined)) return;

		// registerProvider requires apiKey (or oauth) when defining models,
		// even for a provider that already has auth resolved. Pull the
		// resolved key from the existing provider so we keep working
		// whether the user used ZAI_API_KEY env, /login, or models.json
		// apiKey.
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (!apiKey) {
			ctx.ui.notify(
				"pi-glm-tweaks: ZAI auth not configured. Run `/login` or set ZAI_API_KEY to enable GLM thinking tweaks.",
				"warning",
			);
			return;
		}

		// Per-model spread preserves every original field (api, baseUrl,
		// headers, compat extras) for non-target models. Only targeted GLM
		// models get the new thinkingLevelMap, baseUrl, and OpenAI-compat
		// compat block.
		// baseUrl is set at BOTH provider level (required by validation;
		// satisfies the model-registry check) and per-model in the rebuilt
		// entries (per-model takes precedence at request time, so any custom
		// baseUrl the user has on other `zai/*` models is preserved by
		// the spread).
		const models = existing.map((m) => {
			const spec = resolveSpec(m.id);
			return spec ? buildGlmModel(m.id, spec) : { ...m };
		});
		pi.registerProvider(PROVIDER, {
			baseUrl: ZAI_CODING_BASE_URL,
			apiKey,
			models,
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Reset per-loop state at the start of each user turn. The other
		// hooks read this to drive their per-turn behavior.
		loop.shortPrompt = event.prompt.length < SHORT_PROMPT_THRESHOLD;

		if (specFor(ctx.model) === undefined) return {};
		if (pi.getFlag("glm-budget-nudge") !== true) return {};

		// Return the assembled prompt with our fragment appended. We must
		// concat (not replace) — Pi's before_agent_start chaining means
		// our systemPrompt replaces the upstream value, and other
		// extensions downstream only see what we return.
		return { systemPrompt: (event.systemPrompt ?? "") + BUDGET_FRAGMENT };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const spec = specFor(ctx.model);
		if (spec === undefined) return;
		if (!event.payload || typeof event.payload !== "object") return;

		const obj = event.payload as Record<string, unknown>;
		const current = obj.thinking;
		const thinking =
			current && typeof current === "object" && !Array.isArray(current)
				? { ...(current as Record<string, unknown>) }
				: ({} as Record<string, unknown>);

		let mutated = false;

		// 5.3+ safety net: `thinking.type: "disabled"` is rejected by glm-5.3
		// and newer. Pi's zai branch (openai-completions.js) sends
		// thinking.type="disabled" whenever reasoningEffort is falsy — which
		// is exactly what Pi level "off" produces, and the model entry's
		// thinkingLevelMap is NOT consulted on that path (it is only indexed
		// by a non-undefined effort). So we cannot fix this in the map; we
		// intercept the payload here and rewrite to z.ai's documented
		// migration shape: enabled + reasoning_effort "low". This runs
		// unconditionally (not flag-gated) because the alternative is a
		// failed request.
		if (!spec.canDisableThinking && thinking.type === "disabled") {
			thinking.type = "enabled";
			if (obj.reasoning_effort === undefined) obj.reasoning_effort = "low";
			mutated = true;
		}

		// Opt out of z.ai Preserved Thinking. The coding endpoint ships
		// clear_thinking=false ON BY DEFAULT because preserving reasoning
		// across turns is what makes the prefix cacheable (see z.ai Thinking
		// Mode docs). Flipping this on re-bills the full prefix every turn —
		// hence default OFF and opt-in only.
		if (pi.getFlag("glm-clear-thinking") === true) {
			thinking.clear_thinking = true;
			mutated = true;
		}

		// Short-prompt thinking-skip: trivial turns ("what time is it")
		// don't need deep thinking. glm-5.2: force the kill switch and let
		// Pi's zai branch drop the thinking.type="disabled" through.
		// glm-5.3: "disabled" is rejected — thinking stays enabled with
		// reasoning_effort="low" (z.ai's documented migration path).
		//
		// Intentionally applies to every LLM call in the loop, not just the
		// first: loop.shortPrompt is computed once from the initial prompt
		// and held constant (see before_agent_start). A short prompt that
		// spawns tool calls stays light for the whole turn.
		if (pi.getFlag("glm-skip-short-thinking") === true && loop.shortPrompt) {
			if (spec.canDisableThinking) {
				thinking.type = "disabled";
			} else {
				thinking.type = "enabled";
				obj.reasoning_effort = "low";
			}
			mutated = true;
		}

		if (mutated) {
			obj.thinking = thinking;
		}
		return obj;
	});

	pi.on("model_select", (event, ctx) => {
		const spec = specFor(event.model);
		if (spec === undefined) {
			ctx.ui.setStatus("glm-thinking", undefined);
			return;
		}

		// Auto-clamp if Pi's current level is one we hid for this model.
		// setThinkingLevel is a no-op if already at the requested level.
		const current = pi.getThinkingLevel();
		if (hiddenLevels(spec).has(current)) {
			pi.setThinkingLevel("high");
			ctx.ui.notify(
				`${event.model.id} thinking: "${current}" not supported. Switched to high (${wireLabels(spec).join(" | ")}).`,
				"info",
			);
		}

		ctx.ui.setStatus("glm-thinking", `thinking: ${wireLabels(spec).join(" | ")}`);
	});
}