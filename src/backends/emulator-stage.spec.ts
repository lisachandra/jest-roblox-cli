import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { assertStagedMounts, EmulatorStagingError, stageEmulatorMounts } from "./emulator-stage.ts";
import type { EmulatorStageMapping } from "./emulator-stage.ts";

/**
 * Narrows a caught value to the staging error, failing the spec when it is
 * something else. The guard lives here rather than in the test body so the
 * fork's `no-conditional-in-test` rule sees it as helper logic.
 *
 * @param caught - The value a `try` block caught.
 * @returns The staging error.
 */
function stagingErrorOf(caught: unknown): EmulatorStagingError {
	if (!(caught instanceof EmulatorStagingError)) {
		throw new Error(`expected an EmulatorStagingError, got ${String(caught)}`);
	}

	return caught;
}

/**
 * Builds a minimal Rojo project tree: one `$path` mount whose directory is a
 * plain folder carrying a nested roblox-ts package (declared project name
 * `Widgets`), a dot-prefixed cache directory, and the two packages the stager
 * patches (`@rbxts/react` tags, `@rbxts/serio`).
 *
 * @param root - Temporary directory to write the tree into.
 * @returns The absolute path of the written Rojo project file.
 */
function writeFixtureTree(root: string): string {
	const outDirectory = path.join(root, "out");
	fs.mkdirSync(path.join(outDirectory, "client"), { recursive: true });
	fs.writeFileSync(path.join(outDirectory, "client", "main.luau"), "return 1");

	fs.mkdirSync(path.join(outDirectory, ".cache"), { recursive: true });
	fs.writeFileSync(path.join(outDirectory, ".cache", "junk.txt"), "x");

	const widgets = path.join(outDirectory, "node_modules", "@acme", "widgets");
	fs.mkdirSync(path.join(widgets, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(widgets, "default.project.json"),
		JSON.stringify({ name: "Widgets", tree: { $path: "src" } }),
	);
	fs.writeFileSync(path.join(widgets, "src", "init.luau"), "return 2");

	const reactDirectory = path.join(outDirectory, "node_modules", "@rbxts", "react");
	fs.mkdirSync(reactDirectory, { recursive: true });
	fs.writeFileSync(path.join(reactDirectory, "tags.lua"), "return {}");

	const serioDirectory = path.join(outDirectory, "node_modules", "@rbxts", "serio");
	fs.mkdirSync(serioDirectory, { recursive: true });
	fs.writeFileSync(path.join(serioDirectory, "lib.luau"), "local v = _VERSION\nreturn v");

	fs.writeFileSync(
		path.join(root, "place.project.json"),
		JSON.stringify({
			name: "place",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: { TS: { $path: "out" } },
			},
		}),
	);
	return path.join(root, "place.project.json");
}

