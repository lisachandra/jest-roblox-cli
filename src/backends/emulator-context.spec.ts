import { describe, expect, it } from "vitest";

import type { EmulatorStageMapping } from "./emulator-stage.ts";
import {
	deriveRunContext,
	parseSummary,
	resolveInstancePath,
	toInstancePattern,
} from "./emulator-context.ts";

const MAPPINGS: Array<EmulatorStageMapping> = [
	{ dataModelPath: "ReplicatedStorage/TS/client", fsPath: "/repo/out/client" },
	{ dataModelPath: "ReplicatedStorage/TS/test", fsPath: "/repo/out/test" },
	{
		dataModelPath: "ReplicatedStorage/TS/rbxts_include/node_modules",
		fsPath: "/repo/packages/shared/node_modules",
	},
];

function resolverFor(rootDirectory: string): { mappings: Array<EmulatorStageMapping>; rootDirectory: string } {
	return { mappings: MAPPINGS, rootDirectory };
}

describe("toInstancePattern", () => {
	it("should strip src prefixes and TypeScript extensions", () => {
		expect.assertions(4);

		expect(toInstancePattern("src/server/tests/simulation.spec.ts")).toBe(
			"server/tests/simulation.spec",
		);
		expect(toInstancePattern("src/client/ui/init.spec.tsx")).toBe("client/ui/init.spec");
		expect(toInstancePattern("ui/hud/ballCam")).toBe("ui/hud/ballCam");
		expect(toInstancePattern("src/shared/index.ts")).toBe("shared/init");
	});
});

describe("resolveInstancePath", () => {
	it("should map a file under a mount to its DataModel path", () => {
		expect.assertions(3);

		expect(
			resolveInstancePath("/repo/out/client/ui/hud/ballCam.spec.luau", resolverFor("/repo")),
		).toBe("ReplicatedStorage/TS/client/ui/hud/ballCam.spec.luau");
		expect(resolveInstancePath("./out/test/setup", resolverFor("/repo"))).toBe(
			"ReplicatedStorage/TS/test/setup",
		);
		expect(resolveInstancePath("/repo/unknown/where.luau", resolverFor("/repo"))).toBeUndefined();
	});

	it("should prefer the longest owning prefix", () => {
		expect.assertions(1);

		const mappings: Array<EmulatorStageMapping> = [
			{ dataModelPath: "ReplicatedStorage/TS", fsPath: "/repo/out" },
			{ dataModelPath: "ReplicatedStorage/TS/client", fsPath: "/repo/out/client" },
		];

		expect(resolveInstancePath("/repo/out/client/x.luau", { mappings, rootDirectory: "/repo" })).toBe(
			"ReplicatedStorage/TS/client/x.luau",
		);
	});
});

describe("parseSummary", () => {
	it("should read the trailing JSON summary from ree stdout", () => {
		expect.assertions(2);

		const summary = parseSummary('status line\n{"output":[],"status":"ok"}\n', {
			code: 0,
			stderr: "",
		});

		expect(summary.status).toBe("ok");
		expect(summary.output).toStrictEqual([]);
	});

	it("should reject stdout without a summary object", () => {
		expect.assertions(1);

		expect(() => parseSummary("no json here\n", { code: 1, stderr: "boom" })).toThrow(
			"exited 1 without a summary",
		);
	});
});

describe("deriveRunContext", () => {
	it("should run a suite mounted under ServerScriptService as the server", () => {
		expect.assertions(3);

		// `ree` defaults to client, so a server suite that never says otherwise
		// answers `IsServer()` with false and its guards throw.
		expect(deriveRunContext(["ServerScriptService/TS/server"])).toBe("server");
		expect(deriveRunContext(["ServerStorage"])).toBe("server");
		expect(deriveRunContext(["ServerScriptService/TS/server", "ServerStorage/x"])).toBe("server");
	});

	it("should run a suite mounted outside the server services as the client", () => {
		expect.assertions(3);

		expect(deriveRunContext(["ReplicatedStorage/TS/client"])).toBe("client");
		expect(deriveRunContext(["ReplicatedStorage/TS/shared"])).toBe("client");
		// A job spanning both sides cannot run on one engine; client is both
		// ree's default and the safe answer.
		expect(deriveRunContext(["ServerScriptService/TS/server", "ReplicatedStorage/TS/shared"])).toBe(
			"client",
		);
	});

	it("should fall back to client when no root resolved", () => {
		expect.assertions(1);

		expect(deriveRunContext([])).toBe("client");
	});

	it("should not read a ReplicatedStorage child named like a server service as server", () => {
		expect.assertions(1);

		// Only the head of the path names a service; a nested `ServerScriptService`
		// folder is an ordinary instance under ReplicatedStorage.
		expect(deriveRunContext(["ReplicatedStorage/ServerScriptService"])).toBe("client");
	});
});
