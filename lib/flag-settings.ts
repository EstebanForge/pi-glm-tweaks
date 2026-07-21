// File-backed persistence for pi-glm-tweaks boolean flags.
//
// pi's extension flags (pi.registerFlag) are in-memory only, seeded from
// `default` and CLI `--flag-name` args at process start. There is no
// setFlag on ExtensionAPI and `pi config set <flag>` is NOT a real command
// (pi config only accepts -l/--approve/--no-approve). So we own a tiny
// settings file at <piDir>/pi-glm-tweaks.json ({ "<flagName>": bool, ... }),
// hydrate each registerFlag default from it at load, and write through on
// toggle. This makes settings survive pi restarts; the per-session apply
// path is ctx.reload() re-running the factory, which re-seeds the defaults
// from disk. `piDir` = process.env.PI_CODING_AGENT_DIR || ~/.pi/agent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_FILENAME = "pi-glm-tweaks.json";

// Resolve the agent config dir the same way pi does (dist/config.js getAgentDir):
// env override wins, else ~/.pi/agent. Exported so tests can point it elsewhere.
export function getPiDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	return join(homedir(), ".pi", "agent");
}

export function getSettingsPath(): string {
	return join(getPiDir(), SETTINGS_FILENAME);
}

/**
 * Load the persisted flag map. Missing/corrupt file → {} (caller falls
 * back to the flag's own default). Reads fresh from disk each call — the
 * file is tiny and reads happen only at factory load, so no cache is
 * needed and toggle/reload stays consistent.
 */
export function loadFlagSettings(): Record<string, boolean> {
	try {
		const path = getSettingsPath();
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const obj = parsed as Record<string, unknown>;
		const out: Record<string, boolean> = {};
		for (const [name, val] of Object.entries(obj)) {
			if (typeof val === "boolean") out[name] = val;
		}
		return out;
	} catch {
		// Corrupt / unreadable file -> empty map; flags fall back to defaults.
		return {};
	}
}

/**
 * Persist + merge a single flag value into the settings file. mkdir
 * recursive + writeFileSync, merge into the existing map so concurrent
 * flags don't clobber each other. Returns true on success; false on disk
 * error (caller notifies). The subsequent ctx.reload() re-seeds the flag
 * from disk (registerFlag default), so the value still applies this
 * session when this returns true.
 */
export function saveFlagSetting(name: string, value: boolean): boolean {
	const dir = getPiDir();
	const path = join(dir, SETTINGS_FILENAME);
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const existing = loadFlagSettings();
		existing[name] = value;
		writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
		return true;
	} catch {
		// Disk write failed (permissions, read-only fs). Caller notifies the
		// user; the session keeps working with whatever is currently in memory.
		return false;
	}
}