describe("stageEmulatorMounts", () => {
	it("should mirror mounts and project nested packages under declared names", () => {
		expect.assertions(5);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-stage-"));
		const projectPath = writeFixtureTree(root);
		const result = stageEmulatorMounts({
			rojoProjectPath: projectPath,
			stageDirectory: path.join(root, ".stage"),
		});

		const staged = result.stageDirectory;

		// Rojo's nested-project rule: the package folder is REPLACED by its
		// declared name; ree skips dot entries — staging renames them to `_x`.
		const isMainStaged = fs.existsSync(
			path.join(staged, "ReplicatedStorage/TS/client/main.luau"),
		);
		const isNestedStaged = fs.existsSync(
			path.join(staged, "ReplicatedStorage/TS/node_modules/@acme/Widgets/init.luau"),
		);
		// By name, not by `existsSync`: a case-insensitive filesystem — Windows
		// and macOS by default — resolves `widgets` to the projected `Widgets`
		// directory, so the two spellings are indistinguishable to a stat and
		// the drop this checks for can never be observed there. `readdir`
		// reports the entries as spelled, which is the only reading of "the
		// verbatim copy is gone" that means the same thing on every host.
		const nestedParentEntries = fs.readdirSync(
			path.join(staged, "ReplicatedStorage/TS/node_modules/@acme"),
		);
		const isVerbatimDropped = !nestedParentEntries.includes("widgets");
		const isDotRenamed = fs.existsSync(
			path.join(staged, "ReplicatedStorage/TS/_cache/junk.txt"),
		);
		fs.rmSync(root, { force: true, recursive: true });

		expect(isMainStaged).toBeTrue();

		expect(isNestedStaged).toBeTrue();

		expect(isVerbatimDropped).toBeTrue();

		expect(isDotRenamed).toBeTrue();

		expect(result.mappings.map((mapping) => mapping.dataModelPath)).toContain(
			"ReplicatedStorage/TS",
		);
	});

	it("should write a manifest carrying the effective mappings", () => {
		expect.assertions(2);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-stage-"));
		const projectPath = writeFixtureTree(root);
		const result = stageEmulatorMounts({
			rojoProjectPath: projectPath,
			stageDirectory: path.join(root, ".stage"),
		});

		const manifest: unknown = JSON.parse(
			fs.readFileSync(path.join(result.stageDirectory, "manifest.json"), "utf-8"),
		);
		fs.rmSync(root, { force: true, recursive: true });

		expect(manifest).toBeTypeOf("object");

		expect(JSON.stringify(manifest)).toContain('"ReplicatedStorage/TS"');
	});

	it("should patch react tags from the reflection dump and serio _VERSION reads", () => {
		expect.assertions(3);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-stage-"));
		const projectPath = writeFixtureTree(root);
		const reflectionPath = path.join(root, "reflection.json");
		fs.writeFileSync(
			reflectionPath,
			JSON.stringify({ classes: [{ name: "Frame" }, { name: "TextBox" }] }),
		);

		stageEmulatorMounts({
			reflectionPath,
			rojoProjectPath: projectPath,
			stageDirectory: path.join(root, ".stage"),
		});

		const tags = fs.readFileSync(
			path.join(root, ".stage", "ReplicatedStorage/TS/node_modules/@rbxts/react/tags.lua"),
			"utf-8",
		);
		const serio = fs.readFileSync(
			path.join(root, ".stage", "ReplicatedStorage/TS/node_modules/@rbxts/serio/lib.luau"),
			"utf-8",
		);
		fs.rmSync(root, { force: true, recursive: true });

		expect(tags).toContain('"TextBox"');

		expect(tags).toContain('"Frame"');

		expect(serio).toContain('"Luau"');
	});

	it("should name both ends of every mapping the stage did not write", () => {
		expect.assertions(4);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-stage-"));
		const present: EmulatorStageMapping = {
			dataModelPath: "ReplicatedStorage/TS/client",
			fsPath: path.join(root, "out/client"),
		};
		const missing: EmulatorStageMapping = {
			dataModelPath: "ReplicatedStorage/PacketProfiler/Components",
			fsPath: path.join(root, "submodules/packet-profiler/src/Components"),
		};
		fs.mkdirSync(path.join(root, "stage/ReplicatedStorage/TS/client"), { recursive: true });

		let caught: unknown;
		try {
			assertStagedMounts({
				mappings: [present, missing],
				stageDirectory: path.join(root, "stage"),
			});
		} catch (err) {
			caught = err;
		} finally {
			fs.rmSync(root, { force: true, recursive: true });
		}

		expect(caught).toBeInstanceOf(EmulatorStagingError);

		const error = stagingErrorOf(caught);

		expect(error.missing).toStrictEqual([missing]);

		expect(error.message).toContain(missing.dataModelPath);

		// The source is named too, and marked gone when it no longer exists.
		expect(error.message).toContain(`${missing.fsPath} (its source is gone too)`);
	});

	it("should pass a stage whose every mapping landed", () => {
		expect.assertions(1);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-stage-"));
		const mapping: EmulatorStageMapping = {
			dataModelPath: "ReplicatedStorage/TS/client",
			fsPath: path.join(root, "out/client"),
		};
		fs.mkdirSync(path.join(root, "stage/ReplicatedStorage/TS/client"), { recursive: true });

		let shouldThrow = false;
		try {
			assertStagedMounts({ mappings: [mapping], stageDirectory: path.join(root, "stage") });
		} catch {
			shouldThrow = true;
		} finally {
			fs.rmSync(root, { force: true, recursive: true });
		}

		expect(shouldThrow).toBeFalse();
	});

	it("should not claim a source is gone when it is still on disk", () => {
		expect.assertions(3);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-stage-"));
		// The source is there; the copy is what did not land. The message must
		// not send the reader looking for a deleted directory.
		const mapping: EmulatorStageMapping = {
			dataModelPath: "ReplicatedStorage/PacketProfiler/Components",
			fsPath: path.join(root, "submodules/packet-profiler/src/Components"),
		};
		fs.mkdirSync(mapping.fsPath, { recursive: true });

		let caught: unknown;
		try {
			assertStagedMounts({ mappings: [mapping], stageDirectory: path.join(root, "stage") });
		} catch (err) {
			caught = err;
		} finally {
			fs.rmSync(root, { force: true, recursive: true });
		}

		expect(caught).toBeInstanceOf(EmulatorStagingError);

		const error = stagingErrorOf(caught);

		expect(error.message).toContain(mapping.fsPath);
		expect(error.message).not.toContain("its source is gone too");
	});
});
