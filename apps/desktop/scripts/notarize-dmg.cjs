// electron-builder's afterAllArtifactBuild hook (electron-builder.yml). It
// notarizes the app but not the .dmg around it, so a downloaded dmg would
// carry no signature or ticket of its own. For each dmg this signs it with
// the same Developer ID as the app inside, submits it to Apple's notary
// service and staples the ticket. It skips a dmg whose app isn't signed with
// a Developer ID (an unsigned CI build) and does nothing without the App
// Store Connect API key variables that notarization uses
// (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER).
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

function signingIdentity(app) {
  // codesign prints the details on stderr.
  const details = spawnSync("codesign", ["-dvv", app], { encoding: "utf8" });
  return `${details.stdout}${details.stderr}`.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
}

exports.default = async function notarizeDmgs(result) {
  const dmgs = result.artifactPaths.filter((path) => path.endsWith(".dmg"));
  if (!dmgs.length) return [];
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!key || !keyId || !issuer) {
    console.log("  • skipped dmg notarization  reason=APPLE_API_KEY, APPLE_API_KEY_ID or APPLE_API_ISSUER is not set");
    return [];
  }
  for (const dmg of dmgs) {
    const arch = dmg.includes("-arm64.") ? "mac-arm64" : dmg.includes("-universal.") ? "mac-universal" : "mac";
    const app = join(dirname(dmg), arch, `${result.configuration.productName ?? "Uplink Room"}.app`);
    const identity = existsSync(app) ? signingIdentity(app) : undefined;
    if (!identity) {
      console.log(`  • skipped dmg notarization  file=${dmg} reason=its app isn't signed with a Developer ID`);
      continue;
    }
    console.log(`  • signing and notarizing dmg  file=${dmg}`);
    execFileSync("codesign", ["--sign", identity, "--timestamp", "--force", dmg], { stdio: "inherit" });
    execFileSync(
      "xcrun",
      ["notarytool", "submit", dmg, "--key", key, "--key-id", keyId, "--issuer", issuer, "--wait"],
      { stdio: "inherit" },
    );
    // Stapling fails unless Apple accepted the submission, which fails the build.
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
