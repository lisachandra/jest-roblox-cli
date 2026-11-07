import { collectMounts, loadRojoProject, type Mount } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Materializes the physical mount tree `ree` runs against.
 *
 * ree mounts real directories, not Rojo projects: it does not follow Windows
 * junctions, skips dot-prefixed mount entries, and keeps raw JSON as a
 * ModuleScript `Source`. The Studio place pipeline solves all three inside the
 * place build; the emulator solves them by mirroring every Rojo mount into a
 * plain directory tree (`.jest-roblox/emulator/stage`) that ree can mount
 * verbatim:
 *
 * - copies are junction-dereferenced (`fs.cpSync { dereference: true }`);
 * - directories that carry their own `default.project.json` mount under their
 *   declared project name (Rojo's nested-project rule — the roblox-ts
 *   `node_modules` layout depends on it);
 * - dot-prefixed directories stage as `_<name>` (ree skips dot entries; the
 *   harness renames them back before the first require);
 * - `@rbxts/react/tags.lua` is regenerated from the vendored reflection dump
 *   and `@rbxts/serio` loses its `_VERSION` reads (both crash under ree —
 *   see docs/agents/offline-runtime-spike.md in the consuming repo).
 */

/** Effective `fsPath → dataModelPath` pairs the stage was built from. */
export interface EmulatorStageMapping {
	/** Absolute source directory the copy read from. */
	fsPath: string;
	/** Slash-separated DataModel path the copy mounts at. */
	dataModelPath: string;
}

export interface EmulatorStageResult {
	/** Absolute stage root the mounts mirror into. */
	stageDirectory: string;
	/** Mounts in effect after nested-project expansion, in copy order. */
	mappings: Array<EmulatorStageMapping>;
}

export interface EmulatorStageOptions {
	/** Absolute path of the Rojo project describing the DataModel. */
	rojoProjectPath: string;
	/** Absolute directory the stage tree is written under. */
	stageDirectory: string;
	/** Absolute path of the vendored ree `reflection.json` (tags.lua patch). */
	reflectionPath?: string | undefined;
}

interface NestedProject {
	name: string;
	sourceDirectory: string;
}

function classifyPath(fsPath: string): "directory" | "file" | "missing" {
	const stat = fs.statSync(fsPath, { throwIfNoEntry: false });
	if (stat === undefined) {
		return "missing";
	}

	return stat.isDirectory() ? "directory" : "file";
}

/**
 * Reads a directory's `default.project.json` when it declares the
 * `{ name, tree: { $path } }` shape Rojo uses for nested project mounts.
 */
function readNestedProject(packageDirectory: string): NestedProject | undefined {
	const projectFile = path.join(packageDirectory, "default.project.json");
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
	} catch {
		return undefined;
	}

	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}

	const record = raw as { name?: unknown; tree?: { $path?: unknown } };
	const name = record.name;
	const treePath = record.tree?.$path;
	if (typeof name !== "string" || typeof treePath !== "string") {
		return undefined;
	}

	return { name, sourceDirectory: path.join(packageDirectory, treePath) };
}

function copyDeref(source: string, destination: string): void {
	fs.cpSync(source, destination, { dereference: true, recursive: true, verbatimSymlinks: false });
}

/**
 * Copies one Rojo mount into the stage. Directories are copied
 * junction-dereferenced; a mount whose directory is itself a nested project
 * (or a directory holding nested projects at any depth — the roblox-ts
 * `node_modules` layout) is copied per Rojo's nested-project rule: the
 * project's `$path` contents mount under the declared name.
 */
function copyMount(mount: Mount, stageDirectory: string): Array<EmulatorStageMapping> {
	const mappings: Array<EmulatorStageMapping> = [];
	const kind = classifyPath(mount.fsPath);
	if (kind !== "directory") {
		return mappings;
	}

	const destination = path.join(stageDirectory, mount.dataModelPath);
	const nested = readNestedProject(mount.fsPath);
	if (nested !== undefined) {
		copyDeref(nested.sourceDirectory, destination);
		mappings.push({ dataModelPath: mount.dataModelPath, fsPath: nested.sourceDirectory });
		return mappings;
	}

	copyDeref(mount.fsPath, destination);
	mappings.push({ dataModelPath: mount.dataModelPath, fsPath: mount.fsPath });
	flattenNestedProjects({
		directory: mount.fsPath,
		instancePrefix: mount.dataModelPath,
		mappings,
		stageDirectory,
	});
	return mappings;
}

/**
 * Recursively replaces directories holding a `default.project.json` inside a
 * plain directory mount with their declared-name projection. Directory sync
 * mirrors everything else verbatim.
 */
function flattenNestedProjects({
	directory,
	instancePrefix,
	mappings,
	stageDirectory,
}: {
	directory: string;
	instancePrefix: string;
	mappings: Array<EmulatorStageMapping>;
	stageDirectory: string;
}): void {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		const packageDirectory = path.join(directory, entry.name);
		const nested = readNestedProject(packageDirectory);
		if (nested === undefined) {
			flattenNestedProjects({
				directory: packageDirectory,
				instancePrefix: `${instancePrefix}/${entry.name}`,
				mappings,
				stageDirectory,
			});
			continue;
		}

		const nestedInstance = `${instancePrefix}/${entry.name}/${nested.name}`;
		const nestedDestination = path.join(stageDirectory, nestedInstance);
		fs.rmSync(nestedDestination, { force: true, recursive: true });
		copyDeref(nested.sourceDirectory, nestedDestination);
		mappings.push({ dataModelPath: nestedInstance, fsPath: nested.sourceDirectory });
	}
}

