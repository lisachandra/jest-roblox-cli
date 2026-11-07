import { describe, expect, it } from "vitest";

import { buildEmulatorHarnessLuau } from "./emulator-harness.luau.ts";

describe("buildEmulatorHarnessLuau", () => {
	it("should write the configured globals before the harness body", () => {
		expect.assertions(2);

		const source = buildEmulatorHarnessLuau({ __TEST__: true, NOCOLOR: true });

		expect(source).toContain('_G["__TEST__"] = true');
		expect(source).toContain('_G["NOCOLOR"] = true');
	});

	it("should emit no globals for an empty map", () => {
		expect.assertions(1);

		expect(buildEmulatorHarnessLuau({})).not.toContain("_G[");
	});

	it("should keep the ree parity shims the spike proved necessary", () => {
		expect.assertions(4);

		const source = buildEmulatorHarnessLuau({});

		expect(source).toContain("local threadEnv = getfenv(0)");
		expect(source).toContain('folder.Name = ".luau-aliases"');
		expect(source).toContain("Context.StandIn(getDataModelService, fakeGetDataModelServiceSource)");
		expect(source).toContain("debug.loadmodule = function(m)");
	});

	it("should seed the global-asset container stubs", () => {
		expect.assertions(2);

		const source = buildEmulatorHarnessLuau({});

		expect(source).toContain('{ "Animations", "UI", "VFX", "Models" }');
		expect(source).toContain('stub.Name = "Sounds"');
	});

	it("should run the runner per job and report through the results marker", () => {
		expect.assertions(3);

		const source = buildEmulatorHarnessLuau({});

		expect(source).toContain("Jest.runCLI(script, argv, projects):awaitStatus()");
		expect(source).toContain('"@JEST_RESULTS " .. envelope');
		expect(source).toContain('print("@done")');
	});

	it("should forward the runner context fields into the Jest argv", () => {
		expect.assertions(4);

		const source = buildEmulatorHarnessLuau({});

		expect(source).toContain("testPathPattern = Context.pattern");
		expect(source).toContain("testNamePattern = Context.testNamePattern");
		expect(source).toContain("testPathIgnorePatterns = Context.ignorePatterns");
		expect(source).toContain("setupFiles = setupFiles");
	});

	it("should arm the coverage sink and attach the hits only on coverage runs", () => {
		expect.assertions(3);

		const source = buildEmulatorHarnessLuau({});

		expect(source).toContain("if Context.coverage == true then");
		expect(source).toContain("_G.__jest_roblox_cov = {}");
		expect(source).toContain("payload.runner = { coverage = _G.__jest_roblox_cov }");
	});
});
