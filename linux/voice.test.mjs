// Run with: node --test linux/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EchoGuard, GeminiWire, Mic, PlaybackLevels, ResponseScheduler, Session, SpeechGate, SpeechPolicy, echoCancelNodes, hidesOnStart, outputKind, outputSink, systemPrompt, keyAction, parseConfig, rms, setupMessage } from './herdr-voice.mjs';
import { ConfirmGate, createTools } from './tools.mjs';

const SAMPLES_PER_CHUNK = 320; // 20 ms at 16 kHz

// Deterministic uniform noise in [-1, 1].
function lcg(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

const chunk = (sample) => {
  const buf = Buffer.alloc(SAMPLES_PER_CHUNK * 2);
  for (let i = 0; i < SAMPLES_PER_CHUNK; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample(i))) * 32767), i * 2);
  return buf;
};

// Steady noise whose rms is `level` (uniform noise in [-a, a] has rms a / sqrt 3).
const noiseChunk = (level, rand) => chunk(() => rand() * level * Math.sqrt(3));

// Speech-like voiced sound: 150 and 300 Hz tones at rms `level`.
const voicedChunk = (level, index) => chunk((i) => {
  const t = (index * SAMPLES_PER_CHUNK + i) / 16000;
  return level * (Math.sin(2 * Math.PI * 150 * t) + 0.5 * Math.sin(2 * Math.PI * 300 * t)) / Math.sqrt(0.625);
});

// Feeds 5 s of noise, 2 s of speech (9 voiced chunks, 3 gap chunks of noise), then 5 s of noise. Returns what the gate sent and when it opened and closed.
function run(noiseLevel, speechLevel) {
  const rand = lcg(7), gate = new SpeechGate(), sent = [];
  let openedAt = null, closedAt = null, index = 0;
  const feed = (buf) => {
    const wasOpen = gate.isOpen;
    for (const c of gate.process(buf, rms(buf), false)) sent.push(c);
    if (gate.isOpen && !wasOpen && openedAt === null) openedAt = index;
    if (!gate.isOpen && wasOpen && closedAt === null) closedAt = index;
    index++;
  };
  for (let i = 0; i < 250; i++) feed(noiseChunk(noiseLevel, rand));
  const start = index;
  for (let i = 0; i < 100; i++) feed(i % 12 >= 9 ? noiseChunk(noiseLevel, rand) : voicedChunk(speechLevel, i));
  const end = index;
  for (let i = 0; i < 250; i++) feed(noiseChunk(noiseLevel, rand));
  return { sent, openedAt, closedAt, start, end, total: index };
}

for (const noise of [0.0001, 0.001, 0.005, 0.02]) {
  test(`gate opens on speech 20 dB over ${noise} noise and shuts afterwards`, () => {
    const r = run(noise, Math.max(0.02, noise * 10));
    assert.notEqual(r.openedAt, null, 'never opened');
    assert.notEqual(r.closedAt, null, 'never closed');
    assert.ok(r.openedAt - r.start <= 5, `opened ${r.openedAt - r.start} chunks late`);
    assert.ok(r.closedAt <= r.end + SpeechGate.HANGOVER + 20, 'did not close after speech');
    assert.ok(r.sent.length >= r.end - r.start, 'part of the speech was dropped');
    assert.ok(r.sent.length / r.total < 0.4, 'streamed too much');
  });

  test(`gate stays shut on ${noise} noise alone`, () => {
    const rand = lcg(3), gate = new SpeechGate();
    let sent = 0;
    for (let i = 0; i < 1000; i++) {
      const buf = noiseChunk(noise, rand);
      sent += gate.process(buf, rms(buf), false).length;
    }
    assert.equal(sent, 0);
  });
}

test('Gemini holds the gate open through a pause until the cap', () => {
  const gate = new SpeechGate(), quiet = 0.0003, loud = 0.05;
  const feed = (n, level, hold) => { for (let i = 0; i < n; i++) gate.process(null, level, hold); };
  feed(50, quiet, false);
  feed(20, loud, false);
  feed(100, quiet, true);
  assert.equal(gate.isOpen, true);
  feed(SpeechGate.MAX_HOLD, quiet, true);
  assert.equal(gate.isOpen, false);
});

const wire = () => new GeminiWire();
const audio = (data = 'QUJD') => ({ serverContent: { modelTurn: { parts: [{ inlineData: { data, mimeType: 'audio/pcm;rate=24000' } }] } } });

