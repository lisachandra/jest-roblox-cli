import { describe, expect, it } from "vitest";

import type { EmulatorStageMapping } from "./emulator-stage.ts";
import { parseSummary, resolveInstancePath, toInstancePattern } from "./emulator-context.ts";

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
