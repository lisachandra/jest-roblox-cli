import { collectMounts, loadRojoProject, type Mount } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

/**
 * How many dropped links the staging warning names before it stops listing
 * them. A broken link is one line of diagnosis; a hundred is a wall.
 */
const MAX_REPORTED_DROPPED_LINKS = 10;

/**
 * Materializes the physical mount tree `ree` runs against.
 *
 * Ree mounts real directories, not Rojo projects: it does not follow Windows
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
	/** Slash-separated DataModel path the copy mounts at. */
	dataModelPath: string;
	/** Absolute source directory the copy read from. */
	fsPath: string;
}

/**
 * The stage the stager built: the physical tree plus the mounts in effect.
 */
export interface EmulatorStageResult {
	/** Mounts in effect after nested-project expansion, in copy order. */
	mappings: Array<EmulatorStageMapping>;
	/** Absolute stage root the mounts mirror into. */
	stageDirectory: string;
}

/**
 * Inputs for {@link stageEmulatorMounts}.
 */
export interface EmulatorStageOptions {
	/** Absolute path of the vendored ree `reflection.json` (tags.lua patch). */
	reflectionPath?: string | undefined;
	/** Absolute path of the Rojo project describing the DataModel. */
	rojoProjectPath: string;
	/** Absolute directory the stage tree is written under. */
	stageDirectory: string;
}

interface NestedProject {
	name: string;
	sourceDirectory: string;
}

/**
 * The stage tree lacks a mount the launch would pass to ree.
 *
 * A mapping can be emitted without its directory landing: `copyDeref` walks
 * away from a source whose realpath no longer resolves (a link that dangled
 * between the mount scan and the copy), and the walk of a large tree can be
 * interrupted without failing the mount as a whole. Neither leaves an error
 * behind, and ree only finds out at launch — as a bare "cannot find the path
 * specified" that names no source. This error carries both ends of the pair
 * instead, at the phase that built it.
 */
export class EmulatorStagingError extends Error {
	/** The mappings that did not land, in copy order. */
	public readonly missing: ReadonlyArray<EmulatorStageMapping>;
	/** The constructor name, so a cross-realm copy still reads as its own. */
	public override readonly name = "EmulatorStagingError";
	/** Absolute stage root the mounts were written under. */
	public readonly stageDirectory: string;

	/**
	 * Builds the message from the mappings the stage is missing.
	 *
	 * @param options - The mappings that did not land and the stage root.
	 */
	constructor({
		missing,
		stageDirectory,
	}: {
		missing: ReadonlyArray<EmulatorStageMapping>;
		stageDirectory: string;
	}) {
		const lines = missing.map((mapping) => {
			const gone = fs.existsSync(mapping.fsPath) ? "" : " (its source is gone too)";
			return `  ${mapping.dataModelPath} <- ${mapping.fsPath}${gone}`;
		});
		super(
			[
				`emulator staging did not produce ${missing.length.toString()} mapped path(s) under ${stageDirectory}:`,
				...lines,
				'ree would fail at launch with a bare "cannot find the path specified"; fix the mount source or the Rojo project entry.',
			].join("\n"),
		);
		this.missing = missing;
		this.stageDirectory = stageDirectory;
	}
}

/**
 * Builds the stage. Returns the effective mounts; callers derive harness
 * mounts from `mappings` (one `--mount
 * <dataModelPath>=<stage>/<dataModelPath>` per entry) and resolve setup files
 * through them.
 *
 * @param options - Project path, stage directory and reflection dump path.
 * @returns The stage root and effective mappings.
 */
export function stageEmulatorMounts(options: EmulatorStageOptions): EmulatorStageResult {
	const { rojoProjectPath, stageDirectory } = options;
	const project = loadRojoProject(rojoProjectPath);
	const projectDirectory = path.dirname(path.resolve(rojoProjectPath));
	const mounts = collectMounts({
		classify: classifyPath,
		currentDataModelPath: "",
		node: project.tree,
	}).map((mount) => {
		return {
			...mount,
			// Rojo resolves relative `$path`s against the project file's
			// directory; the mappings must be absolute so path-prefix matching
			// against absolute test-file paths (rootDir-joined) works downstream.
			fsPath: path.isAbsolute(mount.fsPath)
				? mount.fsPath
				: path.resolve(projectDirectory, mount.fsPath),
		};
	});

	fs.rmSync(stageDirectory, { force: true, recursive: true });
	fs.mkdirSync(stageDirectory, { recursive: true });

	const mappings = mounts.flatMap((mount) => copyMount(mount, stageDirectory));
	undotDirectories(stageDirectory);
	patchReactTags(stageDirectory, options.reflectionPath);
	patchSerio(stageDirectory);
	writeManifest(stageDirectory, mappings);

	// Not asserted here: the backend verifies the result and rebuilds once on a
	// miss (see `EmulatorBackend.prepareOnce`), which it cannot do if this
	// throws on the first attempt.
	return { mappings, stageDirectory };
}

