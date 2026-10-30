"use strict";

// MUSIC DATA — оригинальная 16-тактовая композиция «После света».
// Два инструмента: синкопированный бас и протяжённый гармонический синтезатор.
const MusicData = {
  waves: ["triangle", "square", "pulse", "sawtooth"],
  defaults: {
    sustain: 0,
    filter: 0,
    chorus: 0,
    delay: 0,
    attack: 0,
    distortion: 0,
    release: 0,
  },
  roots: [38, 38, 43, 43, 34, 34, 33, 33],
  // Правая партия — длинные созвучия без собственного ударного рисунка.
  melody: [
    [[0, [60, 65, 69], 0.68, 12]],
    [[0, [62, 65, 69], 0.68, 12]],
    [[0, [58, 62, 65], 0.68, 12]],
    [[0, [58, 62, 67], 0.68, 12]],
    [[0, [57, 62, 65], 0.68, 12]],
    [[0, [57, 60, 65], 0.68, 12]],
    [[0, [57, 62, 67], 0.68, 12]],
    [[0, [57, 61, 67], 0.68, 12]],
  ],
  events(voice, bar) {
    const harmony = bar % 8,
      secondHalf = bar >= 8;
    if (voice === 0) {
      const root = this.roots[harmony];
      const events = [
        [0, root, 1, 1.4],
        [3, root + 12, 0.47, 0.65],
        [4, root, 0.78, 1.1],
        [6, root + 7, 0.44, 0.6],
        [8, root, 0.94, 1.4],
        [11, root + 12, 0.55, 0.65],
        [12, root, 0.79, 1.1],
        [14, root + 7, 0.48, 0.6],
      ];
      if (bar < 2) return events.filter((e) => e[0] !== 3 && e[0] !== 11);
      if (harmony === 7) events.push([15, 37, 0.44, 0.6]); // C# → D на следующей фразе.
      return events;
    }
    let events = this.melody[harmony].map((e) => [
      e[0],
      Array.isArray(e[1]) ? [...e[1]] : e[1],
      e[2],
      e[3],
    ]);
    // Развитие только в гармонии: без дополнительных атак и подхватов.
    if (secondHalf && harmony === 3) events[0][1] = [58, 62, 69];
    if (secondHalf && harmony === 5) events[0][1] = [57, 62, 69];
    // Низкий стук входит в тот же правый голос и его цепочку эффектов.
    events.push([0, 38, 0.78, 1, "drum"], [8, 38, 0.58, 1, "drum"]);
    return events;
  },
};
const state = {
  playing: false,
  bpm: 104,
  volume: 0,
  volumeShape: "triangle",
  voices: [0, 1].map(() => ({ ...MusicData.defaults, wave: "triangle" })),
};

