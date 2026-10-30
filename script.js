"use strict";

// CASSETTE VISUAL — скорость катушек следует энергии реального баса.
const CassetteVisual = {
  frame: null,
  angle: 0,
  hubAngle: 0,
  speed: 0,
  previousTime: 0,
  samples: null,
  start() {
    if (
      this.frame !== null ||
      !engine.bassAnalyser ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    this.element = document.querySelector(".cassette");
    this.samples = new Float32Array(engine.bassAnalyser.fftSize);
    this.previousTime = performance.now();
    this.frame = requestAnimationFrame((time) => this.tick(time));
  },
  tick(time) {
    if (!state.playing) {
      this.stop();
      return;
    }
    const dt = Math.min(0.1, (time - this.previousTime) / 1000);
    this.previousTime = time;
    engine.bassAnalyser.getFloatTimeDomainData(this.samples);
    let power = 0;
    for (const sample of this.samples) power += sample * sample;
    const energy =
      state.volume > 0
        ? Math.min(1, Math.sqrt(power / this.samples.length) * 14)
        : 0;
    // При тишине катушки стоят; акценты ускоряют их без скачков угла.
    const targetSpeed =
      energy > 0.008 ? (state.bpm / 60) * 55 + energy * 280 : 0;
    this.speed +=
      (targetSpeed - this.speed) *
      (1 - Math.exp(-dt / (targetSpeed > this.speed ? 0.07 : 0.25)));
    if (targetSpeed === 0 && this.speed < 0.05) this.speed = 0;
    this.angle = (this.angle + this.speed * dt) % 360;
    this.hubAngle = (this.hubAngle + this.speed * dt * 1.39) % 360;
    this.element.style.setProperty("--reel-angle", this.angle + "deg");
    this.element.style.setProperty("--hub-angle", this.hubAngle + "deg");
    this.frame = requestAnimationFrame((next) => this.tick(next));
  },
  stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.speed = 0;
  },
};

// INTERFACE — только элементы исходного макета, без скрытых меню.
const Interface = {
  init() {
    document.querySelectorAll(".voice").forEach((panel, index) => {
      panel.addEventListener("input", (e) => {
        const key = e.target.dataset.param;
        if (!key) return;
        state.voices[index][key] = Number(e.target.value);
        const out = panel.querySelector(`[data-output="${key}"]`);
        if (out) out.value = Number(e.target.value).toFixed(2);
        engine.update(index);
      });
      panel.addEventListener("click", (e) => {
        const button = e.target.closest("button");
        if (!button) return;
        const v = state.voices[index];
        if (button.dataset.wave) {
          v.wave = button.dataset.wave;
          engine.setWave(index);
        }
        this.renderVoice(index);
        this.renderVolumeShape();
      });
      this.renderVoice(index);
    });
    const link = document.querySelector(".wave-link");
    link.addEventListener("click", (e) => {
      const w = e.target.dataset.wave;
      if (w) {
        state.volumeShape = w;
        this.renderVolumeShape();
      }
    });
    document.querySelector(".transport").addEventListener("click", async () => {
      try {
        if (state.playing) engine.stop();
        else await engine.play();
        document.querySelector(".status").textContent = "";
      } catch (error) {
        document.querySelector(".status").textContent = error.message;
        engine.stop();
      }
    });
    document.querySelector("#master-volume").addEventListener("input", (e) => {
      state.volume = Number(e.target.value);
      engine.updateVolumes();
    });
    document.addEventListener("keydown", (e) => {
      if (
        e.code === "Space" &&
        !/INPUT|SELECT|BUTTON|SUMMARY/.test(e.target.tagName)
      ) {
        e.preventDefault();
        document.querySelector(".transport").click();
      }
    });
    window.addEventListener("pagehide", () => engine.stop());
    window.addEventListener("pageshow", () => this.resetControls());
    this.resetControls();
    this.renderVolumeShape();
  },
  resetControls() {
    state.volume = 0;
    document.querySelector("#master-volume").value = "0";
    state.voices.forEach((voice, index) => {
      Object.assign(voice, MusicData.defaults);
      const panel = document.querySelector(`[data-voice="${index}"]`);
      panel.querySelectorAll("[data-param]").forEach((input) => {
        input.value = "0";
      });
      panel.querySelectorAll("[data-output]").forEach((output) => {
        output.value = "0.00";
      });
      engine.update(index);
    });
    engine.updateVolumes();
  },
  renderVoice(index) {
    const v = state.voices[index],
      panel = document.querySelector(`[data-voice="${index}"]`);
    if (!panel) return;
    panel.querySelectorAll("[data-wave]").forEach((b) => {
      const yes = b.dataset.wave === v.wave;
      b.classList.toggle("active", yes);
      b.setAttribute("aria-pressed", yes);
    });
  },
  renderVolumeShape() {
    document.querySelectorAll(".wave-link button").forEach((b) => {
      const yes = state.volumeShape === b.dataset.wave;
      b.classList.toggle("active", yes);
      b.setAttribute("aria-pressed", yes);
    });
  },
  renderTransport() {
    const b = document.querySelector(".transport");
    b.classList.toggle("playing", state.playing);
    b.setAttribute("aria-pressed", state.playing);
    b.setAttribute(
      "aria-label",
      state.playing ? "Остановить воспроизведение" : "Начать воспроизведение",
    );
    if (state.playing) CassetteVisual.start();
    else CassetteVisual.stop();
  },
};
if (document.querySelector(".instrument")) Interface.init();
