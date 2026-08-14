import { describe, expect, it } from "vitest";
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
		ui: { notify: () => {} },
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
			xhigh: "max",
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
				xhigh: "max",
			});
		}
		// glm-5.1 predates the new contract: untouched, no fallback.
		expect(models.find((x) => x.id === "glm-5.1")).toEqual({ provider: "zai", id: "glm-5.1" });
	});
});
