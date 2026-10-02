import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${command} failed (${result.status ?? result.signal})`);
	return result;
}

// Local builds need a stable certificate-backed requirement to retain TCC grants.
// Never silently fall back to an ad-hoc signature. Do not pin personal identities
// in the repository; discover the available development certificate instead.
const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], {
	encoding: "utf8",
	stdio: "pipe",
});
const available = [...identities.stdout.matchAll(/"(Apple Development:[^"]+)"/g)].map(
	(match) => match[1],
);
const unique = [...new Set(available)];
const identity =
	process.env.RECORDLY_LOCAL_SIGNING_IDENTITY || (unique.length === 1 ? unique[0] : null);
if (!identity || !unique.includes(identity)) {
	throw new Error(
		"Select an available Apple Development certificate using RECORDLY_LOCAL_SIGNING_IDENTITY. A stable signing identity is required for local builds.",
	);
}
console.log(`[local-mac] Using ${identity}`);
run("npm", ["run", "build:mac:prepare"]);
run("npx", [
	"electron-builder",
	"--mac",
	"--arm64",
	"--publish",
	"never",
	"-c.mac.type=development",
	"-c.mac.timestamp=none",
	`-c.mac.identity=${identity}`,
	"-c.forceCodeSigning=true",
	"-c.electronDist=node_modules/electron/dist",
]);
run("codesign", ["--verify", "--deep", "--strict", "release/mac-arm64/Recordly.app"]);