/**
 * Fails when a mapping has no directory under the stage root.
 *
 * The check runs at the end of staging and again immediately before a launch,
 * so a stage tree that was cleaned or half-written between the two cannot
 * reach ree as a path miss. It is a handful of `existsSync` calls against a
 * stage built once per run — cheaper than one misdiagnosed ree failure.
 *
 * @param options - The mappings to check and the stage root they should sit under.
 * @throws {EmulatorStagingError} Naming every mapping the stage is missing.
 */
export function assertStagedMounts({
	mappings,
	stageDirectory,
}: {
	mappings: ReadonlyArray<EmulatorStageMapping>;
	stageDirectory: string;
}): void {
	const missing = mappings.filter((mapping) => {
		return !fs.existsSync(path.join(stageDirectory, mapping.dataModelPath));
	});

	if (missing.length > 0) {
		throw new EmulatorStagingError({ missing, stageDirectory });
	}
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
 *
 * @param packageDirectory
 * @returns The declared name and `$path` source directory, or undefined.
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
	const { name } = record;
	const treePath = record.tree?.$path;
	if (typeof name !== "string" || typeof treePath !== "string") {
		return undefined;
	}

	return { name, sourceDirectory: path.join(packageDirectory, treePath) };
}

/**
 * Copies a tree into the stage with its junctions and symlinks dereferenced.
 *
 * The copy starts from the source's real path, not the path it was named by.
 * A pnpm package reached through one workspace (`server/node_modules/@rbxts/
 * muster`, itself a link into `packages/@internal/muster`) still carries the
 * relative links its own `node_modules` was built with, and Windows resolves
 * those against the spelled path rather than the resolved one: `realpath`
 * finds the target, and the very next `stat` returns `ENOENT`. Entering from
 * the real path makes every inner link resolve as its author intended.
 *
 * A link that does not resolve even from there is dropped, with a warning. The
 * ones this layout produces point at type-only packages — `@rbxts/types` and
 * friends, reached through a sibling workspace's `node_modules` — so there is
 * no runtime code behind them to miss.
 *
 * @param source - Tree to copy, as the mount names it.
 * @param destination - Where the copy lands.
 */
function copyDeref(source: string, destination: string): void {
	let realSource: string;
	try {
		realSource = fs.realpathSync(source);
	} catch {
		// Gone between the mount scan and the copy: nothing to project.
		return;
	}

	const dropped: Array<string> = [];
	fs.cpSync(realSource, destination, {
		dereference: true,
		filter: (candidate) => {
			const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
			if (stats?.isSymbolicLink() !== true) {
				return true;
			}

			if (fs.statSync(candidate, { throwIfNoEntry: false }) !== undefined) {
				return true;
			}

			dropped.push(candidate);
			return false;
		},
		recursive: true,
		verbatimSymlinks: false,
	});

	if (dropped.length > 0) {
		const listing = dropped
			.slice(0, MAX_REPORTED_DROPPED_LINKS)
			.map((entry) => `  ${path.relative(realSource, entry)}`);
		const omitted = dropped.length - listing.length;
		if (omitted > 0) {
			listing.push(`  …and ${omitted.toString()} more`);
		}

		const headline = `Staged without ${dropped.length.toString()} unresolvable link(s) under ${realSource}:`;
		process.stderr.write(`${color.dim(headline)}\n${listing.join("\n")}\n`);
	}
}

/**
 * Projects one nested package into the stage under its declared name,
 * replacing the verbatim copy the dereferencing mount copy made.
 *
 * @param root0
 * @returns The mapping the projection produced.
 */
function projectNestedPackage({
	instancePrefix,
	nested,
	packageDirectory,
	stageDirectory,
}: {
	instancePrefix: string;
	nested: NestedProject;
	packageDirectory: string;
	stageDirectory: string;
}): EmulatorStageMapping {
	// Rojo's nested-project rule: the package folder is REPLACED by the
	// declared name (e.g. `@rbxts-js/roblox-shared` mounts as
	// `@rbxts-js/RobloxShared` with the `$path` contents), so drop the
	// verbatim copy `copyDeref` made before projecting.
	fs.rmSync(path.join(stageDirectory, instancePrefix, path.basename(packageDirectory)), {
		force: true,
		recursive: true,
	});
	const nestedInstance = `${instancePrefix}/${nested.name}`;
	const nestedDestination = path.join(stageDirectory, nestedInstance);
	fs.rmSync(nestedDestination, { force: true, recursive: true });
	copyDeref(nested.sourceDirectory, nestedDestination);
	return { dataModelPath: nestedInstance, fsPath: nested.sourceDirectory };
}