/**
 * Renames every dot-prefixed directory in the stage to `_<name>`: ree's
 * mounter skips dot entries and the harness renames them back before the
 * first require.
 */
function undotDirectories(root: string): void {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		const full = path.join(root, entry.name);
		if (entry.name.startsWith(".")) {
			const renamed = path.join(root, `_${entry.name.slice(1)}`);
			fs.renameSync(full, renamed);
			undotDirectories(renamed);
			continue;
		}

		undotDirectories(full);
	}
}

/**
 * Rewrites `@rbxts/react`'s `tags.lua` from the vendored ree reflection dump:
 * the module reads `ReflectionService:GetClasses()`, which ree does not
 * emulate, so the staged copy carries the class table inline instead.
 */
function patchReactTags(stageDirectory: string, reflectionPath: string | undefined): number {
	const tagsPath = findStageFile(stageDirectory, ["node_modules", "@rbxts", "react", "tags.lua"]);
	if (tagsPath === undefined) {
		return 0;
	}

	const names = reflectionPath === undefined ? [] : reflectionClassNames(reflectionPath);
	const body = [
		"-- generated by jest-roblox's emulator staging from the ree reflection dump",
		"-- replaces @rbxts/react/tags.lua (ReflectionService:GetClasses is not emulated under ree)",
		"local tags = {}",
		"local names = {",
		...names.map((name) => `\t"${name}",`),
		"}",
		"for _, name in names do",
		"\ttags[string.lower(name)] = name",
		"end",
		"return tags",
		"",
	].join("\n");
	fs.writeFileSync(tagsPath, body);
	return names.length;
}

function reflectionClassNames(reflectionPath: string): Array<string> {
	const reflection = JSON.parse(fs.readFileSync(reflectionPath, "utf-8")) as {
		classes?: Array<{ name: string }>;
	};
	return (reflection.classes ?? []).map((klass) => klass.name).sort();
}

/**
 * Replaces `_VERSION` reads in `@rbxts/serio` with the literal: the global is
 * absent from ree's module environments (it exists only at thread level) and
 * `IS_LUNE` would otherwise crash on the nil compare.
 */
function patchSerio(stageDirectory: string): number {
	const serioDirectory = findStageDirectory(stageDirectory, ["node_modules", "@rbxts", "serio"]);
	if (serioDirectory === undefined) {
		return 0;
	}

	let patched = 0;
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}

			if (!entry.name.endsWith(".luau") && !entry.name.endsWith(".lua")) {
				continue;
			}

			const text = fs.readFileSync(full, "utf-8");
			if (text.includes("_VERSION")) {
				fs.writeFileSync(full, text.replaceAll("_VERSION", '"Luau"'));
				patched += 1;
			}
		}
	};
	visit(serioDirectory);
	return patched;
}

function findStageFile(root: string, segments: Array<string>): string | undefined {
	const found = findStageDirectory(root, segments);
	return found;
}

function findStageDirectory(root: string, segments: Array<string>): string | undefined {
	const queue: Array<string> = [root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let entries: Array<fs.Dirent>;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (
					segments.length > 1 &&
					entry.name === segments[0] &&
					fs.existsSync(path.join(full, ...segments.slice(1)))
				) {
					return path.join(full, ...segments);
				}

				if (segments.length === 1 && entry.name === segments[0]) {
					return full;
				}

				queue.push(full);
			}
		}
	}

	return undefined;
}

/**
 * Writes `.jest-roblox/emulator/manifest.json` next to the stage so the
 * backend can map setup files and test roots to DataModel paths without
 * re-walking the Rojo project.
 */
function writeManifest(stageDirectory: string, mappings: Array<EmulatorStageMapping>): void {
	const manifest = {
		mappings: mappings.map((mapping) => ({
			dataModelPath: mapping.dataModelPath,
			fsPath: mapping.fsPath.replaceAll("\\", "/"),
		})),
	};
	fs.writeFileSync(path.join(stageDirectory, "manifest.json"), `${JSON.stringify(manifest, undefined, "\t")}\n`);
}

/**
 * Builds the stage. Returns the effective mounts; callers derive harness
 * mounts from `mappings` (one `--mount <dataModelPath>=<stage>/<dataModelPath>`
 * per entry) and resolve setup files through them.
 *
 * @param options - Project path, stage directory and reflection dump path.
 * @returns The stage root and effective mappings.
 */
export function stageEmulatorMounts(options: EmulatorStageOptions): EmulatorStageResult {
	const { rojoProjectPath, stageDirectory } = options;
	const project = loadRojoProject(rojoProjectPath);
	const mounts = collectMounts({
		classify: classifyPath,
		currentDataModelPath: "",
		node: project.tree,
	});

	fs.rmSync(stageDirectory, { force: true, recursive: true });
	fs.mkdirSync(stageDirectory, { recursive: true });

	const mappings = mounts.flatMap((mount) => copyMount(mount, stageDirectory));
	undotDirectories(stageDirectory);
	patchReactTags(stageDirectory, options.reflectionPath);
	patchSerio(stageDirectory);
	writeManifest(stageDirectory, mappings);

	return { mappings, stageDirectory };
}
