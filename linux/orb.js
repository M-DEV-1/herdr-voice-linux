#!/usr/bin/env -S gjs
// herdr-voice tray icon: a small herd of flat dots in the top bar whose layout shows what the voice is doing. Run it with gjs; herdr-voice.mjs starts it as a child process and talks to it over stdin and stdout.
// Input on stdin, one JSON object per line: {"mood":"listening|user|assistant|thinking|muted|offline"} sets the icon.
// Input on stdin: {"mic":0..1} is the linear loudness of the user's microphone and {"voice":0..1} is the linear loudness of the assistant's playback; send each at most 30 times a second. They only decide whether the icon animates.
// Input on stdin: {"pane":"shown|hidden"} says whether the voice pane is visible, so the menu reads "Hide voice pane" or "Show voice pane".
// Output on stdout, one JSON object per line: {"click":"mute"} when Mute/Unmute is chosen from the menu or the icon is middle-clicked, {"menu":"toggle-pane"} and {"menu":"quit"} when those menu items are chosen.
// Idle, the icon breathes twice a second and now and then hops or blinks; while the user talks, the assistant talks or something is working it plays 8 frames a second; muted and offline are still pictures.
// The process exits when stdin closes, and also on SIGINT or SIGTERM. Unknown or malformed input lines are ignored.
// "gjs orb.js --demo" needs no parent: it cycles through every mood with fake levels, and Quit exits.
// The icon is an AppIndicator (the GNOME ubuntu-appindicators extension shows it in the top bar). Frames are SVG files written once to $XDG_RUNTIME_DIR/herdr-voice-orb.

imports.gi.versions.Gtk = '3.0';
imports.gi.versions.AyatanaAppIndicator3 = '0.1';
const { GLib, GLibUnix, Gio, GioUnix, Gtk, AyatanaAppIndicator3: AppIndicator } = imports.gi;

Gtk.init(null);

const TAU = Math.PI * 2;
const WARM_WHITE = '#eee8dc';
const ACTIVE_FPS = 8;
const IDLE_FPS = 2;
const QUIET = 0.004;

// One accent colour per mood, on warm-white dots. The mood decides which animation plays: listening breathes (and now and then hops or blinks), the user talking makes the herd huddle and jiggle with the mic, the assistant talking makes it bounce outward with the voice, thinking is a ring where the dots chase each other, muted is hollow grey dots lying flat, offline is dim with one dot missing.
const ACCENT = { listening: '#6fd69b', user: '#5fc1f2', assistant: '#f7c04a', thinking: '#ff8f56', muted: '#8a8f98', offline: '#c4574f' };

// Frames per animation. Loops: breathe, huddle, bounce, chase. One-shots: hop, blink, squish, scatter, flop (flop also gives the resting muted pose in its last frame).
const FRAMES = { still: 1, breathe: 8, huddle: 8, bounce: 8, chase: 12, hop: 8, blink: 4, squish: 4, scatter: 8, flop: 5 };

// A loose cluster of 8 dots: [angle in radians, reach from 0 to 1].
const HERD = [[0.4, 0.55], [1.9, 0.9], [3.1, 0.45], [4.2, 0.8], [5.3, 0.6], [0.9, 0.25], [2.6, 0.7], [5.9, 0.95]];

const emit = (obj) => print(JSON.stringify(obj));
const lerp = (a, b, k) => a + (b - a) * k;

// Quantises a raw 0..1 loudness to 0 (quiet) or 1 to 3 (soft to loud).
const levelOf = (raw) => (raw > QUIET ? 1 + Math.min(2, Math.floor(Math.sqrt(Math.min(1, raw * 6)) * 3)) : 0);