/**
 * Recursively replaces directories holding a `default.project.json` inside a
 * plain directory mount with their declared-name projection. Directory sync
 * mirrors everything else verbatim.
 * @param root0
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
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith(".")) {
			// Dot entries never sync in Rojo directory mounts (pnpm's .pnpm
			// store included) — walking them would only reach dangling links.
			continue;
		}

		const packageDirectory = path.join(directory, entry.name);
		// readdir reports Windows junctions as symlinks (`isDirectory()` is
		// false for every junctioned package in a pnpm tree) — stat through
		// the link instead; dangling links stat as missing and are skipped.
		const stat = fs.statSync(packageDirectory, { throwIfNoEntry: false });
		if (stat === undefined || !stat.isDirectory()) {
			continue;
		}

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

		mappings.push(
			projectNestedPackage({ instancePrefix, nested, packageDirectory, stageDirectory }),
		);
	}
}

/**
 * Copies one Rojo mount into the stage. Directories are copied
 * junction-dereferenced; a mount whose directory is itself a nested project
 * (or a directory holding nested projects at any depth — the roblox-ts
 * `node_modules` layout) is copied per Rojo's nested-project rule: the
 * project's `$path` contents mount under the declared name.
 *
 * @param mount
 * @param stageDirectory
 * @returns The effective mappings the copy produced.
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
 * Renames every dot-prefixed directory in the stage to `_<name>`: ree's
 * mounter skips dot entries and the harness renames them back before the
 * first require.
 * @param root
 */
function undotDirectories(root: string): void {
	const entries = fs.readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
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

function reflectionClassNames(reflectionPath: string): Array<string> {
	const parsed: unknown = JSON.parse(fs.readFileSync(reflectionPath, "utf-8"));
	if (typeof parsed !== "object" || parsed === null || !("classes" in parsed)) {
		return [];
	}

	const classes: unknown = parsed.classes;
	if (!Array.isArray(classes)) {
		return [];
	}

	const names: Array<string> = [];
	for (const klass of classes) {
		if (typeof klass !== "object" || klass === null || !("name" in klass)) {
			continue;
		}

		const name: unknown = klass.name;
		if (typeof name === "string") {
			names.push(name);
		}
	}

	return names.sort();
}

/**
 * Resolves the stage path for a matched `segments[0]` directory: `directory`
 * IS that directory, and the rest of the path lives inside it. Returning
 * `directory + segments` would double the first segment (the rbxts_include
 * mount is itself named `node_modules`, so the naive join produced
 * `.../node_modules/node_modules/...`.
 * @param directory
 * @param segments
 * @returns The stage path, or undefined when the remaining segments are absent.
 */
function matchStageSegments(directory: string, segments: Array<string>): string | undefined {
	if (segments.length > 1 && fs.existsSync(path.join(directory, ...segments.slice(1)))) {
		return path.join(directory, ...segments.slice(1));
	}

	if (segments.length === 1) {
		return directory;
	}

	return undefined;
}

/**
 * Reads a stage directory's entries, or undefined when it cannot be listed.
 *
 * @param directory - Directory to list.
 * @returns The dirents, or undefined on failure.
 */
function readStageEntries(directory: string): Array<fs.Dirent> | undefined {
	try {
		return fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return undefined;
	}
}

function findStageDirectory(root: string, segments: Array<string>): string | undefined {
	const queue: Array<string> = [root];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			break;
		}

		const entries = readStageEntries(current);
		if (entries === undefined) {
			continue;
		}

		const candidates = entries.filter(
			(entry) => entry.isDirectory() && !entry.name.startsWith("."),
		);
		for (const entry of candidates) {
			const full = path.join(current, entry.name);
			if (entry.name === segments[0]) {
				const found = matchStageSegments(full, segments);
				if (found !== undefined) {
					return found;
				}
			}

			queue.push(full);
		}
	}

	return undefined;
}

function findStageFile(root: string, segments: Array<string>): string | undefined {
	return findStageDirectory(root, segments);
}

/**
 * Rewrites `@rbxts/react`'s `tags.lua` from the vendored ree reflection dump:
 * the module reads `ReflectionService:GetClasses()`, which ree does not
 * emulate, so the staged copy carries the class table inline instead.
 *
 * @param stageDirectory
 * @param reflectionPath
 * @returns The number of class names written into the patch.
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

/**
 * Replaces `_VERSION` reads in `@rbxts/serio` with the literal: the global is
 * absent from ree's module environments (it exists only at thread level) and
 * `IS_LUNE` would otherwise crash on the nil compare.
 *
 * @param stageDirectory
 * @returns The number of files patched.
 */
function patchSerio(stageDirectory: string): number {
	const serioDirectory = findStageDirectory(stageDirectory, ["node_modules", "@rbxts", "serio"]);
	if (serioDirectory === undefined) {
		return 0;
	}

	let patched = 0;
	function visitDirectory(directory: string): void {
		const entries = fs.readdirSync(directory, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visitDirectory(full);
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
	}

	visitDirectory(serioDirectory);
	return patched;
}

/**
 * Writes `.jest-roblox/emulator/manifest.json` next to the stage so the
 * backend can map setup files and test roots to DataModel paths without
 * re-walking the Rojo project.
 * @param stageDirectory
 * @param mappings
 */
function writeManifest(stageDirectory: string, mappings: Array<EmulatorStageMapping>): void {
	const manifest = {
		mappings: mappings.map((mapping) => {
			return {
				dataModelPath: mapping.dataModelPath,
				fsPath: mapping.fsPath.replaceAll("\\", "/"),
			};
		}),
	};
	fs.writeFileSync(
		path.join(stageDirectory, "manifest.json"),
		`${JSON.stringify(manifest, undefined, "\t")}\n`,
	);
}