test('you speak, then it answers: transcript pieces are joined and audio starts the reply', () => {
  const w = wire();
  assert.deepEqual(w.decode({ setupComplete: {} }), [{ t: 'ignored', what: 'setupComplete' }]);
  assert.deepEqual(w.decode({ serverContent: { inputTranscription: { text: 'tell claude' } } }), [{ t: 'speechStarted' }, { t: 'userPiece', text: 'tell claude' }]);
  assert.deepEqual(w.decode({ serverContent: { inputTranscription: { text: ' to run the tests' } } }), [{ t: 'userPiece', text: ' to run the tests' }]);
  assert.deepEqual(w.decode(audio()), [
    { t: 'speechStopped' }, { t: 'user', text: 'tell claude to run the tests' }, { t: 'responseCreated' }, { t: 'audio', b64: 'QUJD' },
  ]);
  assert.deepEqual(w.decode({ serverContent: { outputTranscription: { text: 'Sending ' } } }), [{ t: 'assistantDelta', text: 'Sending ' }]);
  assert.deepEqual(w.decode({ serverContent: { outputTranscription: { text: 'it now.' } } }), [{ t: 'assistantDelta', text: 'it now.' }]);
  assert.deepEqual(w.decode({ serverContent: { turnComplete: true } }), [{ t: 'assistant', text: 'Sending it now.' }, { t: 'responseDone' }]);
});

test('parallel tool calls arrive as one turn, after what the voice said first', () => {
  const w = wire();
  w.decode({ serverContent: { outputTranscription: { text: 'Checking.' } } });
  const events = w.decode({ toolCall: { functionCalls: [
    { id: 'c1', name: 'focus', args: { target: 'forge' } },
    { id: 'c2', name: 'list_agents' },
  ] } });
  assert.deepEqual(events, [
    { t: 'assistant', text: 'Checking.' },
    { t: 'call', id: 'c1', name: 'focus', args: { target: 'forge' } },
    { t: 'call', id: 'c2', name: 'list_agents', args: {} },
    { t: 'responseDone' },
  ]);
});

test('Gemini voice activity marks your speech start and end, and transcript pieces after it do not restart it', () => {
  const w = new GeminiWire();
  const kinds = (msg) => w.decode(msg).map((e) => e.t);
  assert.deepEqual(kinds({ voiceActivity: { type: 'ACTIVITY_START' } }), ['speechStarted']);
  assert.deepEqual(kinds({ serverContent: { inputTranscription: { text: 'list my' } }, voiceActivity: { type: 'ACTIVITY_END' } }), ['userPiece', 'speechStopped']);
  assert.deepEqual(kinds({ serverContent: { inputTranscription: { text: ' agents' } } }), ['userPiece']);
  assert.deepEqual(w.decode({ toolCall: { functionCalls: [{ id: '1', name: 'list_agents' }] } }).find((e) => e.t === 'user').text, 'list my agents');
});

test('talking over the model is a barge-in and ends its turn', () => {
  const w = wire();
  w.decode(audio());
  assert.deepEqual(w.decode({ serverContent: { interrupted: true } }), [{ t: 'speechStarted' }, { t: 'responseDone' }]);
});

test('a turn that produced nothing still releases the scheduler', () => {
  assert.deepEqual(wire().decode({ serverContent: { turnComplete: true } }), [{ t: 'responseDone' }]);
});

test('goAway and resumption handles are surfaced, unresumable handles are not', () => {
  const w = wire();
  assert.deepEqual(w.decode({ goAway: { timeLeft: '10s' } }), [{ t: 'ending', timeLeftMs: 10000 }]);
  assert.deepEqual(w.decode({ sessionResumptionUpdate: { resumable: true, newHandle: 'h-1' } }), [{ t: 'handle', handle: 'h-1' }]);
  assert.equal(w.decode({ sessionResumptionUpdate: { resumable: false, newHandle: '' } })[0].t, 'ignored');
});