// Returns the dots of one frame in a 22 by 22 box: x, y, radius, colour, and whether the dot is a hollow ring or dimmed.
function layout(mood, kind, step, level) {
  const f = step / FRAMES[kind];
  return HERD.flatMap(([angle, reach], i) => {
    let dist = 4.5 * reach;
    let a = angle;
    let r = 1.7;
    let sy = 1;
    let lift = 0;
    let color = i % 3 === 0 ? ACCENT[mood] : WARM_WHITE;
    const extra = {};
    switch (kind) {
      case 'breathe':
        dist *= 1 + 0.16 * Math.sin(f * TAU);
        r *= 1 + 0.08 * Math.sin(f * TAU + i);
        break;
      case 'hop': {
        const phase = f * 1.6 - i * 0.1;
        lift = phase > 0 && phase < 1 ? 3 * Math.sin(Math.PI * phase) : 0;
        break;
      }
      case 'blink':
        r *= 1 - 0.8 * Math.sin(Math.PI * f);
        break;
      case 'huddle':
        dist = 2.4 * reach * (1 + 0.15 * level * Math.sin(f * 2 * TAU + i));
        r += 0.15 * level;
        a += 0.25 * level * Math.sin(f * 2 * TAU + i * 1.7);
        break;
      case 'bounce':
        dist = Math.min(8.8, 3.4 * reach + 2 * level * (0.5 + 0.5 * Math.sin(f * TAU - reach * 2)));
        break;
      case 'chase': {
        a = i * TAU / HERD.length + f * TAU / 2;
        dist = 7.5;
        const behind = ((((f * TAU - a) % TAU) + TAU) % TAU) / TAU;
        r = 2.1 - behind;
        if (behind > 0.15) color = WARM_WHITE;
        else color = ACCENT.thinking;
        break;
      }
      case 'squish':
        sy = 1 - 0.5 * Math.sin(Math.PI * f);
        break;
      case 'scatter':
        dist += 4.5 * Math.sin(Math.PI * f) * (0.5 + reach);
        a += 0.8 * Math.sin(i * 2.3) * Math.sin(Math.PI * f);
        break;
      case 'flop': {
        const g = Math.min(1, step / (FRAMES.flop - 1));
        const x = lerp(11 + dist * Math.cos(a), 11 + (i - 3.5) * 2.4, g * g);
        const y = lerp(11 + dist * Math.sin(a), 17, g * g);
        return { x, y, r, color: g > 0.5 ? ACCENT.muted : color, hollow: g > 0.5 };
      }
      default:
        if (mood === 'offline') {
          if (i === 3) return [];
          return { x: 11 + 6 * reach * Math.cos(a), y: 11 + 6 * reach * Math.sin(a), r, color: ACCENT.offline, dim: true };
        }
    }
    return { x: 11 + dist * Math.cos(a), y: 11 + lift * -1 + dist * Math.sin(a) * sy, r, color, ...extra };
  });
}

// Writes the SVG of one frame (once) and returns the icon name that refers to it. Dots get a thin dark outline so they read on a light bar too.
function frameIcon(dir, mood, kind, step, level) {
  const name = `herdr-voice-${mood}-${kind}-${step}-${level}`;
  const path = `${dir}/${name}.svg`;
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
    const dots = layout(mood, kind, step, level).map((d) => {
      const fill = d.hollow ? `fill="none" stroke="${d.color}" stroke-width="1.1"` : `fill="${d.color}" stroke="#000" stroke-opacity=".5" stroke-width=".5"`;
      return `<circle cx="${d.x.toFixed(2)}" cy="${d.y.toFixed(2)}" r="${Math.max(0.2, d.r).toFixed(2)}" ${fill}${d.dim ? ' opacity=".55"' : ''}/>`;
    });
    GLib.file_set_contents(path, `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">${dots.join('')}</svg>`);
  }
  return name;
}

