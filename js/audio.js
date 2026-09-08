/**
 * Sound, synthesised.
 *
 * Every cue is generated with WebAudio oscillators and shaped noise rather than
 * loaded from files: it keeps the project at zero dependencies and zero assets,
 * and a war-room bleep is a couple of oscillators anyway.
 *
 * Off by default and gated behind an explicit toggle. Browsers block audio
 * until a user gesture regardless, and a dashboard someone leaves open on a
 * second monitor must not start making noise on its own.
 */

const STORAGE_KEY = 'sew:audio';

let context = null;
let master = null;
let ambient = null;
let enabled = false;

export const isEnabled = () => enabled;

/** Restore the previous choice, without creating a context to do it. */
export function loadPreference() {
  try {
    enabled = localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    enabled = false;
  }
  return enabled;
}

/**
 * Turn sound on or off. Must be called from a user gesture the first time —
 * a context created outside one starts suspended and stays silent.
 */
export function setEnabled(next) {
  enabled = Boolean(next);
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch { /* private mode; the session still works */ }

  if (!enabled) {
    stopAmbient();
    return enabled;
  }

  ensureContext();
  // Chrome suspends contexts created before interaction; resume is a no-op
  // when it is already running.
  context?.resume?.();
  startAmbient();
  return enabled;
}

function ensureContext() {
  if (context) return context;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  master = context.createGain();
  master.gain.value = 0.5;
  master.connect(context.destination);
  return context;
}

/* ------------------------------------------------------------------ cues */

/**
 * A short pitched blip. `to` bends the pitch across the note, which is what
 * separates an acknowledging chirp from an alarm.
 */
function tone({ from, to = from, duration = 0.12, type = 'square', gain = 0.14, delay = 0 }) {
  if (!enabled || !ensureContext()) return;
  const start = context.currentTime + delay;
  const osc = context.createOscillator();
  const envelope = context.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + duration);

  // A tiny attack instead of an instant one: a hard edge reads as a click.
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(envelope).connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** Filtered noise, for the klaxon's body and for the teletype. */
function noise({ duration = 0.09, gain = 0.06, frequency = 1400, q = 1 }) {
  if (!enabled || !ensureContext()) return;
  const frames = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const source = context.createBufferSource();
  source.buffer = buffer;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = q;

  const envelope = context.createGain();
  const start = context.currentTime;
  envelope.gain.setValueAtTime(gain, start);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  source.connect(filter).connect(envelope).connect(master);
  source.start(start);
}

/** Data landed. */
export function chirp() {
  tone({ from: 880, to: 1320, duration: 0.07, gain: 0.05 });
}

/** A keystroke, for text typing itself out. */
export function tick() {
  noise({ duration: 0.02, gain: 0.03, frequency: 2600, q: 2 });
}

/** Terminal line accepted, during the boot sequence. */
export function confirm() {
  tone({ from: 660, to: 990, duration: 0.09, gain: 0.05 });
}

/** Uplink established. A rising three-note figure. */
export function fanfare() {
  tone({ from: 523, duration: 0.12, gain: 0.06, delay: 0 });
  tone({ from: 659, duration: 0.12, gain: 0.06, delay: 0.11 });
  tone({ from: 880, duration: 0.24, gain: 0.07, delay: 0.22 });
}

/** An event cue, pitched by how bad the news is. */
export function alert(severity) {
  switch (severity) {
    case 'critical':
      // Two-tone klaxon, falling: something has been lost.
      tone({ from: 440, to: 300, duration: 0.28, type: 'sawtooth', gain: 0.11 });
      tone({ from: 400, to: 260, duration: 0.28, type: 'sawtooth', gain: 0.10, delay: 0.3 });
      noise({ duration: 0.3, gain: 0.03, frequency: 500, q: 0.7 });
      break;
    case 'bad':
      tone({ from: 520, to: 380, duration: 0.22, type: 'sawtooth', gain: 0.09 });
      break;
    case 'good':
      tone({ from: 660, duration: 0.1, gain: 0.06 });
      tone({ from: 990, duration: 0.18, gain: 0.06, delay: 0.09 });
      break;
    default:
      chirp();
  }
}

/* --------------------------------------------------------------- ambient */

/**
 * Room tone: a low drone plus filtered noise, well under the cues. Quiet
 * enough to be felt rather than heard, which is the point.
 */
function startAmbient() {
  if (!enabled || ambient || !ensureContext()) return;

  const gain = context.createGain();
  gain.gain.value = 0.0001;
  gain.gain.exponentialRampToValueAtTime(0.03, context.currentTime + 2);
  gain.connect(master);

  const drone = context.createOscillator();
  drone.type = 'sine';
  drone.frequency.value = 58;
  drone.connect(gain);
  drone.start();

  const fifth = context.createOscillator();
  fifth.type = 'sine';
  fifth.frequency.value = 87;
  const fifthGain = context.createGain();
  fifthGain.gain.value = 0.4;
  fifth.connect(fifthGain).connect(gain);
  fifth.start();

  // Two seconds of noise on loop, low-passed into a hiss.
  const frames = context.sampleRate * 2;
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * 0.25;
  const hiss = context.createBufferSource();
  hiss.buffer = buffer;
  hiss.loop = true;
  const hissFilter = context.createBiquadFilter();
  hissFilter.type = 'lowpass';
  hissFilter.frequency.value = 620;
  const hissGain = context.createGain();
  hissGain.gain.value = 0.5;
  hiss.connect(hissFilter).connect(hissGain).connect(gain);
  hiss.start();

  ambient = { gain, nodes: [drone, fifth, hiss] };
}

function stopAmbient() {
  if (!ambient || !context) return;
  const { gain, nodes } = ambient;
  ambient = null;
  const end = context.currentTime + 0.4;
  gain.gain.cancelScheduledValues(context.currentTime);
  gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  for (const node of nodes) {
    try { node.stop(end + 0.05); } catch { /* already stopped */ }
  }
}