// AUDIO ENGINE — независимые шины и эффекты; один общий метр, без cross-modulation.
class AudioEngine {
  constructor(context = null, settings = state) {
    this.context = context;
    this.settings = settings;
    this.ready = false;
    this.chains = [];
    this.active = new Set();
    this.visualTimers = new Set();
    this.timer = null;
    this.step = 0;
    this.nextTime = 0;
    this.generation = 0;
    this.starting = false;
  }
  smooth(param, value, time = 0.035) {
    param.setTargetAtTime(value, this.context.currentTime, time);
  }
  initialize() {
    if (this.ready) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!this.context && !Context)
      throw Error("Браузер не поддерживает Web Audio API");
    const c = this.context || (this.context = new Context());
    this.master = c.createGain();
    this.master.gain.value = Math.sqrt(this.settings.volume) * 0.8;
    this.limiter = c.createDynamicsCompressor();
    Object.assign(this.limiter.threshold, { value: -4 });
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    // Мягкий ограничитель после компрессора ловит короткие пики на крайних настройках.
    this.safety = c.createWaveShaper();
    const ceiling = new Float32Array(8193);
    for (let i = 0; i < ceiling.length; i++) {
      const x = (2 * i) / (ceiling.length - 1) - 1,
        a = Math.abs(x);
      ceiling[i] =
        Math.sign(x) *
        (a <= 0.6 ? a : 0.6 + 0.25 * Math.tanh((a - 0.6) / 0.25));
    }
    this.safety.curve = ceiling;
    this.volumeMotion = c.createGain();
    this.master
      .connect(this.volumeMotion)
      .connect(this.limiter)
      .connect(this.safety)
      .connect(c.destination);
    // Только измерительная ветвь: не добавляет звук и не меняет стереовыход.
    this.bassMeterFilter = c.createBiquadFilter();
    this.bassMeterFilter.type = "lowpass";
    this.bassMeterFilter.frequency.value = 170;
    this.bassMeterFilter.Q.value = 0.7;
    this.bassAnalyser = c.createAnalyser();
    this.bassAnalyser.fftSize = 1024;
    this.safety.connect(this.bassMeterFilter).connect(this.bassAnalyser);
    const real = new Float32Array(49),
      imag = new Float32Array(49),
      duty = 0.32;
    for (let n = 1; n < 49; n++) {
      real[n] = Math.sin(2 * Math.PI * n * duty) / (Math.PI * n);
      imag[n] = (1 - Math.cos(2 * Math.PI * n * duty)) / (Math.PI * n);
    }
    this.pulse = c.createPeriodicWave(real, imag);
    this.chains = this.settings.voices.map((_, i) => {
      const input = c.createGain(),
        highpass = c.createBiquadFilter(),
        filter = c.createBiquadFilter(),
        shaper = c.createWaveShaper(),
        dry = c.createGain(),
        chorus = c.createDelay(0.1),
        chorusWet = c.createGain(),
        lfo = c.createOscillator(),
        depth = c.createGain(),
        echo = c.createDelay(2),
        feedback = c.createGain(),
        wet = c.createGain(),
        output = c.createGain(),
        groove = c.createGain(),
        echoFilter = c.createBiquadFilter(),
        panner = c.createStereoPanner();
      highpass.type = "highpass";
      highpass.frequency.value = i ? 220 : 25;
      highpass.Q.value = 0.5;
      filter.type = "lowpass";
      filter.Q.value = 0.55;
      shaper.oversample = "2x";
      dry.gain.value = 0.88;
      input.connect(highpass).connect(shaper).connect(filter);
      filter.connect(dry).connect(output);
      filter.connect(chorus).connect(chorusWet).connect(output);
      chorus.delayTime.value = i ? 0.022 : 0.014;
      lfo.frequency.value = i ? 0.27 : 0.17;
      lfo.connect(depth).connect(chorus.delayTime);
      lfo.start();
      filter.connect(echo);
      echoFilter.type = "lowpass";
      echoFilter.frequency.value = i ? 3400 : 1500;
      echo.connect(echoFilter).connect(feedback).connect(echo);
      echo.connect(wet).connect(output);
      // Собственное диффузное пространство правого тембра; импульс синтезирован.
      let room = null,
        roomWet = null;
      if (i === 1) {
        room = c.createConvolver();
        roomWet = c.createGain();
        const impulse = c.createBuffer(
          2,
          Math.ceil(c.sampleRate * 2.2),
          c.sampleRate,
        );
        let seed = 73129;
        for (let ch = 0; ch < 2; ch++) {
          const samples = impulse.getChannelData(ch);
          for (let j = 0; j < samples.length; j++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const t = j / c.sampleRate;
            samples[j] =
              t < 0.018
                ? 0
                : ((seed / 4294967296) * 2 - 1) *
                  Math.exp(-t * 3.2) *
                  Math.pow(1 - j / samples.length, 2);
          }
        }
        room.buffer = impulse;
        roomWet.gain.value = 0.16;
        filter.connect(room).connect(roomWet).connect(output);
      }
      panner.pan.value = i ? 0.68 : -0.68;
      output.connect(groove).connect(panner).connect(this.master);
      return {
        input,
        highpass,
        filter,
        shaper,
        dry,
        chorus,
        chorusWet,
        lfo,
        depth,
        echo,
        feedback,
        wet,
        output,
        groove,
        echoFilter,
        panner,
        room,
        roomWet,
      };
    });
    this.ready = true;
    this.settings.voices.forEach((_, i) => this.update(i));
  }
  update(index) {
    if (!this.ready) return;
    const v = this.settings.voices[index],
      n = this.chains[index];
    // Срез сохраняет характер выбранной волны даже при нулевом filter.
    const baseCutoff = index
      ? { triangle: 900, square: 1900, pulse: 2600, sawtooth: 4200 }
      : { triangle: 90, square: 480, pulse: 750, sawtooth: 1500 };
    const floor = baseCutoff[v.wave];
    this.smooth(
      n.filter.frequency,
      floor * Math.pow((index ? 16000 : 12000) / floor, v.filter),
    );
    this.smooth(
      n.filter.Q,
      (index ? 0.4 : 0.55) + v.filter * (index ? 0.65 : 1.15),
    );
    if (n.roomWet) this.smooth(n.roomWet.gain, 0.16 + v.release * 0.12);
    this.smooth(
      n.depth.gain,
      Math.pow(v.chorus, 0.75) * (index ? 0.012 : 0.008),
    );
    this.smooth(n.chorusWet.gain, v.chorus * (index ? 0.8 : 0.65));
    this.smooth(
      n.echo.delayTime,
      (60 / this.settings.bpm) * (index ? 0.75 : 0.5),
      0.08,
    );
    this.smooth(n.feedback.gain, v.delay * 0.68);
    this.smooth(n.wet.gain, v.delay * (index ? 0.6 : 0.45));
    // Нулевая distortion — точный линейный проход; мягкое насыщение выше нуля.
    const curve = new Float32Array(4096),
      drive = v.distortion * 8;
    for (let i = 0; i < curve.length; i++) {
      const x = (2 * i) / (curve.length - 1) - 1;
      curve[i] = drive < 0.001 ? x : Math.tanh(drive * x) / Math.tanh(drive);
    }
    n.shaper.curve = curve;
    this.smooth(
      n.output.gain,
      (index ? 0.76 : 0.73) / (1 + v.distortion * 0.45),
    );
    this.updateVolumes();
  }
  updateVolumes() {
    if (this.ready)
      this.smooth(this.master.gain, Math.sqrt(this.settings.volume) * 0.8);
  }
  applyWave(osc, wave) {
    if (wave === "pulse") osc.setPeriodicWave(this.pulse);
    else osc.type = wave;
  }
  // Замена формы волны происходит через crossfade, а не скачком фазы.
  setWave(index) {
    if (!this.ready) return;
    const now = this.context.currentTime;
    this.update(index);
    for (const note of this.active) {
      if (note.index !== index || note.percussive || note.end <= now + 0.04)
        continue;
      const at = Math.max(now, note.start);
      note.tone.frequency.cancelScheduledValues(at);
      note.tone.frequency.setTargetAtTime(
        this.noteCutoff(index, this.settings.voices[index].wave),
        at,
        0.04,
      );
      for (const source of [...note.sources]) {
        if (source.retiring || source.fixedWave) continue;
        source.retiring = true;
        const at = Math.max(now, note.start);
        const osc = this.context.createOscillator(),
          mix = this.context.createGain(),
          spread = this.context.createStereoPanner();
        this.applyWave(osc, this.settings.voices[index].wave);
        osc.frequency.value = source.frequency;
        osc.detune.value = source.detune;
        mix.gain.setValueAtTime(0, at);
        mix.gain.linearRampToValueAtTime(source.level, at + 0.035);
        source.mix.gain.cancelScheduledValues(at);
        source.mix.gain.setValueAtTime(source.mix.gain.value, at);
        source.mix.gain.linearRampToValueAtTime(0, at + 0.035);
        spread.pan.value = source.pan || 0;
        osc.connect(mix).connect(spread).connect(note.envelope);
        osc.start(at);
        osc.stop(note.end);
        const next = {
          osc,
          mix,
          spread,
          pan: source.pan || 0,
          frequency: source.frequency,
          detune: source.detune,
          level: source.level,
          retiring: false,
        };
        note.sources.push(next);
        try {
          source.osc.stop(at + 0.04);
        } catch {}
      }
    }
  }
  noteCutoff(index, wave) {
    const cutoff = index
      ? { triangle: 1900, square: 3200, pulse: 4500, sawtooth: 7000 }
      : { triangle: 360, square: 850, pulse: 1300, sawtooth: 2600 };
    return cutoff[wave];
  }
  drumNote(index, event, time) {
    const c = this.context;
    const v = this.settings.voices[index];
    const envelope = c.createGain();
    const tone = c.createBiquadFilter();
    const osc = c.createOscillator();
    const mix = c.createGain();
    const spread = c.createStereoPanner();
    const attack = 0.004 + Math.pow(v.attack, 3) * 0.12;
    const decay = 0.19 + v.sustain * 0.12 + v.release * 0.22;
    const end = time + attack + decay + 0.03;
    const fundamental = 440 * Math.pow(2, (event[1] - 69) / 12);

    // Мембрана: короткий спад высоты к ре, без дополнительного суббаса.
    osc.type = "sine";
    osc.frequency.setValueAtTime(fundamental * 2.7, time);
    osc.frequency.exponentialRampToValueAtTime(fundamental, time + 0.065);
    mix.gain.value = 1;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(event[2] * 0.52, time + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    tone.type = "highpass";
    tone.frequency.value = 32;
    tone.Q.value = 0.5;

    // У мелодии сохраняется её high-pass; барабан проходит собственный срез.
    // Дальше стук и мелодия используют общие distortion, filter, chorus,
    // delay и панораму правого голоса.
    osc.connect(mix).connect(spread).connect(envelope);
    envelope.connect(tone).connect(this.chains[index].shaper);
    const note = {
      index,
      percussive: true,
      start: time,
      end,
      envelope,
      tone,
      sources: [{ osc, mix, spread, fixedWave: "sine" }],
    };
    this.active.add(note);
    osc.onended = () => {
      osc.disconnect();
      mix.disconnect();
      spread.disconnect();
      envelope.disconnect();
      tone.disconnect();
      this.active.delete(note);
    };
    osc.start(time);
    osc.stop(end + 0.01);
  }
  note(index, event, time, visual = true) {
    if (event[4] === "drum") {
      this.drumNote(index, event, time);
      return;
    }
    const c = this.context,
      v = this.settings.voices[index],
      step = 60 / this.settings.bpm / 4;
    const pitches = Array.isArray(event[1]) ? event[1] : [event[1]];
    const envelope = c.createGain(),
      tone = c.createBiquadFilter();
    const attack =
      (index ? 0.22 : 0.004) + Math.pow(v.attack, 3) * (index ? 0.9 : 0.24);
    const decay = index ? 0.5 : 0.075,
      hold = Math.max(
        0.025,
        event[3] * step * ((index ? 0.95 : 0.45) + v.sustain * 2.8),
      );
    const release =
      (index ? 0.65 : 0.04) + Math.pow(v.release, 2) * (index ? 3.4 : 1.3);
    const level =
      (event[2] * (index ? 0.26 : 0.68)) / Math.sqrt(pitches.length);
    const sustain =
      level * (index ? 0.65 + v.sustain * 0.25 : 0.09 + v.sustain * 0.58);
    const end = time + attack + decay + hold + release + 0.02;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(level, time + attack);
    envelope.gain.exponentialRampToValueAtTime(sustain, time + attack + decay);
    envelope.gain.setValueAtTime(sustain, time + attack + decay + hold);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end - 0.02);
    // У каждой ноты — артикуляция фильтра; ползунок регулирует общий тон отдельно.
    tone.type = "lowpass";
    tone.Q.value = index ? 0.55 : 0.8;
    const cutoff = this.noteCutoff(index, v.wave);
    tone.frequency.setValueAtTime(
      Math.max(index ? 2400 : 2100, cutoff * 1.4),
      time,
    );
    tone.frequency.exponentialRampToValueAtTime(
      cutoff,
      time + attack + decay + 0.08,
    );
    envelope.connect(tone).connect(this.chains[index].input);
    const note = { index, start: time, end, envelope, tone, sources: [] };
    this.active.add(note);
    for (const midi of pitches) {
      const frequency = 440 * Math.pow(2, (midi - 69) / 12);
      const layers = index
        ? [
            { ratio: 1, level: 0.46, detune: -6, pan: -0.65 },
            { ratio: 1, level: 0.34, detune: 6, pan: 0.65 },
            { ratio: 1, level: 0.2, wave: "sine" },
          ]
        : [
            { ratio: 1, level: 0.9 },
            { ratio: 0.5, level: 0.22, wave: "sine" },
          ];
      for (const layer of layers) {
        const osc = c.createOscillator(),
          mix = c.createGain(),
          spread = c.createStereoPanner(),
          sourceLevel = layer.level,
          layerFrequency = frequency * layer.ratio,
          detune = layer.detune || 0;
        if (layer.wave) osc.type = layer.wave;
        else this.applyWave(osc, v.wave);
        osc.frequency.value = layerFrequency;
        osc.detune.value = detune;
        mix.gain.value = sourceLevel;
        if (index === 0 && !layer.wave) {
          osc.frequency.setValueAtTime(frequency * 1.12, time);
          osc.frequency.exponentialRampToValueAtTime(frequency, time + 0.028);
        }
        spread.pan.value = layer.pan || 0;
        osc.connect(mix).connect(spread).connect(envelope);
        osc.start(time);
        osc.stop(end);
        note.sources.push({
          osc,
          mix,
          spread,
          pan: layer.pan || 0,
          frequency: layerFrequency,
          detune,
          level: sourceLevel,
          retiring: false,
          fixedWave: layer.wave,
        });
      }
    }
    // Конец огибающей освобождает все осцилляторы ноты, включая заменённые волны.
    const cleanup = c.createConstantSource();
    cleanup.offset.value = 0;
    cleanup.connect(envelope);
    cleanup.start(time);
    cleanup.stop(end + 0.01);
    cleanup.onended = () => {
      note.sources.forEach((s) => {
        s.osc.disconnect();
        s.mix.disconnect();
        s.spread.disconnect();
      });
      envelope.disconnect();
      tone.disconnect();
      cleanup.disconnect();
      this.active.delete(note);
    };
  }
  beat(time) {
    // У правого голоса больше нет отдельного четвертного приглушения.
    const beat = 60 / this.settings.bpm;
    // Общая громкость: три формы огибающей, синхронные четвертной доле.
    // Совпадающие начало/конец и короткие переходы предотвращают скачки.
    const motion = this.volumeMotion.gain,
      edge = 0.008;
    motion.setValueAtTime(1, time);
    if (this.settings.volumeShape === "square") {
      motion.setValueAtTime(1, time + beat * 0.48);
      motion.linearRampToValueAtTime(0.22, time + beat * 0.48 + edge);
      motion.setValueAtTime(0.22, time + beat - edge);
    } else if (this.settings.volumeShape === "pulse") {
      motion.setValueAtTime(1, time + beat * 0.14);
      motion.linearRampToValueAtTime(0.12, time + beat * 0.14 + edge);
      motion.setValueAtTime(0.12, time + beat - edge);
    } else {
      motion.linearRampToValueAtTime(0.35, time + beat * 0.5);
    }
    motion.linearRampToValueAtTime(1, time + beat);
  }
  schedule() {
    if (!this.settings.playing) return;
    while (this.nextTime < this.context.currentTime + 0.1) {
      const step = this.step % 16,
        bar = Math.floor(this.step / 16) % 16;
      if (step % 4 === 0) this.beat(this.nextTime);
      this.settings.voices.forEach((_, i) =>
        MusicData.events(i, bar)
          .filter((e) => e[0] === step)
          .forEach((e) =>
            this.note(i, e, this.nextTime + (step % 2 === 1 ? 0.014 : 0)),
          ),
      );
      this.nextTime += 60 / this.settings.bpm / 4;
      this.step++;
    }
  }
  async play() {
    if (this.settings.playing || this.starting) return;
    this.starting = true;
    try {
      this.initialize();
      await this.context.resume();
      this.settings.playing = true;
      this.generation++;
      this.step = 0;
      this.nextTime = this.context.currentTime + 0.045;
      this.volumeMotion.gain.cancelScheduledValues(this.context.currentTime);
      this.volumeMotion.gain.setValueAtTime(1, this.context.currentTime);
      this.chains.forEach((n) => {
        n.groove.gain.cancelScheduledValues(this.context.currentTime);
        n.groove.gain.setValueAtTime(1, this.context.currentTime);
      });
      this.updateVolumes();
      this.schedule();
      this.timer = setInterval(() => this.schedule(), 25);
      Interface.renderTransport();
    } finally {
      this.starting = false;
    }
  }
  stop() {
    this.settings.playing = false;
    this.generation++;
    clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.visualTimers) clearTimeout(timer);
    this.visualTimers.clear();
    if (this.ready) {
      const now = this.context.currentTime;
      for (const n of this.active) {
        if (n.envelope.gain.cancelAndHoldAtTime)
          n.envelope.gain.cancelAndHoldAtTime(now);
        else n.envelope.gain.cancelScheduledValues(now);
        n.envelope.gain.setTargetAtTime(0.0001, now, 0.025);
        n.sources.forEach((s) => {
          try {
            s.osc.stop(now + 0.16);
          } catch {}
        });
      }
    }
    Interface.renderTransport();
  }
}
const engine = new AudioEngine();
