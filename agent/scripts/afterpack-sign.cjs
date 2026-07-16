/**
 * Deterministic ad-hoc code signing for macOS builds.
 *
 * Without a paid Apple Developer ID we cannot notarize, but we MUST still
 * produce a *valid* signature with the app's resources sealed. Electron's
 * default build leaves only a linker ad-hoc signature ("Identifier=Electron",
 * no sealed resources); on Apple Silicon macOS rejects that as "damaged and
 * can't be opened". A proper `codesign --force --deep --sign -` seals the
 * bundle so the app launches (after the user clears the download quarantine
 * or right-click → Open).
 *
 * Nested code is signed inside-out first, then the outer bundle last, which
 * is what codesign requires for a valid seal.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function sign(target) {
  execFileSync(
    "codesign",
    ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", target],
    { stdio: "inherit" }
  );
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const frameworks = path.join(appPath, "Contents", "Frameworks");

  // 1) nested frameworks and helper apps, deepest first
  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const p = path.join(frameworks, entry);
      if (entry.endsWith(".app")) {
        const inner = path.join(p, "Contents", "MacOS");
        if (fs.existsSync(inner)) {
          for (const bin of fs.readdirSync(inner)) sign(path.join(inner, bin));
        }
        sign(p);
      } else {
        sign(p); // .framework / .dylib
      }
    }
  }

  // 2) the outer bundle last
  sign(appPath);
  console.log(`[afterpack-sign] ad-hoc signed ${appName}.app`);
};
