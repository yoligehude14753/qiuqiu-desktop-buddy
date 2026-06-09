// Live2D 骨骼动作运行时:用 motion plan 驱动连续表情/手势/物理,而非换图。
// 暴露 window.Live2DRuntime,接口与 SpriteRuntime 对齐:
//   init(canvas) / setVisibility(v) / execute(plan) / setMouthOpen(v) / talk(on) / destroy()
(function () {
  const { Live2DModel } = (window.PIXI && window.PIXI.live2d) || {};

  // 平滑驱动:维护“目标值”,每帧向目标线性逼近,做出连续自然的过渡。
  class ParamDriver {
    constructor() {
      this.targets = {};   // id -> {value, weight, decay}
    }
    set(id, value, weight = 1, decay = 0) {
      this.targets[id] = { value, weight, decay };
    }
    // 临时姿态:一段时间后自动回归中性
    pulse(id, value, ms = 1500) {
      this.set(id, value, 1, 0);
      clearTimeout(this["_t_" + id]);
      this["_t_" + id] = setTimeout(() => { delete this.targets[id]; }, ms);
    }
  }

  class Live2DRuntime {
    constructor() {
      this.app = null;
      this.model = null;
      this.driver = new ParamDriver();
      this.mouthOpen = 0;
      this.talking = false;
      this.blinkT = 0;
      this.nextBlink = 1500;
      this.t0 = performance.now();
      this.ready = false;
      this.cur = {}; // 当前平滑值
    }

    async init(canvas, modelPath) {
      if (!Live2DModel) throw new Error("pixi-live2d-display 未加载");
      this.app = new window.PIXI.Application({
        view: canvas, autoStart: true, resizeTo: canvas.parentElement || window,
        backgroundAlpha: 0, antialias: true,
      });
      this.model = await Live2DModel.from(modelPath, { autoInteract: false });
      const fit = () => {
        const W = canvas.clientWidth || 320, H = canvas.clientHeight || 460;
        const mw = this.model.internalModel.width, mh = this.model.internalModel.height;
        // 完整显示整个角色:按宽高取最小缩放并留边距
        const s = Math.min(W / mw, H / mh) * 0.92;
        this.model.scale.set(s);
        this.model.anchor.set(0.5, 0.5);
        this.model.x = W / 2;
        this.model.y = H / 2 + 10;
      };
      this.app.stage.addChild(this.model);
      fit();
      window.addEventListener("resize", fit);

      // 每帧在模型自身更新后覆盖参数,保证我们的驱动生效。
      this.app.ticker.add(() => this._frame());
      this.ready = true;
      return this;
    }

    _cm() { return this.model && this.model.internalModel && this.model.internalModel.coreModel; }

    _frame() {
      const cm = this._cm();
      if (!cm) return;
      const now = performance.now();
      const t = (now - this.t0) / 1000;

      // 连续待机:呼吸 + 极轻身体摆动 + 头发物理(模型自带)
      this._apply(cm, "ParamBreath", (Math.sin(t * 1.6) * 0.5 + 0.5), 0.25);
      this._apply(cm, "ParamBodyAngleX", Math.sin(t * 0.8) * 4, 0.2);
      this._apply(cm, "ParamBodyAngleZ", Math.sin(t * 0.6) * 2, 0.2);

      // 自动眨眼
      this.blinkT += this.app.ticker.deltaMS;
      let eye = 1;
      if (this.blinkT > this.nextBlink) {
        const p = (this.blinkT - this.nextBlink) / 120; // 120ms 一次眨眼
        eye = p < 1 ? Math.abs(p - 0.5) * 2 : 1;
        if (p >= 1) { this.blinkT = 0; this.nextBlink = 1800 + Math.random() * 2800; }
      }
      this._setSmooth(cm, "ParamEyeLOpen", eye, 0.5);
      this._setSmooth(cm, "ParamEyeROpen", eye, 0.5);

      // 口型:说话时由音频驱动
      this._setSmooth(cm, "ParamMouthOpenY", this.talking ? this.mouthOpen : (this.cur.ParamMouthOpenY || 0) * 0.8, 0.5);

      // 应用 driver 目标(表情/手势)
      for (const [id, tgt] of Object.entries(this.driver.targets)) {
        this._setSmooth(cm, id, tgt.value, tgt.weight ?? 0.35);
      }
    }

    _apply(cm, id, val, lerp) { this._setSmooth(cm, id, val, lerp); }
    _setSmooth(cm, id, target, lerp = 0.3) {
      const prev = this.cur[id] ?? 0;
      const v = prev + (target - prev) * lerp;
      this.cur[id] = v;
      try { cm.setParameterValueById(id, v); } catch (_) {}
    }

    setVisibility(v) {
      const el = this.app && this.app.view;
      if (!el) return;
      el.style.transition = "opacity .5s";
      el.style.opacity = v === "hide" ? "0.03" : v === "dim" ? "0.1" : "1";
    }

    setMouthOpen(v) { this.mouthOpen = Math.max(0, Math.min(1, v)); }
    talk(on) { this.talking = on; if (!on) this.mouthOpen = 0; }

    // motion plan → 表情 + 手势 + 动作组
    execute(plan = {}) {
      const emotion = plan.emotion || "calm";
      const act = plan.act || "idle";
      const intensity = Math.max(0.2, Math.min(1, Number(plan.intensity ?? 0.5)));
      const dur = Math.max(800, Math.min(6000, Number(plan.duration_ms ?? 1600)));
      const d = this.driver;

      // 先清掉上一轮临时姿态权重(让表情能切换)
      this._neutralFace();

      const big = intensity;
      if (emotion === "hype" || act === "cheer" || act === "clap") {
        d.pulse("ParamEyeLSmile", 1, dur); d.pulse("ParamEyeRSmile", 1, dur);
        d.pulse("ParamMouthForm", 1, dur); d.pulse("ParamMouthOpenY", 0.7 * big, dur);
        d.pulse("ParamBrowLY", 0.6, dur); d.pulse("ParamBrowRY", 0.6, dur);
        d.pulse("ParamAngleY", 14 * big, dur); d.pulse("ParamArmLA", 1, dur); d.pulse("ParamArmRA", 1, dur);
        this._motion("TapBody");
      } else if (emotion === "angry") {
        d.pulse("ParamBrowLAngle", -1, dur); d.pulse("ParamBrowRAngle", -1, dur);
        d.pulse("ParamBrowLY", -0.8, dur); d.pulse("ParamBrowRY", -0.8, dur);
        d.pulse("ParamMouthForm", -1, dur); d.pulse("ParamMouthOpenY", 0.5, dur);
        d.pulse("ParamAngleY", -6, dur); d.pulse("ParamAngleX", 8, dur);
      } else if (emotion === "surprise") {
        d.pulse("ParamBrowLY", 1, dur); d.pulse("ParamBrowRY", 1, dur);
        d.pulse("ParamMouthOpenY", 0.85, dur); d.pulse("ParamAngleY", 8, dur);
      } else if (act === "facepalm") {
        d.pulse("ParamAngleY", -14, dur); d.pulse("ParamAngleZ", -6, dur);
        d.pulse("ParamEyeLOpen", 0.2, 600); d.pulse("ParamEyeROpen", 0.2, 600);
        d.pulse("ParamHandL", 1, dur); d.pulse("ParamArmLA", 0.7, dur);
      } else if (act === "think") {
        d.pulse("ParamAngleZ", 9, dur); d.pulse("ParamEyeBallY", 0.6, dur);
        d.pulse("ParamHandR", 0.8, dur); d.pulse("ParamArmRA", 0.5, dur);
      } else if (act === "wave") {
        d.pulse("ParamArmRA", 1, dur); d.pulse("ParamHandR", 1, dur);
        d.pulse("ParamMouthForm", 0.6, dur); d.pulse("ParamEyeLSmile", 0.6, dur); d.pulse("ParamEyeRSmile", 0.6, dur);
      } else if (act === "point" || act === "kick") {
        d.pulse("ParamArmRA", 0.8, dur); d.pulse("ParamAngleX", 10, dur);
        d.pulse("ParamMouthOpenY", 0.4, dur);
      } else {
        // calm/idle:淡淡微笑
        d.pulse("ParamMouthForm", 0.3, dur);
      }
      if (plan.visibility) this.setVisibility(plan.visibility);
    }

    _neutralFace() {
      ["ParamArmLA", "ParamArmRA", "ParamHandL", "ParamHandR", "ParamBrowLAngle", "ParamBrowRAngle",
       "ParamEyeLSmile", "ParamEyeRSmile", "ParamMouthForm"].forEach((id) => {
        clearTimeout(this.driver["_t_" + id]);
        delete this.driver.targets[id];
      });
    }

    _motion(group) {
      try { this.model.motion(group); } catch (_) {}
    }

    destroy() {
      try { this.app && this.app.destroy(true); } catch (_) {}
      this.ready = false;
    }
  }

  window.Live2DRuntime = Live2DRuntime;
})();
