import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { collectRojoMounts, containsMatchingFile, resolveMountWithin } from "./root-reachability.ts";

describe(resolveMountWithin, () => {
	it.for(["/", "D:/"])("should exclude the namespace frame itself for %s", (frame) => {
		expect.assertions(1);

		expect(resolveMountWithin(frame, { frame, rojoDirectory: frame })).toBeUndefined();
	});
});

describe(collectRojoMounts, () => {
	it("should return only declared mounts and collapse repeated paths", () => {
		expect.assertions(1);

		expect(
			collectRojoMounts(
				{
					$className: "DataModel",
					First: { $path: "out" },
					Second: { $path: "out" },
				},
				"D:/project",
			),
		).toStrictEqual(new Set(["D:/project/out"]));
	});

	it("should return the inner path of an optional mount", () => {
		expect.assertions(1);

		expect(
			collectRojoMounts(
				{
					$className: "DataModel",
					DevPackages: { $path: { optional: "DevPackages" } },
				},
				"D:/project",
			),
		).toStrictEqual(new Set(["D:/project/DevPackages"]));
	});
});

describe(containsMatchingFile, () => {
	function isLuau(name: string): boolean {
		return name.endsWith(".luau");
	}

	it("should match a file the directory holds directly", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out", { recursive: true });
		volume.writeFileSync("out/init.luau", "");
		volume.writeFileSync("out/readme.md", "");

		expect(containsMatchingFile(fileSystem, { directoryPath: "out", matches: isLuau })).toBe(
			true,
		);
		expect(containsMatchingFile(fileSystem, { directoryPath: "out", matches: () => false })).toBe(
			false,
		);
	});

	it("should match a file a subdirectory holds", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out/shared", { recursive: true });
		volume.writeFileSync("out/readme.md", "");
		volume.writeFileSync("out/shared/player.luau", "");

		expect(containsMatchingFile(fileSystem, { directoryPath: "out", matches: isLuau })).toBe(
			true,
		);
	});

	// Every entry of a pnpm-mounted `node_modules/@scope` folder is a link to a
	// package, and a `Dirent` reports only the reparse bit: a walk that trusts
	// `isDirectory` read the linked package as a file and answered "no luau
	// here" for a subtree that is all luau, dropping every mounted package from
	// root detection. The volume is addressed absolutely throughout — a
	// junction's target always is, and a relative path anchors to a cwd the
	// volume does not hold.
	it("should descend into a link to a directory", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/store/matter/out", { recursive: true });
		volume.writeFileSync("/store/matter/out/init.luau", "");
		volume.mkdirSync("/mount/@lisachandra", { recursive: true });
		volume.symlinkSync("/store/matter", "/mount/@lisachandra/matter");

		expect(
			containsMatchingFile(fileSystem, { directoryPath: "/mount/@lisachandra", matches: isLuau }),
		).toBe(true);

		// A link whose target holds no match is descended into and answered
		// honestly, not skipped.
		volume.mkdirSync("/store/empty", { recursive: true });
		volume.symlinkSync("/store/empty", "/mount/@lisachandra/empty");

		expect(
			containsMatchingFile(fileSystem, { directoryPath: "/mount/@lisachandra", matches: isLuau }),
		).toBe(true);
	});

	it("should match a file reached through a link", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/store", { recursive: true });
		volume.writeFileSync("/store/init.luau", "");
		volume.mkdirSync("/mount", { recursive: true });
		volume.symlinkSync("/store/init.luau", "/mount/entry.luau");

		expect(containsMatchingFile(fileSystem, { directoryPath: "/mount", matches: isLuau })).toBe(
			true,
		);
	});

	it("should answer false when a link dangles", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("mount", { recursive: true });
		volume.symlinkSync("/nowhere/matter", "mount/matter");

		expect(
			containsMatchingFile(fileSystem, { directoryPath: "mount", matches: isLuau }),
		).toBe(false);

		// A dangling link beside real content answers for the content.
		volume.writeFileSync("mount/init.luau", "");

		expect(
			containsMatchingFile(fileSystem, { directoryPath: "mount", matches: isLuau }),
		).toBe(true);
	});

	it("should not revisit a directory a link points back at", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		// pnpm workspace links point at the store, but a package can link back
		// to the mounted tree itself; the walk has to end either way. No match
		// exists anywhere, so only the visited set stops the recursion.
		volume.mkdirSync("/mount/@lisachandra/matter", { recursive: true });
		volume.symlinkSync("/mount/@lisachandra", "/mount/@lisachandra/matter/self");

		expect(
			containsMatchingFile(fileSystem, { directoryPath: "/mount/@lisachandra", matches: isLuau }),
		).toBe(false);
	});
});
