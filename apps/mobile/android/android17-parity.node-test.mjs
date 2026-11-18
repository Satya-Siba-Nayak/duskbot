import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const androidDir = fileURLToPath(new URL(".", import.meta.url));
const mobileDir = join(androidDir, "..");
const repoDir = join(mobileDir, "../..");

test("targets Android 17 (API 37) in variables.gradle and runs releaseGate on release builds", () => {
  const variables = readFileSync(join(androidDir, "variables.gradle"), "utf8");
  assert.match(variables, /minSdkVersion\s*=\s*24\b/);
  assert.match(variables, /compileSdkVersion\s*=.*37\b/);
  assert.match(variables, /targetSdkVersion\s*=\s*37\b/);

  const appGradle = readFileSync(join(androidDir, "app/build.gradle"), "utf8");
  assert.match(appGradle, /tasks\.register\('releaseGate',\s*Exec\)/);
  assert.match(appGradle, /dependsOn\s+'releaseGate'/);
});

test("AndroidManifest.xml complies with Android 17 adaptive orientation, App Links, network security, and Live Updates", () => {
  const manifest = readFileSync(join(androidDir, "app/src/main/AndroidManifest.xml"), "utf8");
  assert.doesNotMatch(manifest, /android:screenOrientation=/);
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.match(manifest, /android:host="dusk\.bot"/);
  assert.match(manifest, /android:pathPrefix="\/m\/"/);
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(manifest, /android\.permission\.POST_PROMOTED_NOTIFICATIONS/);

  const netConfig = readFileSync(join(androidDir, "app/src/main/res/xml/network_security_config.xml"), "utf8");
  assert.match(netConfig, /<domain-config cleartextTrafficPermitted="false">\s*<domain includeSubdomains="true">dusk\.bot<\/domain>/);
  assert.match(netConfig, /<domain includeSubdomains="true">ts\.net<\/domain>/);
});

test("registers iOS-inspired native plugins on Android and wires them in native-platform.ts", () => {
  const javaDir = join(androidDir, "app/src/main/java/bot/dusk/mobile");
  for (const file of ["MainActivity.java", "SpeechRecognizerPlugin.java", "OrientationPlugin.java", "PhoneNotificationsPlugin.java", "TurnActivityPlugin.java"]) {
    assert.equal(existsSync(join(javaDir, file)), true, `${file} should exist`);
  }

  const mainActivity = readFileSync(join(javaDir, "MainActivity.java"), "utf8");
  for (const plugin of ["SpeechRecognizerPlugin.class", "OrientationPlugin.class", "PhoneNotificationsPlugin.class", "TurnActivityPlugin.class"]) {
    assert.equal(mainActivity.includes(`registerPlugin(${plugin})`), true, `MainActivity should register ${plugin}`);
  }
  assert.match(mainActivity, /WindowCompat\.setDecorFitsSystemWindows\(window,\s*false\)/);
  assert.match(mainActivity, /LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS/);
  assert.match(mainActivity, /setFrameContentVelocity\(120f\)/);
  assert.match(mainActivity, /Math\.max\(90,\s*Math\.min\(135,/);

  const orientation = readFileSync(join(javaDir, "OrientationPlugin.java"), "utf8");
  assert.match(orientation, /@CapacitorPlugin\(name\s*=\s*"DuskOrientation"\)/);
  assert.match(orientation, /smallestScreenWidthDp\s*>=\s*600/);

  const notifications = readFileSync(join(javaDir, "PhoneNotificationsPlugin.java"), "utf8");
  assert.match(notifications, /@CapacitorPlugin\(name\s*=\s*"DuskNotifications"\)/);

  const turnActivity = readFileSync(join(javaDir, "TurnActivityPlugin.java"), "utf8");
  assert.match(turnActivity, /@CapacitorPlugin\(name\s*=\s*"DuskTurnActivity"\)/);
  assert.match(turnActivity, /android\.requestPromotedOngoing/);

  const nativePlatform = readFileSync(join(mobileDir, "src/native-platform.ts"), "utf8");
  assert.match(nativePlatform, /const turnActivityOn = Capacitor\.isPluginAvailable\("DuskTurnActivity"\);/);
  assert.match(nativePlatform, /const notificationsOn = Capacitor\.isPluginAvailable\("DuskNotifications"\);/);
});

test("blocks non-Android builds and disables automatic builds of other versions", () => {
  const rootPkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
  assert.match(rootPkg.scripts["mobile:release"], /cap sync android$/);

  const mobilePkg = JSON.parse(readFileSync(join(mobileDir, "package.json"), "utf8"));
  assert.match(mobilePkg.scripts.sync, /cap sync android$/);
  assert.match(mobilePkg.scripts.ios, /exit 1/);

  const iosCheck = spawnSync("bash", [join(mobileDir, "scripts/build-ios-release.sh"), "--check"], { encoding: "utf8" });
  assert.notEqual(iosCheck.status, 0);
  assert.match(iosCheck.stderr, /iOS builds are blocked/);

  for (const wf of ["release.yml", "server-image.yml", "link-agent-sign.yml", "link-chaos.yml", "windows-presence.yml"]) {
    const content = readFileSync(join(repoDir, ".github/workflows", wf), "utf8");
    const onSection = content.split(/^permissions:/m)[0] ?? "";
    assert.doesNotMatch(onSection, /^\s*(push|release|schedule|pull_request):/m, `${wf} should not auto-trigger`);
  }

  const botDesktop = readFileSync(join(repoDir, ".github/workflows/bot-desktop-image.yml"), "utf8");
  assert.match(botDesktop, /if:\s*github\.event_name\s*==\s*'workflow_dispatch'/);
});
