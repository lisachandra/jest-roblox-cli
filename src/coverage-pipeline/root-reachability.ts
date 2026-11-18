import { collectPaths, resolveMountPath } from "@isentinel/rojo-utils";

import process from "node:process";

import type { RojoTreeNode } from "../types/rojo.ts";
import type { Dirent, FileSystem, Stats } from "../utils/file-system.ts";
import {
	normalizeWindowsPath,
	relativeToRoot,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";
import { isWithinRoot } from "./redirect-path.ts";

/** One `luauRoots` entry, weighed against a project's rojo `$path` mounts. */
export interface RootReachability {
	/** What `rawRoot` resolves against, and the frame the warning speaks in. */
	base: string;
	/** Absolute mounts, from {@link collectRojoMounts}. */
	mounts: Set<string>;
	/** The entry as the user wrote it, echoed back in the warning. */
	rawRoot: string;
	/** Who declared the entry. Named in the warning when the mode has one. */
	subject?: string | undefined;
}

/**
 * Where a rojo `$path` is read from, and the frame the answer is written in.
 */
export interface MountFrame {
	/**
	 * What a coverage root is written relative to: the package directory in
	 * workspace mode, `rootDir` in single and multi mode. Both are the same
	 * thing — synthesis resolves a root against the package directory, and a
	 * single-mode run is one synthetic package rooted at `rootDir`.
	 */
	frame: string;
	/** What a `$path` resolves against — the rojo project's own directory. */
	rojoDirectory: string;
}

/**
 * Whether a directory tree holds a file whose name `matches` accepts.
 *
 * A link to a directory is descended into. The `$path` mounts this judges name
 * pnpm workspace links — every entry of a mounted `node_modules/@scope` folder
 * is a junction on Windows and a symlink elsewhere — and a `Dirent` reports
 * only the reparse bit, so a walk that trusts `isDirectory` reads a linked
 * package as a file and answers "no luau here" for a subtree that is all luau.
 * That answer is what dropped every mounted package from root detection in a
 * pnpm workspace, leaving the lane reporting nothing but its own `out`.
 *
 * Cycle-guarded the way the shadow walker is: keyed on the resolved path, so
 * the same directory reached by two names is entered once.
 * @param fileSystem - File system to walk.
 * @param search - Directory to walk and the file-name test.
 * @param search.directoryPath - Directory to walk.
 * @param search.matches - Accepts a file name.
 * @returns True when some file under the directory matches.
 */
export function containsMatchingFile(
	fileSystem: FileSystem,
	{ directoryPath, matches }: { directoryPath: string; matches: (name: string) => boolean },
): boolean {
	// Forward slashes throughout: `path.join` writes the host separator, and
	// every path here is read through a file system that may not be the host's.
	return directoryHoldsMatch(normalizeWindowsPath(directoryPath), new Set<string>());

	/**
	 * One directory's turn, with every link entered so far behind `visited`.
	 * @param directory - Directory to read.
	 * @param visited - Resolved paths of the links already descended into.
	 * @returns True when some file under the directory matches.
	 */
	function directoryHoldsMatch(directory: string, visited: Set<string>): boolean {
		let entries: Array<Dirent>;
		try {
			entries = fileSystem.readdirSync(directory, { withFileTypes: true });
		} catch {
			// A dangling link or an unreadable directory holds nothing to match;
			// the walk above it still answers for the rest of the tree.
			return false;
		}

		return entries.some((entry) => {
			if (entry.isFile() && matches(entry.name)) {
				return true;
			}

			if (entry.isDirectory()) {
				return directoryHoldsMatch(`${directory}/${entry.name}`, visited);
			}

			if (!entry.isSymbolicLink()) {
				return false;
			}

			// A link's `Dirent` says only "link": `stat` resolves whether the
			// target is a file whose name matches or a directory to enter.
			const child = `${directory}/${entry.name}`;
			let stats: Stats;
			try {
				stats = fileSystem.statSync(child);
			} catch {
				// Dangling link: nothing behind it.
				return false;
			}

			if (stats.isFile()) {
				return matches(entry.name);
			}

			if (!stats.isDirectory()) {
				return false;
			}

			let real: string;
			try {
				real = normalizeWindowsPath(fileSystem.realpathSync(child));
			} catch {
				return false;
			}

			if (visited.has(real)) {
				return false;
			}

			visited.add(real);
			return directoryHoldsMatch(child, visited);
		});
	}
}

/**
 * Every `$path` mount in a rojo tree, absolute. Rojo resolves a `$path`
 * against the project's own directory, and so does synthesis, so a mount set
 * built against anything else would describe a place we do not build.
 *
 * Takes the loaded tree rather than a path so a caller that already read the
 * project does not read it twice.
 * @param tree - Loaded rojo project tree.
 * @param rojoDirectory - Directory holding the rojo project.
 * @returns Normalized absolute mount paths.
 */
export function collectRojoMounts(tree: RojoTreeNode, rojoDirectory: string): Set<string> {
	const collected: Array<string> = [];
	collectPaths(tree, collected);

	// Drive letter upper-cased on top of the mount rule: every root these are
	// weighed against arrives through `normalizeWindowsPath`, and two spellings
	// of one drive compare unequal.
	return new Set(
		collected.map((rawPath) => {
			return normalizeWindowsPath(resolveMountPath(inCwdFrame(rojoDirectory), rawPath));
		}),
	);
}

/**
 * The warning for a `luauRoot` no `$path` in the project reaches, or
 * `undefined` when the root is good.
 *
 * A root earns its coverage two ways. A mount that lands on it or inside it is
 * redirected into the shadow outright. A mount *above* it is demoted instead:
 * that mount's `$path` moves onto a spine copy and the root hangs underneath
 * as an explicit child. Either direction of containment reaches the root, so
 * only one standing off the tree altogether reports nothing.
 * @param reachability - The root, its base, the mounts and the declaring
 * subject.
 * @returns Warning text, or `undefined` when a mount reaches the root.
 */
export function unreachableRootWarning({
	base,
	mounts,
	rawRoot,
	subject,
}: RootReachability): string | undefined {
	// Resolved exactly as the mounts were. A root and a mount only ever meet
	// here, so a rule that differs by side answers "does not reach" for two
	// spellings of one directory.
	const root = normalizeWindowsPath(resolveMountPath(inCwdFrame(base), rawRoot));
	const isReached = [...mounts].some((mount) => {
		return isWithinRoot(mount, root) || isWithinRoot(root, mount);
	});
	if (isReached) {
		return undefined;
	}

	const owner = subject === undefined ? "" : ` in ${subject}`;
	return `Warning: luauRoot "${rawRoot}"${owner} does not correspond to any rojo $path mount, so it reports no coverage.\n`;
}

/**
 * A rojo `$path` as a coverage root inside `frame`, or `undefined` when it
 * lands outside one.
 *
 * The question every mode asks of a mount before taking it as a root, so that
 * they cannot answer it differently. Whether the `$path` is written absolute
 * is not the question: an absolute one under the frame names a root the shadow
 * can mirror, and a relative `../outside/out` names one it cannot.
 *
 * Judged on the resolved path, not the spelling — `src/..` names the frame and
 * a directory honestly called `..cache` does not escape it.
 * @param rawPath - The `$path` as written in the project.
 * @param mountFrame - The frame and the rojo project directory.
 * @returns Root relative to the frame, or `undefined` when outside it or equal
 * to it.
 */
export function resolveMountWithin(
	rawPath: string,
	{ frame, rojoDirectory }: MountFrame,
): string | undefined {
	const base = toPosixRoot(inCwdFrame(frame));
	// Resolved exactly as {@link collectRojoMounts} resolves the same `$path`:
	// a root is weighed against that mount set, so a second reading of what
	// "absolute" means would let a root and the mount it came from disagree.
	const absolute = toPosixRoot(resolveMountPath(inCwdFrame(rojoDirectory), rawPath));
	// The frame is what roots are written from, not a root within it, so it
	// does not name one itself. `relativeToRoot` answers for the rest —
	// including a frame that is a file-system root, where `path.relative`
	// would resolve the root against the cwd instead.
	return absolute === base ? undefined : relativeToRoot(base, absolute);
}

/**
 * A directory in the frame every mount here is stated in.
 *
 * A rojo directory arrives relative whenever the project was named relative —
 * `path.dirname("default.project.json")` is `"."` — and a mount joined onto
 * that is relative too, so it could never sit inside an absolute frame and the
 * whole project would report no roots. The cwd is what a relative one is
 * written against, and `resolveMountPath` leaves an absolute one alone.
 * @param directory - Absolute or cwd-relative directory.
 * @returns Absolute directory.
 */
function inCwdFrame(directory: string): string {
	return resolveMountPath(normalizeWindowsPath(process.cwd()), directory);
}
