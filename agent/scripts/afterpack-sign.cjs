/**
 * Deterministic ad-hoc code signing for macOS builds.
 *
 * Without a paid Apple Developer ID we cannot notarize, but on Apple Silicon
 * the app MUST carry a *uniform, valid* ad-hoc signature or it will not run:
 *   - Electron's default leaves only a linker ad-hoc stub with no sealed
 *     resources -> "damaged and can't be opened".
 *   - Signing pieces with mismatched flags (e.g. hardened runtime on some but
 *     not all, or leaving the framework with its prebuilt signature) makes the
 *     dynamic loader reject the app at launch with "different Team IDs" even
 *     though `codesign --verify` statically passes.
 *
 * The fix is one recursive ad-hoc pass over the whole bundle with a single
 * identity and NO hardened runtime (hardened runtime is only for notarized
 * Developer ID builds). `--deep` here is correct precisely because ad-hoc
 * signing carries no entitlements to lose, so every nested Mach-O ends up with
 * the same empty Team ID and the loader is satisfied.
 *
 * IMPORTANT: builds are validated by actually launching them (npm run
 * verify:launch), not just `codesign --verify` — static verification passed
 * for a bundle that still refused to launch.
 */
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // Single recursive ad-hoc signature, no hardened runtime, resources sealed.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  // Fail the build loudly if the seal is somehow still invalid.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });

  console.log(`[afterpack-sign] ad-hoc signed + verified ${appName}.app`);
};
