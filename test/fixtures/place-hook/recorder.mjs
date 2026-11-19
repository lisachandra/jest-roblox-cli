// Recorder invoked by src/utils/place-hook.spec.ts as a real subprocess:
//
//   node recorder.mjs <marker> <markerFile> <placeArgFile> <placePath>
//
// Writes <marker> to <markerFile> and <placePath> to <placeArgFile>, so the
// spec can prove both which hook ran and what `applyPlaceHook` substituted for
// the {placeFile} token. Exits 1 when <marker> is "fail".
import fs from "node:fs";

const [, , marker, markerFile, placeArgFile, placePath] = process.argv;

if (marker === "fail") {
	process.exit(1);
}

fs.writeFileSync(markerFile, marker);

if (placePath !== undefined) {
	fs.writeFileSync(placeArgFile, placePath);
}
