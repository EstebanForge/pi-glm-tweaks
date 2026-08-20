import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/index.js";

type SessionStartHandler = (event: unknown, ctx: unknown) => void | Promise<void>;

interface TestPi {
	registerCommand: (name: string, def: unknown) => void;
	registerFlag: (name: string, def: unknown) => void;
	on: (name: string, handler: SessionStartHandler) => void;
	registerProvider: (provider: string, def: unknown) => void;
	getFlag: () => undefined;
}

function makePi(models: Array<{ provider: string; id: string }>) {
	const commands: string[] = [];
	const handlers: Record<string, SessionStartHandler> = {};

	const state = { registered: undefined as { provider: string; def: unknown } | undefined };

	const pi = {
		registerCommand: (name: string) => void commands.push(name),
		registerFlag: () => {},
		on: (name: string, handler: SessionStartHandler) => void (handlers[name] = handler),
		registerProvider: (provider: string, def: unknown) => void (state.registered = { provider, def }),
		getFlag: () => undefined,
	};

	const ctx = {
		model: models[0],
		modelRegistry: {
			getAll: () => models,
			getApiKeyForProvider: async () => "test-key",
		},
		ui: { notify: () => {}, setStatus: () => {} },
	};

	return { pi, commands, handlers, state, ctx };
}