test('setup carries the model, voice, tools and session features', () => {
  const declarations = [{ name: 'list_agents', description: 'List agents', parameters: { type: 'object', properties: {} } }];
  const base = { voice: 'Kore', instructions: 'Be brief.', declarations };
  const s = setupMessage({ ...base, model: 'gemini-3.1-flash-live-preview', resumeHandle: 'h-42' }).setup;
  assert.equal(s.model, 'models/gemini-3.1-flash-live-preview');
  assert.deepEqual(s.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(s.systemInstruction.parts[0].text, 'Be brief.');
  assert.deepEqual(s.tools, [{ functionDeclarations: [{ name: 'list_agents', description: 'List agents', parametersJsonSchema: declarations[0].parameters }] }]);
  assert.equal(s.sessionResumption.handle, 'h-42');
  assert.deepEqual(s.contextWindowCompression, { slidingWindow: {} });
  assert.doesNotMatch(systemPrompt(false), /confirmed|CONFIRMATION REQUIRED/);
  assert.match(systemPrompt(true), /confirmed=true/);
  assert.deepEqual(s.realtimeInputConfig.automaticActivityDetection, { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', prefixPaddingMs: 300, silenceDurationMs: 800 });
  // Only the 2.x models take Google Search beside function tools.
  assert.equal(setupMessage({ ...base, model: 'gemini-2.5-flash-native-audio-preview-12-2025' }).setup.tools.length, 2);
});

test('replies are requested one at a time, after the response and its tool calls finish', () => {
  const r = new ResponseScheduler();
  r.responseCreated();
  r.callStarted();
  r.callStarted();
  assert.equal(r.callFinished(), false);
  assert.equal(r.callFinished(), false); // the response is still active
  assert.equal(r.responseDone(), true);
  assert.equal(r.wantReply(), false); // a request is already out
});

test('config.env keeps HERDR_VOICE_* settings and refuses everything else by name', () => {
  const { settings, rejected } = parseConfig('# note\nexport HERDR_VOICE_VOICE="Puck"\nHERDR_VOICE_STREAM=always\nGEMINI_API_KEY=AIzaSECRET\nAIzaPASTEDKEY\n');
  assert.deepEqual(settings, [['HERDR_VOICE_VOICE', 'Puck'], ['HERDR_VOICE_STREAM', 'always']]);
  assert.deepEqual(rejected, ['GEMINI_API_KEY', 'a line without =']);
});

test('pane keys: m mutes, a lone Esc stops the voice, q and Ctrl-C quit, arrow keys do nothing', () => {
  assert.deepEqual(['m', 'M', '\x1b', 'q', '\x03', '\x1b[A', 'x'].map(keyAction), ['mute', 'mute', 'stop', 'quit', 'quit', null, null]);
});

test('a muted microphone neither wakes the session nor keeps audio, and unmuting restores both', () => {
  const rand = lcg(5);
  const session = new Session({ key: 'k', model: 'm', voice: 'v', createTools: () => ({}), speaker: { isSpeaking: false, interrupt() {}, level: () => 0 } });
  let connects = 0;
  session.connect = () => { connects++; };
  const speak = () => {
    for (let i = 0; i < 40; i++) session.micChunk(noiseChunk(0.001, rand));
    for (let i = 0; i < 20; i++) session.micChunk(voicedChunk(0.1, i));
  };
  session.toggleMute();
  speak();
  assert.deepEqual([connects, session.held.chunks.length], [0, 0]);
  session.toggleMute();
  speak();
  assert.ok(connects > 0 && session.held.chunks.length > 0);
});

test('the voice pane starts visible unless HERDR_VOICE_START_HIDDEN=1', () => {
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p', HERDR_PLUGIN_ENTRYPOINT_ID: 'voice' };
  assert.deepEqual([env, { ...env, HERDR_VOICE_START_HIDDEN: '1' }].map(hidesOnStart), [false, true]);
});

// A session already connected to a recording socket, with the given tools and speaker. Server messages are fed in with feed().
function liveSession({ tools = {}, speaker = { isSpeaking: false, until: 0, interrupt() {}, level: () => 0 }, createTools: make } = {}) {
  const session = new Session({ key: 'k', model: 'm', voice: 'v', greet: false, speaker, createTools: make ?? (() => ({ declarations: [], run: async () => ({ output: 'x' }), ...tools })) });
  const sent = [];
  session.socket = { readyState: 1, send: (text) => sent.push(JSON.parse(text)), addEventListener(_, done) { this.done = done; }, close() { this.done?.(); } };
  session.status = 'live';
  session.established = true;
  return { session, sent, feed: (msg) => session.onMessage(JSON.stringify(msg)) };
}
const said = (text) => ({ serverContent: { inputTranscription: { text } } });

test('speech heard while the voice plays, or within half a second after, never reaches the confirmation gate', () => {
  const heard = [];
  const speaker = { isSpeaking: true, until: Date.now() + 3000, play() {}, interrupt() {} };
  const { feed } = liveSession({ tools: { heard: (t) => heard.push(t) }, speaker });
  // Gemini sends no speech-started signal while the model's own turn is running.
  feed({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  feed(said('okay close the forge tab'));
  speaker.isSpeaking = false;
  speaker.until = Date.now() - 200;
  feed(said('yes'));
  assert.deepEqual(heard, []);
  feed({ serverContent: { turnComplete: true } });
  speaker.until = Date.now() - 1000;
  feed(said('yes'));
  assert.deepEqual(heard, ['yes']);
});

test('a yes transcribed after the confirmed tool call still confirms it', async () => {
  const gate = new ConfirmGate({ minDelay: 0, wait: 500 });
  const commands = [];
  const runHerdr = async (args) => { commands.push(args.join(' ')); return '{}'; };
  const { session, sent, feed } = liveSession({ createTools: () => createTools({ emit() {}, env: { HERDR_VOICE_CONFIRM: '1' }, runHerdr, gate }) });
  assert.match((await session.tools.run('rename_agent', { target: 'a', name: 'b' })).output, /^CONFIRMATION REQUIRED/);
  feed({ toolCall: { functionCalls: [{ id: 'c1', name: 'rename_agent', args: { target: 'a', name: 'b', confirmed: true } }] } });
  feed(said('yes'));
  await session.toolQueue;
  assert.deepEqual(commands, ['agent rename a b']);
  assert.match(sent.at(-1).toolResponse.functionResponses[0].response.output, /^done: rename agent a to b/);
});

test('a run_shell question may read the command aloud, any other reply may not', () => {
  const { session } = liveSession({ tools: { pendingAction: () => 'run_shell:/tmp:ls ~/code/app' } });
  const speak = () => {
    session.handle({ t: 'responseCreated' });
    session.handle({ t: 'assistantDelta', text: 'Run ls ~/code/app in the api folder?' });
  };
  speak();
  assert.equal(session.leaked, null);
  session.tools.pendingAction = () => 'close_tab:t1';
  speak();
  assert.equal(session.leaked, 'a file path');
  assert.deepEqual(new SpeechPolicy(true).feed('see `x`'), null);
});

test('a report reopening a closed session keeps the quiet timer from closing it again', () => {
  const { session } = liveSession();
  session.status = 'disconnected';
  session.socket = null;
  session.dormant = true;
  session.lastSpeech = Date.now() - 10 * 60_000;
  session.connect = () => { session.status = 'connecting'; };
  session.report('[herdr] Agent claude is now idle.');
  // The session is up again and the reply to the report is finished.
  Object.assign(session, { status: 'live', established: true, outbox: [] });
  session.replies.reset();
  session.checkQuiet();
  assert.equal(session.status, 'live');
});

test('the calls of one tool turn run one at a time, in order, and are answered together', async () => {
  const order = [];
  let release;
  const run = async (name) => {
    order.push(`start ${name}`);
    if (name === 'first') await new Promise((resolve) => { release = resolve; });
    order.push(`end ${name}`);
    return { output: name };
  };
  const { session, sent, feed } = liveSession({ tools: { run } });
  feed({ toolCall: { functionCalls: [{ id: 'c1', name: 'first', args: {} }, { id: 'c2', name: 'second', args: {} }] } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['start first']);
  release();
  await session.toolQueue;
  assert.deepEqual(order, ['start first', 'end first', 'start second', 'end second']);
  const responses = sent.filter((m) => m.toolResponse);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].toolResponse.functionResponses.map((r) => r.name), ['first', 'second']);
});

test('shutdown waits for the tools to stop', async () => {
  let stopped = false;
  const { session } = liveSession({ tools: { stop: () => new Promise((resolve) => setTimeout(() => { stopped = true; resolve(); }, 30)) } });
  await session.shutdown();
  assert.equal(stopped, true);
});

test('echo-cancel nodes are found by their node.group, not by name, and monitors are skipped', () => {
  const entry = (kind, id, name, group) => `${kind} #${id}\n\tState: SUSPENDED\n\tName: ${name}\n\tProperties:\n\t\tnode.name = "${name}"\n${group ? `\t\tnode.group = "${group}"\n` : ''}\tFormats:\n\t\tpcm\n`;
  const listing = [entry('Source', 1, 'alsa_input.pci', ''), entry('Source', 2, 'echo-cancel-source', 'echo-cancel-77-12'), entry('Source', 3, 'echo-cancel-sink.monitor', 'echo-cancel-77-12')].join('\n');
  assert.deepEqual(echoCancelNodes(listing), ['echo-cancel-source']);
  assert.deepEqual(echoCancelNodes(entry('Sink', 4, 'alsa_output.pci', '')), []);
});

// A `pactl list sinks` entry shaped like PipeWire's: a sink with its properties, its ports as "name: description (type: T, ...)", and the active one.
function pactlSink(id, name, props, ports = [], active = ports[0]?.[0]) {
  const lines = [`Sink #${id}`, '\tState: SUSPENDED', `\tName: ${name}`, `\tDescription: ${name}`, '\tProperties:', `\t\tnode.name = "${name}"`, ...Object.entries(props).map(([k, v]) => `\t\t${k} = "${v}"`)];
  if (ports.length) lines.push('\tPorts:', ...ports.map(([port, type]) => `\t\t${port}: ${type} (type: ${type}, priority: 100, availability unknown)`), `\tActive Port: ${active}`);
  return `${lines.join('\n')}\n\tFormats:\n\t\tpcm\n`;
}
const SOF = { 'alsa.card_name': 'sof-hda-dsp', 'device.bus': 'pci', 'node.nick': 'Speaker + Headphones', 'media.class': 'Audio/Sink' };
const SOF_PORTS = [['[Out] Speaker', 'Speaker'], ['[Out] Headphones', 'Headphones']];

test('the output counts as earphones for a headphone or headset port or a Bluetooth headset, and as speakers otherwise', () => {
  const cases = [
    ['wired headphones', pactlSink(63, 'alsa_output.pci.HiFi__hw_sofhdadsp__sink', SOF, SOF_PORTS, '[Out] Headphones'), 'earphones'],
    ['the built-in speaker', pactlSink(63, 'alsa_output.pci.HiFi__hw_sofhdadsp__sink', SOF, SOF_PORTS, '[Out] Speaker'), 'speakers'],
    ['a USB headset', pactlSink(70, 'alsa_output.usb-headset.analog-stereo', { 'device.bus': 'usb', 'device.form_factor': 'headset' }, [['analog-output', 'Analog']]), 'earphones'],
    ['a Bluetooth headset', pactlSink(80, 'bluez_output.AA_BB_CC_DD_EE_FF.1', { 'device.bus': 'bluetooth', 'api.bluez5.profile': 'a2dp-sink', 'device.form_factor': 'headset' }, [['headset-output', 'Headset']]), 'earphones'],
    ['a Bluetooth sink with no port or form factor', pactlSink(81, 'bluez_output.AA_BB_CC_DD_EE_FF.1', { 'device.bus': 'bluetooth' }), 'earphones'],
    ['a Bluetooth speaker', pactlSink(82, 'bluez_output.11_22_33_44_55_66.1', { 'device.bus': 'bluetooth', 'device.form_factor': 'speaker' }, [['speaker-output', 'Speaker']]), 'speakers'],
    ['an HDMI monitor', pactlSink(99, 'alsa_output.pci-0000_01_00.1.hdmi-stereo', { 'device.bus': 'pci' }, [['hdmi-output-0', 'HDMI']]), 'speakers'],
    ['an unknown virtual sink', pactlSink(5, 'some_virtual_sink', { 'node.virtual': 'true' }), 'speakers'],
    ['no sink at all', undefined, 'speakers'],
  ];
  for (const [what, sink, kind] of cases) assert.equal(outputKind(sink), kind, what);
});

test('the output behind an echo-cancel sink is the sink its playback stream goes to', () => {
  const group = 'echo-cancel-3296-29';
  const hardware = (active) => pactlSink(63, 'alsa_output.pci.HiFi__hw_sofhdadsp__sink', SOF, SOF_PORTS, active);
  const ec = pactlSink(39, 'june_ec_sink', { 'node.group': group, 'node.virtual': 'true' });
  const stream = (sink) => `Sink Input #40\n\tDriver: PipeWire\n\tSink: ${sink}\n\tProperties:\n\t\tnode.name = "echo-cancel-playback"\n\t\tnode.group = "${group}"\n`;
  const other = 'Sink Input #41\n\tSink: 99\n\tProperties:\n\t\tnode.name = "firefox"\n';
  for (const [active, kind] of [['[Out] Headphones', 'earphones'], ['[Out] Speaker', 'speakers']]) {
    const sinks = [ec, hardware(active), pactlSink(99, 'hdmi', {}, [['hdmi-output-0', 'HDMI']])].join('\n');
    assert.equal(outputKind(outputSink(sinks, [other, stream(63)].join('\n'), 'june_ec_sink')), kind);
    assert.equal(outputKind(outputSink(sinks, '', 'alsa_output.pci.HiFi__hw_sofhdadsp__sink')), kind, 'a hardware sink is its own output');
  }
  // The playback stream is not linked anywhere: unknown, so the guard stays on.
  assert.equal(outputSink([ec, hardware('[Out] Headphones')].join('\n'), stream(4294967295), 'june_ec_sink'), undefined);
});

// Feeds a session with a fake speaker: 2 s of room noise at 0.001, then 3 s of playback at `play` while the mic hears `echo` and, every fourth chunk, the quieter audio the canceller leaves. Returns the session.
function echoRun(play, echo, earphones = false) {
  const rand = lcg(11);
  let playing = 0;
  const session = new Session({ key: 'k', model: 'm', voice: 'v', createTools: () => ({}), speaker: { isSpeaking: false, interrupt() {}, level: () => playing } });
  session.connect = () => {};
  session.echo.off = earphones;
  for (let i = 0; i < 100; i++) session.micChunk(noiseChunk(0.001, rand));
  playing = play;
  for (let i = 0; i < 150; i++) session.micChunk(i % 4 ? noiseChunk(echo, rand) : noiseChunk(0.0001, rand));
  return session;
}

for (const ratio of [0.05, 0.1, 0.2]) {
  test(`echo at ${ratio} of the playback level neither opens the gate nor lowers the noise floor`, () => {
    const session = echoRun(0.1, 0.1 * ratio);
    assert.equal(session.held.chunks.length, 0, 'echo was kept as speech');
    assert.ok(session.gate.noiseFloor > 0.0005, `floor fell to ${session.gate.noiseFloor}`);
  });
}

test('speech louder than the guard ratio still opens the gate while the voice plays', () => {
  const session = echoRun(0.1, 0.1 * EchoGuard.RATIO * 1.5);
  assert.ok(session.held.chunks.length > 0);
});

test('with earphones, speech far below the guard ratio still opens the gate while the voice plays', () => {
  // Measured: your voice reaches june_ec_source at about -41 dBFS while the voice plays at about -17 dBFS, a sixteenth of its level.
  const quiet = 0.1 * EchoGuard.RATIO / 4;
  assert.equal(echoRun(0.1, quiet).held.chunks.length, 0, 'with speakers it counts as echo');
  assert.ok(echoRun(0.1, quiet, true).held.chunks.length > 0, 'with earphones it is speech');
});

test('the echo reference fades after playback stops instead of dropping at once', () => {
  const guard = new EchoGuard();
  guard.isEcho(0, 0.1);
  assert.equal(guard.isEcho(0.02, 0), true); // 20 ms later: reverb at a fifth of the playback is still echo
  for (let i = 0; i < 40; i++) guard.isEcho(0, 0);
  assert.equal(guard.isEcho(0.0001, 0), false);
});

test('playback levels follow when audio plays, not when it was written', () => {
  const levels = new PlaybackLevels();
  // One second written at once: the first half loud, the second half silent, playing from t = 1000 ms.
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < 12000; i++) pcm.writeInt16LE(i % 2 ? 3277 : -3277, i * 2);
  levels.add(pcm, 1000);
  assert.equal(levels.at(990), 0);
  assert.ok(Math.abs(levels.at(1200) - 0.1) < 0.001);
  assert.ok(levels.at(1700) > 0.09); // the loud half ended 200 ms ago, inside the window
  assert.equal(levels.at(1900), 0);
});

test('the microphone drops the first second of each pw-record run and restarts pw-record when it exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-voice-mic-'));
  // A pw-record stand-in: 1 s of bytes 1, then 0.5 s of bytes 2, then it exits as on a PipeWire restart.
  writeFileSync(join(dir, 'pw-record'), "#!/bin/sh\nhead -c 32000 /dev/zero | tr '\\0' '\\1'\nhead -c 16000 /dev/zero | tr '\\0' '\\2'\n");
  chmodSync(join(dir, 'pw-record'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  const mic = new Mic(null), chunks = [];
  let died = null;
  try {
    await new Promise((done) => {
      mic.start((c) => { chunks.push(c); if (chunks.length === 50) done(); }, (why) => { died = why; done(); });
      setTimeout(done, 5000);
    });
  } finally {
    mic.stop();
    process.env.PATH = path;
  }
  assert.equal(died, null);
  assert.equal(chunks.length, 50);
  assert.ok(chunks.every((c) => c.every((b) => b === 2)));
});

const reply = (text) => ({ serverContent: { outputTranscription: { text } } });
const turnDone = { serverContent: { turnComplete: true } };
const texts = (sent) => sent.filter((m) => m.clientContent).map((m) => [m.clientContent.turns[0].parts[0].text, m.clientContent.turnComplete]);

test('reports and the picture of Herdr wait while you talk, while a reply is awaited, made or spoken, then go out in that order', async () => {
  const speaker = { isSpeaking: false, until: 0, interrupt() {}, level: () => 0 };
  const { session, sent, feed } = liveSession({ speaker });
  session.midTurn = true;
  session.report('[herdr] Agent fixer finished.');
  session.herdrState = '[state] one';
  session.flushIdle();
  assert.deepEqual(texts(sent), [], 'while you talk');
  session.handle({ t: 'speechStopped' });
  assert.deepEqual(texts(sent), [], 'while the reply is awaited');
  feed(reply('Opened the build pane.'));
  session.herdrState = '[state] two';
  session.flushIdle();
  assert.deepEqual(texts(sent), [], 'while the reply is made');
  Object.assign(speaker, { isSpeaking: true, until: Date.now() + 200 });
  feed(turnDone);
  assert.deepEqual(texts(sent), [], 'while the voice speaks');
  // The echo of the voice lasts half a second after it stops.
  Object.assign(speaker, { isSpeaking: false, until: Date.now() - 600 });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(texts(sent), [['[state] two', false], ['[herdr] Agent fixer finished.', true]]);
  session.shutdown();
});

test('a reply ending on an offer, or reading an ID, is flagged; answers, mid-reply offers and pending confirmations are not', () => {
  const answers = ['The build passed.', 'One ticket is fixed and two are open.', 'Closed the docs pane.', "Didn't catch that."];
  const offers = ["Let me know if you'd like to proceed.", 'Want me to run it again?', 'Anything else?', 'Would you like me to open it?', 'Feel free to ask.', 'Do you want to see the logs?', "If you'd like, I can rerun it.", 'Shall I close it?'];
  const said = (text, asking = false) => { const p = new SpeechPolicy(false, asking); p.feed(text); return p.endsWithOffer; };
  for (const a of answers) {
    assert.equal(said(a), false, a);
    for (const o of offers) {
      assert.equal(said(`${a} ${o}`), true, `${a} ${o}`);
      assert.equal(said(`${o} ${a}`), false, `${o} ${a}`);
      assert.equal(said(`${a} ${o}`, true), false, `asking: ${a} ${o}`);
    }
  }
  assert.deepEqual(new SpeechPolicy().feed('Focused pane wK:p2.'), { leak: 'an ID' });
  assert.equal(new SpeechPolicy().feed('Focused the linear pane in workspace two.'), null);
});

test('an offer at the end of a reply gets one [policy] note per turn of yours, sent after the reply without asking for another', () => {
  const { session, sent, feed } = liveSession();
  const offer = () => { feed(reply("Closed the pane. Let me know if you'd like to proceed.")); feed(turnDone); };
  offer();
  assert.deepEqual(texts(sent).map(([t, done]) => [t.split('.')[0], done]), [['[policy] Your last reply ended with an offer or a question about going on', false]]);
  offer();
  assert.equal(texts(sent).length, 1, 'once per turn');
  session.handle({ t: 'user', text: 'open the docs pane' });
  offer();
  assert.equal(texts(sent).length, 2);
  feed(reply('Opened the docs pane.'));
  feed(turnDone);
  assert.equal(texts(sent).length, 2);
});
