#!/usr/bin/env -S gjs
// herdr-voice tray icon: a small herd of flat dots in the top bar whose layout shows what the voice is doing. Run it with gjs; herdr-voice.mjs starts it as a child process and talks to it over stdin and stdout.
// Input on stdin, one JSON object per line: {"mood":"listening|user|assistant|thinking|muted|offline"} sets the icon.
// Input on stdin: {"mic":0..1} is the linear loudness of the user's microphone and {"voice":0..1} is the linear loudness of the assistant's playback; send each at most 30 times a second. They only decide whether the icon animates.
// Input on stdin: {"pane":"shown|hidden"} says whether the voice pane is visible, so the menu reads "Hide voice pane" or "Show voice pane".
// Output on stdout, one JSON object per line: {"click":"mute"} when Mute/Unmute is chosen from the menu or the icon is middle-clicked, {"menu":"toggle-pane"} and {"menu":"quit"} when those menu items are chosen.
// The icon is a still picture while idle and swaps between a few pre-drawn frames, 6 times a second, only while the user talks, the assistant talks or something is working.
// The process exits when stdin closes, and also on SIGINT or SIGTERM. Unknown or malformed input lines are ignored.
// "gjs orb.js --demo" needs no parent: it cycles through every mood with fake levels, and Quit exits.
// The icon is an AppIndicator (the GNOME ubuntu-appindicators extension shows it in the top bar). Frames are SVG files written once to $XDG_RUNTIME_DIR/herdr-voice-orb.

imports.gi.versions.Gtk = '3.0';
imports.gi.versions.AyatanaAppIndicator3 = '0.1';
const { GLib, GLibUnix, Gio, GioUnix, Gtk, AyatanaAppIndicator3: AppIndicator } = imports.gi;

Gtk.init(null);

const TAU = Math.PI * 2;
const FRAME_MS = 160;
const WARM_WHITE = '#eee8dc';

// One accent colour per mood, on warm-white dots. Mood layouts: listening is a tight cluster, user spreads out and turns, assistant ripples outward, thinking is a ring with one lit dot going round, muted is hollow grey rings, offline is dim with one dot missing.
const ACCENT = { listening: '#6fd69b', user: '#5fc1f2', assistant: '#f7c04a', thinking: '#ff8f56', muted: '#8a8f98', offline: '#c4574f' };
const FRAMES = { listening: 1, user: 6, assistant: 6, thinking: 8, muted: 1, offline: 1 };

// A loose cluster of 8 dots: [angle in radians, reach from 0 to 1].
const HERD = [[0.4, 0.55], [1.9, 0.9], [3.1, 0.45], [4.2, 0.8], [5.3, 0.6], [0.9, 0.25], [2.6, 0.7], [5.9, 0.95]];

const emit = (obj) => print(JSON.stringify(obj));

// Returns the dots of one frame of a mood in a 22 by 22 box: x, y, radius, colour, and whether the dot is a hollow ring.
function layout(mood, step) {
  return HERD.flatMap(([angle, reach], i) => {
    const color = i % 3 === 0 ? ACCENT[mood] : WARM_WHITE;
    const at = (dist, a, r, extra = {}) => ({ x: 11 + dist * Math.cos(a), y: 11 + dist * Math.sin(a), r, color, ...extra });
    switch (mood) {
      case 'user': return at(9 * reach, angle + step * TAU / FRAMES.user, 1.7);
      case 'assistant': {
        const p = (step / FRAMES.assistant + reach) % 1;
        return at(1.5 + 8.5 * p, angle, 2 - 0.9 * p);
      }
      case 'thinking': return at(7.8, i * TAU / HERD.length, 1.6, { color: i === step % HERD.length ? ACCENT.thinking : WARM_WHITE });
      case 'muted': return at(6 * reach, angle, 1.7, { color: ACCENT.muted, hollow: true });
      case 'offline': return i === 3 ? [] : at(6 * reach, angle, 1.7, { color: ACCENT.offline, dim: true });
      default: return at(4.5 * reach, angle, 1.7);
    }
  });
}

// Writes the SVG of one frame (once) and returns the icon name that refers to it. Dots get a thin dark outline so they read on a light bar too.
function frameIcon(dir, mood, step) {
  const name = `herdr-voice-${mood}-${step}`;
  const path = `${dir}/${name}.svg`;
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
    const dots = layout(mood, step).map((d) => {
      const fill = d.hollow ? `fill="none" stroke="${d.color}" stroke-width="1.1"` : `fill="${d.color}" stroke="#000" stroke-opacity=".5" stroke-width=".5"`;
      return `<circle cx="${d.x.toFixed(2)}" cy="${d.y.toFixed(2)}" r="${d.r.toFixed(2)}" ${fill}${d.dim ? ' opacity=".55"' : ''}/>`;
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
    this.step = 0;
    this.timer = 0;
    this.icon = '';
    this.dir = `${GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_tmp_dir()}/herdr-voice-orb`;
    GLib.mkdir_with_parents(this.dir, 0o700);
    this.indicator = AppIndicator.Indicator.new_with_path('herdr-voice', frameIcon(this.dir, this.mood, 0), AppIndicator.IndicatorCategory.APPLICATION_STATUS, this.dir);
    this.indicator.set_title('herdr-voice');
    this.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE);
    this.buildMenu();
    this.render();
  }

  buildMenu() {
    const menu = new Gtk.Menu();
    const add = (action) => {
      const item = new Gtk.MenuItem({ label: '' });
      item.connect('activate', action);
      menu.append(item);
      return item;
    };
    this.muteItem = add(() => emit({ click: 'mute' }));
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

  // True while the icon should animate: the user is talking, the assistant is talking, or something is working.
  get busy() {
    return this.mood === 'thinking' || (this.mood === 'user' && this.mic > 0.01) || (this.mood === 'assistant' && this.voice > 0.001);
  }

  // Shows the current frame and menu labels, and starts or stops the frame timer to match.
  render() {
    const icon = frameIcon(this.dir, this.mood, this.step % FRAMES[this.mood]);
    if (icon !== this.icon) {
      this.icon = icon;
      this.indicator.set_icon_full(icon, this.mood);
    }
    this.muteItem.set_label(this.mood === 'muted' ? 'Unmute' : 'Mute');
    this.paneItem.set_label(this.pane === 'shown' ? 'Hide voice pane' : 'Show voice pane');
    if (this.busy && !this.timer) {
      this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
        this.step++;
        this.render();
        return this.timer ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
      });
    } else if (!this.busy && this.timer) {
      GLib.source_remove(this.timer);
      this.timer = 0;
      this.step = 0;
      this.render();
    }
  }

  // Applies one protocol message; fields of the wrong type or value are ignored.
  apply(msg) {
    const before = [this.mood, this.pane, this.busy];
    if (typeof msg.mood === 'string' && ACCENT[msg.mood] && msg.mood !== this.mood) {
      this.mood = msg.mood;
      this.step = 0;
    }
    if (typeof msg.mic === 'number') this.mic = msg.mic;
    if (typeof msg.voice === 'number') this.voice = msg.voice;
    if (msg.pane === 'shown' || msg.pane === 'hidden') this.pane = msg.pane;
    if ([this.mood, this.pane, this.busy].some((v, i) => v !== before[i])) this.render();
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
