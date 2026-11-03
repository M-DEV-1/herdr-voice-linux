import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ORB = join(dirname(fileURLToPath(import.meta.url)), "orb.js");
const MENU = { mute: 2, pane: 3, quit: 5 };

const busctl = (...args) => execFileSync("busctl", ["--user", "--json=short", ...args], { encoding: "utf8" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Needs gjs, the AppIndicator typelib and a session bus with a StatusNotifierWatcher, so it is skipped elsewhere.
function trayAvailable() {
  try {
    execFileSync("gjs", ["-c", "imports.gi.versions.AyatanaAppIndicator3='0.1'; imports.gi.AyatanaAppIndicator3"], { stdio: "ignore" });
    busctl("call", "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties", "Get", "ss", "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems");
    return true;
  } catch {
    return false;
  }
}

// The bus name that owns the orb's tray item, found in the watcher's list of registered items.
async function findItem() {
  for (let i = 0; i < 50; i++) {
    const items = JSON.parse(busctl("call", "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties", "Get", "ss", "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems")).data[0].data;
    const item = items.find((entry) => entry.endsWith("/herdr_voice"));
    if (item) return item.split("@")[0];
    await sleep(100);
  }
  throw new Error("orb never registered a tray item");
}

const menuLabels = (name) => [...busctl("call", name, "/org/ayatana/NotificationItem/herdr_voice/Menu", "com.canonical.dbusmenu", "GetLayout", "iias", "0", "--", "-1", "0").matchAll(/"label":\{"type":"s","data":"([^"]*)"/g)].map((match) => match[1]);
const choose = (name, id) => busctl("call", name, "/org/ayatana/NotificationItem/herdr_voice/Menu", "com.canonical.dbusmenu", "Event", "isvu", String(id), "clicked", "s", "", "0");

test("tray icon follows the stdin protocol, reports menu choices on stdout, and exits when stdin closes", { skip: !trayAvailable() && "no gjs, AppIndicator or StatusNotifierWatcher" }, async () => {
  const orb = spawn("gjs", [ORB], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = [];
  orb.stdout.setEncoding("utf8");
  orb.stdout.on("data", (chunk) => lines.push(...chunk.split("\n").filter(Boolean).map((line) => JSON.parse(line))));
  const send = (obj) => orb.stdin.write(`${JSON.stringify(obj)}\n`);

  try {
    const name = await findItem();
    send({ mood: "thinking" });
    send({ pane: "hidden" });
    orb.stdin.write("not json\n");
    await sleep(300);
    assert.deepEqual(menuLabels(name), ["Mute", "Show voice pane", "Quit herdr-voice"]);

    send({ mood: "muted" });
    await sleep(300);
    assert.deepEqual(menuLabels(name), ["Unmute", "Show voice pane", "Quit herdr-voice"]);

    choose(name, MENU.mute);
    choose(name, MENU.pane);
    choose(name, MENU.quit);
    await sleep(300);
    assert.deepEqual(lines, [{ click: "mute" }, { menu: "toggle-pane" }, { menu: "quit" }]);
  } finally {
    orb.stdin.end();
  }
  const [code] = await Promise.race([once(orb, "exit"), sleep(3000).then(() => { orb.kill(); throw new Error("orb did not exit after stdin closed"); })]);
  assert.equal(code, 0);
});
