// 2.5D 纸偶骨骼运行时:把足球女孩切成6部件,绕关节旋转做真实动作(保留足球造型)。
// 接口对齐:init(container) / setVisibility / execute(plan) / talk / destroy
(function () {
  // 关节轴点(占全画布百分比),来自 tools_rig_cut.py 的部件矩形与解剖位置
  const PARTS = [
    { id: "leg_l", origin: "46% 59%", z: 1 },
    { id: "leg_r", origin: "53% 59%", z: 1 },
    { id: "torso", origin: "49% 29%", z: 2 },
    { id: "arm_l", origin: "44% 24%", z: 3 }, // 画面左=角色右肩
    { id: "arm_r", origin: "56% 24%", z: 3 }, // 画面右肩
    { id: "head", origin: "49.4% 21%", z: 4 },
  ];

  class RigRuntime {
    constructor(teamPrefix = "rig") {
      this.layers = {};
      this.root = null;
      this.t0 = performance.now();
      this.raf = null;
      this.pose = this._neutral();
      this.cur = this._neutral();
      this.talking = false;
      this.mouth = 0;
      this.blink = 0;
      this.prefix = teamPrefix;
    }

    _neutral() {
      return { headRot: 0, headX: 0, bodyRot: 0, bodyY: 0, bodyScale: 1,
               armLRot: 0, armRRot: 0, legLRot: 0, legRRot: 0 };
    }

    async init(container) {
      this.root = document.createElement("div");
      Object.assign(this.root.style, {
        position: "absolute", inset: "0", zIndex: "8",
        pointerEvents: "none", transition: "opacity .5s",
      });
      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        position: "absolute", left: "0", bottom: "0", width: "100%", height: "100%",
      });
      this.root.appendChild(wrap);
      for (const p of PARTS) {
        const img = document.createElement("img");
        img.src = `models/${this.prefix}_${p.id}.png`;
        Object.assign(img.style, {
          position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
          objectFit: "contain", transformOrigin: p.origin, zIndex: String(p.z),
          willChange: "transform", filter: "drop-shadow(0 6px 12px rgba(0,0,0,.3))",
        });
        wrap.appendChild(img);
        this.layers[p.id] = img;
      }
      container.appendChild(this.root);
      this._loop();
      return this;
    }

    _loop() {
      const tick = () => {
        const t = (performance.now() - this.t0) / 1000;
        // 连续待机:呼吸(身体缩放)+ 轻微摆动 + 头发随头动
        const breath = Math.sin(t * 1.7) * 0.012;
        const swayBody = Math.sin(t * 0.8) * 1.2;
        const swayHead = Math.sin(t * 0.9 + 0.4) * 2.0;

        // 目标 = 当前动作姿态 + 待机叠加
        const tgt = this.pose;
        const k = 0.12; // 平滑系数
        const c = this.cur;
        c.headRot += ((tgt.headRot + swayHead) - c.headRot) * k;
        c.headX += (tgt.headX - c.headX) * k;
        c.bodyRot += ((tgt.bodyRot + swayBody) - c.bodyRot) * k;
        c.bodyY += (tgt.bodyY - c.bodyY) * k;
        c.bodyScale += ((tgt.bodyScale + breath) - c.bodyScale) * k;
        c.armLRot += (tgt.armLRot - c.armLRot) * k;
        c.armRRot += (tgt.armRRot - c.armRRot) * k;
        c.legLRot += (tgt.legLRot - c.legLRot) * k;
        c.legRRot += (tgt.legRRot - c.legRRot) * k;

        const L = this.layers;
        const bodyT = `translateY(${c.bodyY}px) rotate(${c.bodyRot}deg) scale(${c.bodyScale})`;
        if (L.torso) L.torso.style.transform = bodyT;
        if (L.head) L.head.style.transform = `translateY(${c.bodyY}px) translateX(${c.headX}px) rotate(${c.headRot}deg) scale(${c.bodyScale})`;
        if (L.arm_l) L.arm_l.style.transform = `translateY(${c.bodyY}px) rotate(${c.armLRot}deg) scale(${c.bodyScale})`;
        if (L.arm_r) L.arm_r.style.transform = `translateY(${c.bodyY}px) rotate(${c.armRRot}deg) scale(${c.bodyScale})`;
        if (L.leg_l) L.leg_l.style.transform = `rotate(${c.legLRot}deg)`;
        if (L.leg_r) L.leg_r.style.transform = `rotate(${c.legRRot}deg)`;
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    }

    setVisibility(v) {
      if (!this.root) return;
      this.root.style.opacity = v === "hide" ? "0.03" : v === "dim" ? "0.1" : "1";
    }

    setMouthOpen(v) { this.mouth = v; }
    talk(on) { this.talking = on; }

    _set(pose, ms = 2500) {
      this.pose = Object.assign(this._neutral(), pose);
      clearTimeout(this._reset);
      this._reset = setTimeout(() => { this.pose = this._neutral(); }, ms);
    }

    execute(plan = {}) {
      const emotion = plan.emotion || "calm";
      const act = plan.act || "idle";
      const I = Math.max(0.3, Math.min(1, Number(plan.intensity ?? 0.5)));
      const dur = Math.max(900, Math.min(6000, Number(plan.duration_ms ?? 1800)));
      if (plan.visibility) this.setVisibility(plan.visibility);

      if (emotion === "hype" || act === "cheer" || act === "clap") {
        // 欢呼:双臂上举 + 跳 + 仰头
        this._set({ armLRot: -120 * I, armRRot: 120 * I, bodyY: -22 * I, headRot: -6, bodyScale: 1.03 }, dur);
        this._hop(I);
      } else if (act === "wave") {
        this._set({ armRRot: 55 * I, headRot: 5 }, dur);
        this._waveArm(I, dur);
      } else if (act === "facepalm" || emotion === "angry") {
        this._set({ armLRot: -150 * I, headRot: 12, bodyRot: -3 }, dur);
      } else if (act === "think") {
        this._set({ armRRot: 70 * I, headRot: 10, headX: 4 }, dur);
      } else if (act === "kick") {
        this._set({ legRRot: -38 * I, bodyRot: 5, armLRot: 30 }, dur);
        setTimeout(() => { this.pose.legRRot = 0; }, 380);
      } else if (act === "point" || emotion === "surprise") {
        this._set({ armRRot: 80 * I, headRot: -4, bodyRot: 2 }, dur);
      } else {
        this._set({ headRot: 3 }, dur);
      }
    }

    _hop(I) {
      const torso = this.layers.torso;
      [this.layers.head, this.layers.torso, this.layers.arm_l, this.layers.arm_r].forEach((l) => {
        if (!l) return;
        l.animate([
          { marginTop: "0px" },
          { marginTop: `${-30 * I}px` },
          { marginTop: "0px" },
        ], { duration: 650, easing: "cubic-bezier(.3,1.4,.5,1)" });
      });
    }

    _waveArm(I, dur) {
      const a = this.layers.arm_r;
      if (!a) return;
      a.animate([
        { transform: "rotate(35deg)" },
        { transform: `rotate(${65 * I}deg)` },
        { transform: "rotate(35deg)" },
      ], { duration: 520, iterations: Math.max(2, Math.round(dur / 520)), easing: "ease-in-out" });
    }

    destroy() {
      if (this.raf) cancelAnimationFrame(this.raf);
      if (this.root && this.root.parentElement) this.root.parentElement.removeChild(this.root);
    }
  }

  window.RigRuntime = RigRuntime;
})();