describe("pi-glm-tweaks extension entry", () => {
	it("registers the glm-tweaks command", async () => {
		const { pi, commands } = makePi([]);
		await factory(pi as unknown as TestPi);
		expect(commands).toContain("glm-tweaks");
	});

	it("re-registers glm-5.3 with the 5.3 thinking map (low enabled, no disabled)", async () => {
		const { pi, handlers, state, ctx } = makePi([
			{ provider: "zai", id: "glm-5.2" },
			{ provider: "zai", id: "glm-5.3" },
			{ provider: "zai", id: "glm-4.7" },
		]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const { registered } = state;
		expect(registered).toBeDefined();
		const models = (registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as {
			thinkingLevelMap: Record<string, string | null>;
		};
		expect(glm53.thinkingLevelMap).toEqual({
			off: "low",
			minimal: null,
			medium: null,
			low: "low",
			high: "high",
			xhigh: null,
			max: "max",
		});

		// Untargeted models pass through untouched; 5.2 keeps its own map.
		const glm47 = models.find((m) => m.id === "glm-4.7");
		expect(glm47).toEqual({ provider: "zai", id: "glm-4.7" });
		const glm52 = models.find((m) => m.id === "glm-5.2") as {
			thinkingLevelMap: Record<string, string | null>;
		};
		expect(glm52.thinkingLevelMap.low).toBeNull();
	});

	it("does not re-register when no targeted model is present", async () => {
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-4.7" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);
		expect(state.registered).toBeUndefined();
	});

	it("rewrites rejected thinking.type=disabled to enabled+low on glm-5.3, leaves glm-5.2 alone", async () => {
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);

		const run = (model: { provider: string; id: string }, payload: Record<string, unknown>) => {
			const evt = { payload: JSON.parse(JSON.stringify(payload)) };
			// ctx is a shared mutable object; swap the model for this call.
			(ctx as { model: unknown }).model = model;
			return handlers.before_provider_request(evt, ctx) as Record<string, unknown>;
		};

		// Pi's zai branch with level "off": thinking disabled, no effort.
		// 5.3 must be rewritten to z.ai's migration shape.
		const out53 = run({ provider: "zai", id: "glm-5.3" }, {
			thinking: { type: "disabled", clear_thinking: false },
		});
		expect(out53.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out53.reasoning_effort).toBe("low");

		// Same payload on 5.2 (canDisableThinking) passes through untouched.
		const out52 = run({ provider: "zai", id: "glm-5.2" }, {
			thinking: { type: "disabled", clear_thinking: false },
		});
		expect(out52.thinking).toEqual({ type: "disabled", clear_thinking: false });
		expect(out52.reasoning_effort).toBeUndefined();

		// Enabled payloads on 5.3 are untouched (guard fires only on disabled).
		const out53e = run({ provider: "zai", id: "glm-5.3" }, {
			thinking: { type: "enabled", clear_thinking: false },
			reasoning_effort: "max",
		});
		expect(out53e.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out53e.reasoning_effort).toBe("max");
	});

	it("applies the 5.3 spec fallback to unknown glm-5.4 (forward compat), not to glm-4.x", async () => {
		const { pi, handlers, state, ctx } = makePi([
			{ provider: "zai", id: "glm-5.4" },
			{ provider: "zai", id: "glm-5.4[1m]" },
			{ provider: "zai", id: "glm-5.1" },
		]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		for (const id of ["glm-5.4", "glm-5.4[1m]"]) {
			const m = models.find((x) => x.id === id) as {
				thinkingLevelMap: Record<string, string | null>;
			};
			expect(m.thinkingLevelMap).toEqual({
				off: "low",
				minimal: null,
				medium: null,
				low: "low",
				high: "high",
				xhigh: null,
				max: "max",
			});
		}
		// glm-5.1 predates the new contract: untouched, no fallback.
		expect(models.find((x) => x.id === "glm-5.1")).toEqual({ provider: "zai", id: "glm-5.1" });
	});

	it("model_select clamps a stale xhigh up to max, not down to high", async () => {
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		const set: string[] = [];
		const notes: string[] = []
		const pi2 = {
			...pi,
			getThinkingLevel: () => "xhigh",
			setThinkingLevel: (l: string) => void set.push(l),
		} as unknown as TestPi;
		(ctx as { ui: { notify: (m: string) => void; setStatus: () => void } }).ui = {
			notify: (m: string) => void notes.push(m),
			setStatus: () => {},
		};
		await factory(pi2);

		handlers.model_select({ model: { provider: "zai", id: "glm-5.3" } }, ctx);

		// xhigh was the pre-1.5.0 label for wire "max": the clamp must land on
		// max (same wire effort) instead of silently halving to high.
		expect(set).toEqual(["max"]);
		expect(notes[0]).toContain('Switched to max');
	});
});

describe("glm-api-route setting", () => {
	const tempDirs: string[] = [];

	function withRouteSetting(value: string) {
		const dir = mkdtempSync(join(tmpdir(), "glm-tweaks-test-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "pi-glm-tweaks.json"), JSON.stringify({ "glm-api-route": value }));
		process.env.PI_CODING_AGENT_DIR = dir;
	}

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("registers anthropic route models against api.z.ai/api/anthropic with pinned compat", async () => {
		withRouteSetting("anthropic");
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
		expect(glm53.api).toBe("anthropic-messages");
		expect(glm53.baseUrl).toBe("https://api.z.ai/api/anthropic");
		// Unprobed ttl must never be requested: pin long retention off.
		expect(glm53.compat.supportsLongCacheRetention).toBe(false);
		// OpenAI-shape compat flags do not carry over.
		expect(glm53.compat.thinkingFormat).toBeUndefined();
		expect(glm53.compat.zaiToolStream).toBeUndefined();
		// The thinking map still drives UI-hide/clamp on both routes.
		expect(glm53.thinkingLevelMap.high).toBe("high");
	});

	it("session_start re-seeds footer chips (survive /reload wipes)", async () => {
		// Regression: pi's interactive mode clears ALL extension footer
		// statuses on /reload, /new, /resume — and model_select does not
		// re-fire when the model is unchanged. Chips must be re-set from
		// session_start or they vanish until a manual model switch.
		withRouteSetting("coding");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		const statuses: Array<[string, string | undefined]> = [];
		(ctx as { ui: unknown }).ui = {
			notify: () => {},
			setStatus: (key: string, text: string | undefined) => void statuses.push([key, text]),
		};
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		expect(statuses).toContainEqual(["glm", `${String.fromCodePoint(0x21e2)} OAI`]);
	});

	it("coding route (default) keeps the documented OpenAI-shape contract", async () => {
		// Pin an empty settings file: without PI_CODING_AGENT_DIR this test
		// would read the developer's real ~/.pi/agent/pi-glm-tweaks.json and
		// fail whenever the host install has glm-api-route=anthropic.
		withRouteSetting("coding");
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
		expect(glm53.api).toBe("openai-completions");
		expect(glm53.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
		expect(glm53.compat.thinkingFormat).toBe("zai");
		expect(glm53.compat.zaiToolStream).toBe(true);
	});

	it("api route (standard z.ai platform API) registers against api.z.ai/api/paas/v4 with the OpenAI shape", async () => {
		withRouteSetting("api");
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
		expect(glm53.api).toBe("openai-completions");
		expect(glm53.baseUrl).toBe("https://api.z.ai/api/paas/v4");
		// Same thinking contract as the coding route: only billing differs.
		expect(glm53.compat.thinkingFormat).toBe("zai");
	});

	it("legacy and unknown persisted route values resolve safely", async () => {
		// "coding" is the pre-1.5.0 persisted form and the fallback for
		// unset/garbage; "anthropic" is the other pre-1.5.0 form. Garbage
		// must fall back to coding, never throw or miswire the base URL.
		const cases: Array<[string, string]> = [
			["coding", "https://api.z.ai/api/coding/paas/v4"],
			["anthropic", "https://api.z.ai/api/anthropic"],
			["legacy-v1", "https://api.z.ai/api/coding/paas/v4"],
		];
		for (const [persisted, expectedBaseUrl] of cases) {
			withRouteSetting(persisted);
			const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
			await factory(pi as unknown as TestPi);
			await handlers.session_start(undefined, ctx);
			const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
			const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
			expect(glm53.baseUrl).toBe(expectedBaseUrl);
		}
	});

	it("anthropic route replaces Pi's budget-based thinking with enabled+reasoning_effort", async () => {
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		const pi2 = { ...pi, getThinkingLevel: () => "max" } as unknown as TestPi;
		await factory(pi2);
		// The branch keys off the REGISTERED model's api field, mirroring
		// what session_start built from the persisted route.
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.3", api: "anthropic-messages" };

		// Pi's anthropic provider emits budget-based thinking; the route
		// branch must REPLACE the object, not merge into it.
		const evt = { payload: { thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", reasoning_effort: "max" });
		// budget_tokens/display dropped, no top-level effort field (the
		// endpoint ignores a top-level reasoning_effort silently).
		expect(out.reasoning_effort).toBeUndefined();
	});

	it("anthropic route never leaves thinking disabled (silent-ignore hazard)", async () => {
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		// Level "off" maps to null in the 5.3 map: the branch must fall
		// back to the lightest legal effort, NOT pass a disabled shape
		// through (z.ai ignores it and bills max-depth thinking anyway).
		const pi2 = { ...pi, getThinkingLevel: () => "off" } as unknown as TestPi;
		await factory(pi2);
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.3", api: "anthropic-messages" };

		const evt = { payload: { thinking: { type: "disabled" } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", reasoning_effort: "low" });
	});

	it("anthropic route falls back to the lightest DOCUMENTED effort per spec (glm-5.2 off → high, not low)", async () => {
		// Peer-review finding (v1.5.0): glm-5.2's map has no "off" key, so an
		// unmapped level hit the hardcoded "low" fallback — an effort glm-5.2
		// does not document (its wire tiers are high|max). The fallback must
		// be spec-aware: 5.2 → high, 5.3 → low.
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.2" }]);
		const pi2 = { ...pi, getThinkingLevel: () => "off" } as unknown as TestPi;
		await factory(pi2);
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.2", api: "anthropic-messages" };

		const evt = { payload: { thinking: { type: "enabled", budget_tokens: 4096 } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", reasoning_effort: "high" });
	});

	it("coding route is untouched by the anthropic branch (disabled rewrite still OpenAI-shaped)", async () => {
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);

		const evt = { payload: { thinking: { type: "disabled", clear_thinking: false } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out.reasoning_effort).toBe("low");
	});

	it("route branch follows the registered model, not a concurrent settings flip", async () => {
		// Cross-session hazard (peer-review finding): session A flips
		// glm-api-route on disk while session B still runs a model registered
		// as openai-completions. The request-shape branch must follow
		// ctx.model.api, so B's next request keeps the coding shape.
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.3", api: "openai-completions" };

		const evt = { payload: { thinking: { type: "disabled", clear_thinking: false } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		// Coding-route safety net fired (OpenAI shape), NOT the anthropic
		// replacement — despite anthropic being on disk.
		expect(out.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out.reasoning_effort).toBe("low");
		expect(typeof out.thinking.reasoning_effort).toBe("undefined");
	});
});
