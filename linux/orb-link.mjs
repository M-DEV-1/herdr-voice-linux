// Connects the tray icon (orb.js, run with gjs) to a herdr-voice Session. It sends the icon the mood, the loudness and whether the voice pane is showing, and passes the icon's clicks and menu choices back as callbacks.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ORB_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'orb.js');
const TICK_MS = 100;
const PANE_REFRESH_MS = 5000;

// Whether gjs and the AppIndicator typelib that orb.js needs are installed.
export function orbAvailable() {
  return spawnSync('gjs', ['-c', "imports.gi.versions.AyatanaAppIndicator3='0.1'; imports.gi.AyatanaAppIndicator3"], { stdio: 'ignore' }).status === 0;
}

// The tray icon's mood for a session: offline, muted, user, assistant, thinking or listening, in that order of priority. A session closed on purpose for being quiet still hears you, so it counts as listening.
export function moodOf(s) {
  if (s.closed) return 'offline';
  if (s.muted) return 'muted';
  if (!(s.status === 'live' && s.established) && !s.dormant) return 'offline';
  if (s.gate.isOpen || s.midTurn) return 'user';
  if (s.speaker.isSpeaking) return 'assistant';
  if (s.toolsRunning > 0 || s.replies.responseActive) return 'thinking';
  return 'listening';
}

// Loudness in steps of 0.01, so background noise does not produce a message on every tick.
const step = (level) => Math.round(level * 100) / 100;

export class OrbLink {
  sent = {};
  closed = false;

  // Input: child is the process running orb.js (stdin and stdout streams plus exit and error events). session is read for the mood and levels. on is { mute, quit }, called for the icon's mute click and Quit choice. pane is null outside Herdr, else { state() returning 'shown' or 'hidden', toggle() }.
  constructor({ child, session, on, pane, log }) {
    Object.assign(this, { child, session, on, pane, log });
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => this.handle(line));
    child.on('exit', (code, signal) => this.lost(`exit ${code ?? signal}`));
    child.on('error', (err) => this.lost(err.message));
  }

  start() {
    this.tick();
    this.refreshPane();
    this.timers = [setInterval(() => this.tick(), TICK_MS), setInterval(() => this.refreshPane(), PANE_REFRESH_MS)];
    for (const timer of this.timers) timer.unref();
  }

  // Sends whichever of mood, mic level and voice level changed since the last tick, as one line. At the tick rate this is at most 10 lines a second.
  tick() {
    const s = this.session;
    this.sendChanges({ mood: moodOf(s), mic: step(s.micLevel ?? 0), voice: step(s.speaker.level(Date.now())) });
  }

  refreshPane() {
    const state = this.pane?.state();
    if (state) this.sendChanges({ pane: state });
  }

  sendChanges(values) {
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== this.sent[key]));
    if (this.closed || !Object.keys(changed).length) return;
    Object.assign(this.sent, changed);
    this.child.stdin.write(`${JSON.stringify(changed)}\n`);
  }

  // One line from the icon: {"click":"mute"}, {"menu":"toggle-pane"} or {"menu":"quit"}. Anything else is ignored.
  handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.click === 'mute') this.on.mute();
    else if (msg?.menu === 'toggle-pane') {
      this.pane?.toggle();
      this.refreshPane();
    } else if (msg?.menu === 'quit') this.on.quit();
  }

  // The icon's process ended on its own: say so once and carry on without it.
  lost(why) {
    if (this.closed) return;
    this.log(`! tray icon stopped (${why}); carrying on without it`);
    this.close();
  }

  // Ends the icon by closing its stdin, which orb.js treats as the signal to exit.
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers ?? []) clearInterval(timer);
    this.child.stdin.end();
  }
}

// Starts the tray icon unless HERDR_VOICE_ORB=0 or gjs or its typelib is missing, in which case it returns null and the voice runs without one.
export function startOrb({ session, on, pane, log, env = process.env }) {
  if (env.HERDR_VOICE_ORB === '0' || !orbAvailable()) return null;
  const link = new OrbLink({ child: spawn('gjs', [ORB_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] }), session, on, pane, log });
  link.start();
  return link;
}
