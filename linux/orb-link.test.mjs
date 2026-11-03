// Run with: node --test linux/*.test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { OrbLink, moodOf } from './orb-link.mjs';

// A session that is connected, idle and not muted. Fields in `over` replace the defaults.
const session = (over = {}) => ({
  closed: false, muted: false, status: 'live', established: true, dormant: false,
  gate: { isOpen: false }, midTurn: false, toolsRunning: 0, micLevel: 0,
  replies: { responseActive: false },
  speaker: { isSpeaking: false, level: () => 0 },
  ...over,
});

test('the mood follows what the session is doing, with offline and muted taking priority', () => {
  const cases = [
    [{}, 'listening'],
    [{ gate: { isOpen: true } }, 'user'],
    [{ midTurn: true }, 'user'],
    [{ speaker: { isSpeaking: true, level: () => 0 } }, 'assistant'],
    [{ toolsRunning: 1 }, 'thinking'],
    [{ replies: { responseActive: true } }, 'thinking'],
    [{ muted: true, gate: { isOpen: true } }, 'muted'],
    [{ status: 'connecting', established: false }, 'offline'],
    [{ status: 'live', established: false }, 'offline'],
    [{ status: 'disconnected', established: false, dormant: true }, 'listening'],
    [{ closed: true, muted: true }, 'offline'],
    [{ gate: { isOpen: true }, speaker: { isSpeaking: true, level: () => 0 }, toolsRunning: 1 }, 'user'],
    [{ speaker: { isSpeaking: true, level: () => 0 }, toolsRunning: 1 }, 'assistant'],
  ];
  for (const [over, mood] of cases) assert.equal(moodOf(session(over)), mood, JSON.stringify(over));
});

// An OrbLink on fake pipes. `sent()` is every JSON line written to the icon so far; `say(obj)` is a line the icon writes back.
function link(over = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const lines = [], calls = [], logs = [];
  child.stdin.on('data', (data) => lines.push(...String(data).split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  let paneState = 'shown';
  const s = session();
  const pane = { state: () => paneState, toggle: () => { calls.push('toggle'); paneState = paneState === 'shown' ? 'hidden' : 'shown'; } };
  const orb = new OrbLink({ child, session: s, pane, log: (line) => logs.push(line), on: { mute: () => calls.push('mute'), quit: () => calls.push('quit') }, ...over });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { child, orb, s, lines, calls, logs, settle, say: (obj) => child.stdout.write(`${JSON.stringify(obj)}\n`) };
}

test('a tick sends only what changed, and levels in steps of 0.01', async () => {
  const { orb, s, lines, settle } = link();
  orb.tick();
  s.micLevel = 0.004;
  s.speaker.level = () => 0.123;
  orb.tick();
  s.micLevel = 0.0049;
  orb.tick();
  s.midTurn = true;
  orb.tick();
  await settle();
  assert.deepEqual(lines, [{ mood: 'listening', mic: 0, voice: 0 }, { voice: 0.12 }, { mood: 'user' }]);
});

test('the pane state is sent when it changes, and a pane toggle from the icon sends the new state', async () => {
  const { orb, lines, calls, say, settle } = link();
  orb.refreshPane();
  orb.refreshPane();
  say({ menu: 'toggle-pane' });
  await settle();
  assert.deepEqual(calls, ['toggle']);
  assert.deepEqual(lines, [{ pane: 'shown' }, { pane: 'hidden' }]);
});

test('nothing about the pane is sent outside Herdr, and a pane toggle does nothing', async () => {
  const { orb, lines, say, settle } = link({ pane: undefined });
  orb.refreshPane();
  say({ menu: 'toggle-pane' });
  await settle();
  assert.deepEqual(lines, []);
});

test('the icon\'s mute click and quit choice call the matching callbacks, and other lines are ignored', async () => {
  const { child, calls, say, settle } = link();
  say({ click: 'mute' });
  child.stdout.write('not json\n');
  say({ click: 'other' });
  say({ menu: 'unknown' });
  say(null);
  say({ menu: 'quit' });
  await settle();
  assert.deepEqual(calls, ['mute', 'quit']);
});

test('levels are sent at most 15 times a second', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { orb, s, lines } = link();
  orb.start();
  for (let i = 0; i < 100; i++) {
    s.micLevel = (i % 7) / 10;
    t.mock.timers.tick(10);
  }
  orb.close();
  assert.ok(lines.length > 1 && lines.length <= 15, `${lines.length} lines in one second`);
});

test('an icon that dies is logged once and the link stops writing to it', async () => {
  const { child, orb, s, lines, logs, settle } = link();
  child.emit('exit', 1, null);
  child.emit('error', new Error('again'));
  s.muted = true;
  orb.tick();
  await settle();
  assert.deepEqual(logs, ['! tray icon stopped (exit 1); carrying on without it']);
  assert.deepEqual(lines, []);
});

test('closing the link ends the icon\'s stdin and is not reported as a death', async () => {
  const { child, orb, logs } = link();
  let ended = false;
  child.stdin.on('end', () => { ended = true; });
  child.stdin.resume();
  orb.close();
  child.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ended);
  assert.deepEqual(logs, []);
});
