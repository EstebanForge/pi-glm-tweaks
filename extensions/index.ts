/**
 * pi-glm-tweaks — Pi-native tweaks for Z.AI's GLM-5.2.
 *
 * Restricts the Pi thinking-level UI to the three modes GLM-5.2 actually
 * supports (off, high, max), wires the native `thinkingFormat: "zai"` wire
 * translation, auto-clamps hidden levels, and applies token-efficiency
 * hygiene (per-turn system-prompt nudge, intra-loop ratchet, wire-level
 * clear_thinking and short-prompt quick-disable).
 *
 * Wire map (see https://docs.z.ai/guides/capabilities/thinking and
 * providers/openai-completions.js in pi-ai):
 *
 *   Pi level  | thinking.type | reasoning_effort
 *   ----------|---------------|------------------
 *   off       | "disabled"    | (omitted)
 *   high      | "enabled"     | "high"
 *   xhigh     | "enabled"     | "max"
 *
 * Hidden levels (minimal, low, medium) are Pi-side concepts that don't map
 * cleanly: low/medium get server-side-mapped to "high", minimal is a no-op
 * for Pi's reasoning transport. Showing them invites accidental footguns.
 *
 * Behavior:
 *   - On session_start, re-register the `zai` provider with GLM-5.2 redefined
 *     against the OpenAI-compat endpoint and the tight thinkingLevelMap.
 *     registerProvider takes effect immediately after bindCore (no /reload).
 *   - On model_select to zai/glm-5.2, clamp a stale hidden level to "high"
 *     and notify. Set the footer status hint.
 *   - On model_select to any other model, clear the footer status.
 *   - On every user turn, inject a soft system-prompt budget fragment
 *     (`glm-budget-nudge`, default on).
 *   - Per LLM call, count cumulative reasoning_content; if over a
 *     threshold, inject a one-shot user-side hint to push the model back
 *     toward tool calls (`glm-budget-nudge`).
 *   - On every outgoing request, force `clear_thinking: true` (the coding
 *     endpoint defaults to preserved thinking, which silently compounds
 *     `reasoning_content` across turns). `glm-clear-thinking`, default on.
 *   - On short user prompts (<80 chars), force `thinking.type: "disabled"`
 *     to save tokens on trivial turns. `glm-quick-disable`, default on.
 *
 * Auth is untouched. The provider's existing key (ZAI_API_KEY env, /login,
 * or models.json apiKey) continues to resolve against the new baseUrl.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "zai";
const MODEL_ID = "glm-5.2";
const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

// Pi thinking-level keys we hide for GLM-5.2. Listed explicitly so the map
// stays grep-friendly; any level not present (notably `off`) is supported
// with the provider's default mapping (here: thinking.type="disabled").
const HIDDEN_LEVELS = new Set(["minimal", "low", "medium"]);

// Token-efficiency tuning constants. Hardcoded for v1 — exposed as flags
// would be over-engineering for a single-model extension. Bump these in
// a future minor if users report the ratchet firing too eagerly / not
// eagerly enough.
const SHORT_PROMPT_THRESHOLD = 80;
const RATCHET_THRESHOLD_CHARS = 2_000;

// Soft system-prompt fragment appended to every zai/glm-5.2 turn when
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

// Redefined glm-5.2 model entry. `cost` mirrors the built-in (Z.AI does
// not publish per-token rates; zeros is conservative). thinkingLevelMap
// doubles as UI-hide (`null`) and wire-level safety net: Pi's zai branch
// in openai-completions.js reads this map for reasoning_effort, and a
// null entry produces no reasoning_effort field on the wire. baseUrl
// is per-model (not provider-level) so we don't override any custom
// baseUrl the user may have set on other `zai/*` models.
const GLM52_MODEL = {
	id: MODEL_ID,
	name: "GLM-5.2",
	api: "openai-completions",
	baseUrl: ZAI_CODING_BASE_URL,
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	contextWindow: 1_000_000,
	maxTokens: 131_072,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: {
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: "max",
	},
	compat: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		thinkingFormat: "zai" as const,
		zaiToolStream: true,
	},
};

function isZaiGlm52(model: { provider: string; id: string } | undefined | null): boolean {
	return !!model && model.provider === PROVIDER && model.id === MODEL_ID;
}

export default function (pi: ExtensionAPI) {
	// Register Pi-idiomatic flags at factory load time, NOT inside
	// session_start. registerFlag is static setup; calling it per session
	// would clobber user preferences on every /new or /reload.
	pi.registerFlag("glm-budget-nudge", {
		description: "Inject a soft thinking-budget system-prompt fragment and intra-loop ratchet for zai/glm-5.2.",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("glm-clear-thinking", {
		description: "Force clear_thinking=true on zai/glm-5.2 requests to prevent cross-turn reasoning_content carryover on the coding endpoint.",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("glm-quick-disable", {
		description: "Disable thinking on short user prompts (<80 chars) to save tokens on trivial turns.",
		type: "boolean",
		default: true,
	});

	// Per-loop mutable state. Node.js runs the extension hooks single-
	// threaded, so a closure-scoped object is safe and avoids re-reading
	// flags + recomputing in every hook. Reset on every before_agent_start.
	const loop: {
		shortPrompt: boolean;
		ratchetFired: boolean;
	} = { shortPrompt: false, ratchetFired: false };

	pi.on("session_start", async (_event, ctx) => {
		// Build the full `zai` provider model list, patching only glm-5.2.
		// registerProvider replaces ALL models for the provider when models
		// are provided, so a single-entry list would silently drop
		// glm-4.7, glm-5-turbo, glm-5.1, and any user-added zai entries.
		const existing = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER);
		if (existing.length === 0) return;
		if (!existing.some((m) => m.id === MODEL_ID)) return;

		// registerProvider requires apiKey (or oauth) when defining models,
		// even for a provider that already has auth resolved. Pull the
		// resolved key from the existing provider so we keep working
		// whether the user used ZAI_API_KEY env, /login, or models.json
		// apiKey.
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (!apiKey) {
			ctx.ui.notify(
				"pi-glm-tweaks: ZAI auth not configured. Run `/login` or set ZAI_API_KEY to enable GLM-5.2 thinking tweaks.",
				"warning",
			);
			return;
		}

		// Per-model spread preserves every original field (api, baseUrl,
		// headers, compat extras) for non-target models. Only glm-5.2 gets
		// the new thinkingLevelMap, baseUrl, and OpenAI-compat compat block.
		// baseUrl is set at BOTH provider level (required by validation;
		// satisfies the model-registry check) and per-model in GLM52_MODEL
		// (per-model takes precedence at request time, so any custom
		// baseUrl the user has on other `zai/*` models is preserved by
		// the spread).
		const models = existing.map((m) => (isZaiGlm52(m) ? GLM52_MODEL : { ...m }));
		pi.registerProvider(PROVIDER, {
			baseUrl: ZAI_CODING_BASE_URL,
			apiKey,
			models,
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Reset per-loop state at the start of each user turn. The other
		// hooks read these to drive their per-turn behavior.
		loop.shortPrompt = event.prompt.length < SHORT_PROMPT_THRESHOLD;
		loop.ratchetFired = false;

		if (!isZaiGlm52(ctx.model)) return {};
		if (pi.getFlag("glm-budget-nudge") !== true) return {};

		// Return the assembled prompt with our fragment appended. We must
		// concat (not replace) — Pi's before_agent_start chaining means
		// our systemPrompt replaces the upstream value, and other
		// extensions downstream only see what we return.
		return { systemPrompt: (event.systemPrompt ?? "") + BUDGET_FRAGMENT };
	});

	pi.on("context", (event, ctx) => {
		if (!isZaiGlm52(ctx.model)) return {};
		if (pi.getFlag("glm-budget-nudge") !== true) return {};
		if (loop.ratchetFired) return {};

		// Sum reasoning_content from assistant messages in the CURRENT
		// agent loop only. Find the boundary by walking back to the last
		// `role: "user"` message (the prompt that started this loop).
		// toolResult / assistant / custom / etc. are not user role, so
		// they don't reset the boundary. Without this scoping, a long
		// session would fire the ratchet on the first LLM call of every
		// new turn regardless of current-loop thinking.
		let loopStart = event.messages.length - 1;
		while (loopStart > 0) {
			const m = event.messages[loopStart] as { role?: string } | undefined;
			if (m?.role === "user") break;
			loopStart--;
		}

		let totalReasoning = 0;
		for (let i = loopStart + 1; i < event.messages.length; i++) {
			const m = event.messages[i];
			if (typeof m !== "object" || m === null) continue;
			const msg = m as { role?: string; reasoning_content?: unknown };
			if (msg.role !== "assistant") continue;
			if (typeof msg.reasoning_content === "string") {
				totalReasoning += msg.reasoning_content.length;
			}
		}
		if (totalReasoning < RATCHET_THRESHOLD_CHARS) return {};

		loop.ratchetFired = true;
		const hint = {
			role: "user",
			content:
				"[system reminder: you've been thinking extensively without taking a tool call. Take a tool call now or wrap up your response.]",
		};
		return { messages: [...event.messages, hint as never] };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isZaiGlm52(ctx.model)) return;
		if (!event.payload || typeof event.payload !== "object") return;

		const obj = event.payload as Record<string, unknown>;
		const current = obj.thinking;
		const thinking =
			current && typeof current === "object" && !Array.isArray(current)
				? { ...(current as Record<string, unknown>) }
				: ({} as Record<string, unknown>);

		let mutated = false;

		// Force clear_thinking on every request. The coding endpoint
		// defaults to preserved thinking (clear_thinking: false), which
		// silently compounds reasoning_content across turns. Cost at
		// $4.4/MTok output makes this materially expensive.
		if (pi.getFlag("glm-clear-thinking") === true) {
			thinking.clear_thinking = true;
			mutated = true;
		}

		// Short-prompt quick-disable: trivial turns ("what time is it")
		// don't need deep thinking. Force the kill switch and let Pi's
		// zai branch drop the thinking.type="disabled" through.
		if (pi.getFlag("glm-quick-disable") === true && loop.shortPrompt) {
			thinking.type = "disabled";
			mutated = true;
		}

		if (mutated) {
			obj.thinking = thinking;
		}
		return obj;
	});

	pi.on("model_select", (event, ctx) => {
		if (!isZaiGlm52(event.model)) {
			ctx.ui.setStatus("glm-thinking", undefined);
			return;
		}

		// Auto-clamp if Pi's current level is one we hid for GLM-5.2.
		// setThinkingLevel is a no-op if already at the requested level.
		const current = pi.getThinkingLevel();
		if (HIDDEN_LEVELS.has(current)) {
			pi.setThinkingLevel("high");
			ctx.ui.notify(
				`GLM-5.2 thinking: "${current}" not supported. Switched to high (off | high | max).`,
				"info",
			);
		}

		ctx.ui.setStatus("glm-thinking", "thinking: off | high | max");
	});
}