class Tray {
  constructor(demo) {
    this.demo = demo;
    this.mood = 'listening';
    this.mic = 0;
    this.voice = 0;
    this.pane = 'shown';
    this.once = null;
    this.step = 0;
    this.fps = 0;
    this.timer = 0;
    this.icon = '';
    this.dir = `${GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_tmp_dir()}/herdr-voice-orb`;
    GLib.mkdir_with_parents(this.dir, 0o700);
    for (const name of this.listFiles()) GLib.unlink(`${this.dir}/${name}`);
    this.indicator = AppIndicator.Indicator.new_with_path('herdr-voice', frameIcon(this.dir, this.mood, 'breathe', 0, 0), AppIndicator.IndicatorCategory.APPLICATION_STATUS, this.dir);
    this.indicator.set_title('herdr-voice');
    this.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE);
    this.indicator.connect('scroll-event', () => this.play('scatter'));
    this.buildMenu();
    this.render();
    this.fidget();
  }

  listFiles() {
    const dir = GLib.Dir.open(this.dir, 0);
    const names = [];
    for (let name = dir.read_name(); name; name = dir.read_name()) names.push(name);
    return names;
  }

  buildMenu() {
    const menu = new Gtk.Menu();
    const add = (action) => {
      const item = new Gtk.MenuItem({ label: '' });
      item.connect('activate', action);
      menu.append(item);
      return item;
    };
    this.muteItem = add(() => {
      emit({ click: 'mute' });
      this.play(this.mood === 'muted' ? 'hop' : 'squish');
    });
    this.paneItem = add(() => emit({ menu: 'toggle-pane' }));
    menu.append(new Gtk.SeparatorMenuItem());
    add(() => {
      emit({ menu: 'quit' });
      if (this.demo) Gtk.main_quit();
    }).set_label('Quit herdr-voice');
    menu.show_all();
    this.indicator.set_menu(menu);
    this.indicator.set_secondary_activate_target(this.muteItem);
  }

  // The animation that plays when no one-shot is running: its name and loop speed (0 means a still picture).
  base() {
    const level = this.level();
    if (this.mood === 'thinking') return { kind: 'chase', fps: ACTIVE_FPS };
    if (this.mood === 'user' && level) return { kind: 'huddle', fps: ACTIVE_FPS };
    if (this.mood === 'assistant' && level) return { kind: 'bounce', fps: ACTIVE_FPS };
    if (this.mood === 'muted') return { kind: 'flop', fps: 0, still: FRAMES.flop - 1 };
    if (this.mood === 'offline') return { kind: 'still', fps: 0, still: 0 };
    return { kind: 'breathe', fps: IDLE_FPS };
  }

  level() {
    return this.mood === 'user' ? levelOf(this.mic) : this.mood === 'assistant' ? levelOf(this.voice) : 0;
  }

  // Starts a one-shot animation (hop, blink, squish, scatter or flop) from its first frame.
  play(kind) {
    this.once = kind;
    this.step = 0;
    this.render();
    this.schedule();
  }

  // Shows the current frame and the menu labels.
  render() {
    const base = this.base();
    const kind = this.once || base.kind;
    const step = this.once ? this.step : base.fps ? this.step % FRAMES[kind] : base.still;
    const icon = frameIcon(this.dir, this.mood, kind, step, ['huddle', 'bounce'].includes(kind) ? this.level() : 0);
    if (icon !== this.icon) {
      this.icon = icon;
      this.indicator.set_icon_full(icon, this.mood);
    }
    const mute = this.mood === 'muted' ? 'Unmute' : 'Mute';
    if (this.muteItem.get_label() !== mute) this.muteItem.set_label(mute);
    const pane = this.pane === 'shown' ? 'Hide voice pane' : 'Show voice pane';
    if (this.paneItem.get_label() !== pane) this.paneItem.set_label(pane);
  }

  // Runs the frame timer at the speed the current animation needs, and not at all for a still picture. The timer ticks once per frame.
  schedule() {
    const fps = this.once ? ACTIVE_FPS : this.base().fps;
    if (fps === this.fps) return;
    this.fps = fps;
    if (this.timer) GLib.source_remove(this.timer);
    this.timer = fps ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 / fps, () => this.tick()) : 0;
    this.render();
  }

  tick() {
    this.step++;
    if (this.once && this.step >= FRAMES[this.once]) {
      this.once = null;
      this.step = 0;
      this.schedule();
    }
    this.render();
    return this.timer ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
  }

  // Every 6 to 10 seconds, if the herd is just breathing, it hops or blinks.
  fidget() {
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 6 + Math.floor(Math.random() * 5), () => {
      if (!this.once && this.base().kind === 'breathe') this.play(Math.random() < 0.5 ? 'hop' : 'blink');
      this.fidget();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Applies one protocol message; fields of the wrong type or value are ignored. Loudness only changes which animation runs, never redraws by itself.
  apply(msg) {
    let changed = false;
    if (typeof msg.mic === 'number') this.mic = msg.mic;
    if (typeof msg.voice === 'number') this.voice = msg.voice;
    if ((msg.pane === 'shown' || msg.pane === 'hidden') && msg.pane !== this.pane) {
      this.pane = msg.pane;
      changed = true;
    }
    if (typeof msg.mood === 'string' && ACCENT[msg.mood] && msg.mood !== this.mood) {
      this.mood = msg.mood;
      this.once = msg.mood === 'muted' ? 'flop' : null;
      this.step = 0;
      this.fps = -1;
      changed = true;
    }
    this.schedule();
    if (changed) this.render();
  }

  // Reads stdin line by line and quits when it closes.
  readStdin() {
    const input = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) });
    const next = () => input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
      let line;
      try {
        [line] = stream.read_line_finish_utf8(res);
      } catch (e) {
        line = null;
      }
      if (line === null) return Gtk.main_quit();
      try {
        const msg = JSON.parse(line);
        if (msg && typeof msg === 'object') this.apply(msg);
      } catch (e) {
        printerr(`herdr-voice orb: ignored line: ${line}`);
      }
      next();
    });
    next();
  }

  // Cycles through every mood every 4 seconds with fake mic and voice levels.
  runDemo() {
    const names = Object.keys(ACCENT);
    const started = GLib.get_monotonic_time() / 1e6;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      const t = GLib.get_monotonic_time() / 1e6 - started;
      const name = names[Math.floor(t / 4) % names.length];
      const talking = Math.sin(t * 3) > -0.3 ? 0.15 : 0;
      this.apply({ mood: name, mic: name === 'user' ? talking : 0, voice: name === 'assistant' ? talking : 0 });
      return GLib.SOURCE_CONTINUE;
    });
  }

  run() {
    if (this.demo) this.runDemo();
    else this.readStdin();
    for (const signal of [2, 15]) GLibUnix.signal_add_full(GLib.PRIORITY_DEFAULT, signal, () => { Gtk.main_quit(); return GLib.SOURCE_REMOVE; });
    Gtk.main();
  }
}

new Tray(ARGV.includes('--demo')).run();
