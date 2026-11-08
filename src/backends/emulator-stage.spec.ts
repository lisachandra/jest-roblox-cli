import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { stageEmulatorMounts } from "./emulator-stage.ts";

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
		const isMainStaged = fs.existsSync(path.join(staged, "ReplicatedStorage/TS/client/main.luau"));
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
		const isDotRenamed = fs.existsSync(path.join(staged, "ReplicatedStorage/TS/_cache/junk.txt"));
		fs.rmSync(root, { force: true, recursive: true });

		expect(isMainStaged).toBeTrue();

		expect(isNestedStaged).toBeTrue();

		expect(isVerbatimDropped).toBeTrue();

		expect(isDotRenamed).toBeTrue();

		expect(result.mappings.map((mapping) => mapping.dataModelPath)).toContain("ReplicatedStorage/TS");
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
		fs.writeFileSync(reflectionPath, JSON.stringify({ classes: [{ name: "Frame" }, { name: "TextBox" }] }));

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
});
