// Run with: node --test linux/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiWire, ResponseScheduler, Session, SpeechGate, hidesOnStart, keyAction, parseConfig, rms, setupMessage } from './herdr-voice.mjs';

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
  assert.deepEqual(w.decode({ serverContent: { inputTranscription: { text: 'tell claude' } } }), [{ t: 'speechStarted' }]);
  assert.equal(w.decode({ serverContent: { inputTranscription: { text: ' to run the tests' } } })[0].t, 'ignored');
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
  assert.deepEqual(w.decode({ goAway: { timeLeft: '10s' } }), [{ t: 'ending' }]);
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
  const session = new Session({ key: 'k', model: 'm', voice: 'v', createTools: () => ({}), speaker: { isSpeaking: false, interrupt() {} } });
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
