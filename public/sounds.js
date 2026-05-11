'use strict';

// WebAudio-based sound effects — no asset files needed.
// Each call is short, layered envelopes designed to feel tactile rather than musical.

const Sounds = (() => {
  let ctx = null;
  let enabled = localStorage.getItem('elbbarcs:sound') !== 'off';

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ freq = 440, type = 'sine', dur = 0.12, gain = 0.18, attack = 0.005, release = 0.08, freqEnd = null, when = 0 }) {
    if (!enabled) return;
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + release);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.02);
  }

  function noise({ dur = 0.08, gain = 0.15, hpFreq = 800, when = 0 }) {
    if (!enabled) return;
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + when;
    const bufLen = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, bufLen, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufLen);
    const src = c.createBufferSource();
    src.buffer = buf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = hpFreq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(hp).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // Library
  const lib = {
    tilePlace() {
      // short wood-tick
      noise({ dur: 0.05, gain: 0.18, hpFreq: 1200 });
      tone({ freq: 320, freqEnd: 200, type: 'triangle', dur: 0.07, gain: 0.12, release: 0.04 });
    },
    tileRecall() {
      tone({ freq: 280, freqEnd: 380, type: 'triangle', dur: 0.07, gain: 0.1, release: 0.05 });
    },
    play() {
      // ascending triad
      tone({ freq: 523.25, type: 'sine', dur: 0.1, gain: 0.16, when: 0 });
      tone({ freq: 659.25, type: 'sine', dur: 0.1, gain: 0.16, when: 0.08 });
      tone({ freq: 783.99, type: 'sine', dur: 0.22, gain: 0.18, when: 0.16, release: 0.15 });
    },
    bingo() {
      // longer flourish
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
      notes.forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.1, gain: 0.18, when: i * 0.08 }));
      tone({ freq: 1567.98, type: 'sine', dur: 0.4, gain: 0.16, when: notes.length * 0.08, release: 0.3 });
    },
    error() {
      tone({ freq: 220, freqEnd: 130, type: 'sawtooth', dur: 0.18, gain: 0.14, release: 0.1 });
    },
    turn() {
      // gentle ding
      tone({ freq: 880, type: 'sine', dur: 0.08, gain: 0.14 });
      tone({ freq: 1320, type: 'sine', dur: 0.18, gain: 0.12, when: 0.06, release: 0.15 });
    },
    pass() {
      tone({ freq: 240, freqEnd: 180, type: 'sine', dur: 0.18, gain: 0.1, release: 0.1 });
    },
    exchange() {
      noise({ dur: 0.18, gain: 0.16, hpFreq: 600 });
    },
    gameOver() {
      const notes = [659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.51];
      notes.forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.16, gain: 0.18, when: i * 0.14, release: 0.12 }));
    },
    join() {
      tone({ freq: 523.25, type: 'sine', dur: 0.08, gain: 0.14 });
      tone({ freq: 659.25, type: 'sine', dur: 0.12, gain: 0.14, when: 0.08, release: 0.1 });
    },
    copy() {
      tone({ freq: 880, type: 'sine', dur: 0.05, gain: 0.1 });
      tone({ freq: 1175, type: 'sine', dur: 0.08, gain: 0.1, when: 0.04 });
    },
    chat() {
      tone({ freq: 660, type: 'sine', dur: 0.07, gain: 0.12 });
      tone({ freq: 990, type: 'sine', dur: 0.1, gain: 0.12, when: 0.06, release: 0.08 });
    },
    peerLeft() {
      tone({ freq: 440, freqEnd: 220, type: 'triangle', dur: 0.25, gain: 0.16, release: 0.15 });
    },
    peerBack() {
      tone({ freq: 440, type: 'sine', dur: 0.08, gain: 0.14 });
      tone({ freq: 660, type: 'sine', dur: 0.1, gain: 0.14, when: 0.06 });
      tone({ freq: 880, type: 'sine', dur: 0.12, gain: 0.14, when: 0.12, release: 0.1 });
    }
  };

  function play(name) {
    const fn = lib[name];
    if (fn) try { fn(); } catch (e) { /* swallow */ }
  }

  function setEnabled(v) {
    enabled = !!v;
    localStorage.setItem('elbbarcs:sound', enabled ? 'on' : 'off');
    if (enabled) ensureCtx();
  }

  function isEnabled() { return enabled; }

  // Unlock audio on first user gesture (required on iOS)
  function attachUnlock() {
    const unlock = () => {
      ensureCtx();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
  }
  attachUnlock();

  return { play, setEnabled, isEnabled };
})();

window.Sounds = Sounds;
