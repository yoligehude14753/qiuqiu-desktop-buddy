// 球球 · 桌面电脑搭子 渲染层(纯本地 + Kimi 云 API,用户自带 Key)
let hasKey = false;

// ---- 设置(本地持久化) ----
const DEFAULTS = { interval: 3000, vol: 90, mute: false, auto: true, speak: true, team: "default", runtime: "sprite", visionProvider: "qwen3", persona: "beijing" };
let cfg = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("kanqiu_cfg") || "{}"));
if (cfg.runtime === "rig") cfg.runtime = "sprite"; // 移除惊悚的骨骼切块版
function saveCfg() { localStorage.setItem("kanqiu_cfg", JSON.stringify(cfg)); }
// 默认看屏走 Qwen3-VL(免 Key);只有切到 Kimi K2.6 才需要用户 Key。
function needsKey() { return cfg.visionProvider === "k2.6"; }
function petLog(s) { try { window.pet.log && window.pet.log(String(s)); } catch (_) {} }

let running = false, busy = false, timer = null;
const player = document.getElementById("player");
const bubble = document.getElementById("bubble");
const btext = document.getElementById("btext");
const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle");
const charEl = document.getElementById("char");
const ballEl = document.getElementById("ball");

// 日常造型(电脑搭子默认)与世界杯看球造型(仅 sports 场景启用)
const DAILY = { calm: "models/buddy_calm.png", hype: "models/buddy_calm.png", angry: "models/buddy_calm.png",
                facepalm: "models/buddy_calm.png", point: "models/buddy_calm.png", think: "models/buddy_calm.png" };
const SOCCER = { calm: "models/fan_calm.png", hype: "models/fan_hype.png", angry: "models/fan_angry.png",
                 facepalm: "models/fan_facepalm.png", point: "models/fan_point.png", think: "models/fan_think.png" };
const TEAMS = {
  default:   { name: "", ...DAILY },
  argentina: { name: "阿根廷", calm: "models/team_argentina.png" },
  brazil:    { name: "巴西",   calm: "models/team_brazil.png" },
};
let curTeam = cfg.team || "default";
let soccerMode = false; // 仅在检测到球赛画面时切换为看球造型

// 智能动作 act → 用哪张图 + 配什么动效
const ACT_MAP = {
  cheer:    { pose: "hype",   fx: "jump" },
  kick:     { pose: "point",  fx: "kick" },
  clap:     { pose: "hype",   fx: "bounce" },
  point:    { pose: "point",  fx: "lean" },
  facepalm: { pose: "facepalm", fx: "shake" },
  think:    { pose: "think",  fx: "" },
  wave:     { pose: "point",  fx: "wave" },
  idle:     { pose: "calm",   fx: "" },
};
function poseImg(pose) {
  // 只有真在看球(soccerMode)才换足球/球队造型;其余一律日常造型(写代码时不该穿球衣)。
  if (!soccerMode) return DAILY[pose] || DAILY.calm;
  if (curTeam !== "default" && TEAMS[curTeam]) { const t = TEAMS[curTeam]; return t[pose] || t.calm; }
  return SOCCER[pose] || SOCCER.calm;
}

let expireTimer = null;
function react(emotion, act) {
  const m = ACT_MAP[act] || ACT_MAP.idle;
  const src = poseImg(m.pose);
  if (!charEl.src.endsWith(src)) charEl.src = src;
  // 动效
  charEl.classList.remove("jump", "bounce", "lean", "wave");
  void charEl.offsetWidth;
  if (m.fx === "jump") { charEl.classList.add("jump"); kickBall(); celebrateGoal(); }
  else if (m.fx === "kick") kickBall();
  else if (m.fx === "shake") shakeBall();
  else if (m.fx === "bounce") charEl.classList.add("bounce");
  else if (m.fx === "lean") charEl.classList.add("lean");
  else if (m.fx === "wave") charEl.classList.add("wave");
  if (emotion === "hype") celebrateGoal();
  // 几秒后回到平静待机
  clearTimeout(expireTimer);
  expireTimer = setTimeout(() => { charEl.src = poseImg("calm"); }, 7000);
}

// ===== 可插拔动作运行时:sprite(日常静图) / live2d(骨骼动作版) =====
let live2d = null;          // Live2DRuntime 实例
let live2dReady = false;
const charwrapEl = document.getElementById("charwrap");
const live2dCanvas = document.getElementById("live2d");

async function ensureLive2D() {
  if (live2dReady) return true;
  if (!window.Live2DRuntime) return false;
  try {
    live2d = new window.Live2DRuntime();
    await live2d.init(live2dCanvas, "models/Hiyori/Hiyori.model3.json");
    live2dReady = true;
    return true;
  } catch (e) { console.error("Live2D 加载失败", e); return false; }
}

let rig = null, rigReady = false;
async function ensureRig() {
  if (rigReady) return true;
  if (!window.RigRuntime) return false;
  try {
    rig = new window.RigRuntime("rig");
    await rig.init(document.getElementById("stage"));
    rigReady = true;
    return true;
  } catch (e) { console.error("Rig 加载失败", e); return false; }
}

async function setRuntime(mode) {
  cfg.runtime = mode; saveCfg();
  // 先全部隐藏
  charwrapEl.style.display = "none";
  live2dCanvas.style.display = "none";
  if (rig && rig.root) rig.root.style.display = "none";

  if (mode === "live2d") {
    const ok = await ensureLive2D();
    if (!ok) { cfg.runtime = "sprite"; saveCfg(); charwrapEl.style.display = "flex"; return; }
    live2dCanvas.style.display = "block";
  } else if (mode === "rig") {
    const ok = await ensureRig();
    if (!ok) { cfg.runtime = "sprite"; saveCfg(); charwrapEl.style.display = "flex"; return; }
    if (rig && rig.root) rig.root.style.display = "block";
  } else {
    charwrapEl.style.display = "flex";
  }
}

// 结构化动作计划解释器：由 K2.6 输出 motion plan，前端连续执行。
// plan 示例：
// { emotion, act, intensity, duration_ms, visibility, motion:{ body, ball, effect } }
function executeMotion(plan = {}) {
  const motion = plan.motion || {};
  const I = Math.max(0.2, Math.min(1, Number(plan.intensity ?? 0.5)));
  // 内部实验版:纸偶部件动 + 保留足球/彩纸/GOAL
  if (cfg.runtime === "rig" && rigReady && rig) {
    rig.execute(plan);
    runBallMotion(motion.ball || "idle", I, Number(plan.duration_ms ?? 1600));
    runEffect(motion.effect || (plan.emotion === "hype" ? "goal" : "none"), I);
    return;
  }
  // Live2D 版
  if (cfg.runtime === "live2d" && live2dReady && live2d) {
    live2d.execute(plan);
    runBallMotion(motion.ball || "idle", I, Number(plan.duration_ms ?? 1600));
    runEffect(motion.effect || (plan.emotion === "hype" ? "goal" : "none"), I);
    return;
  }
  return executeSprite(plan);
}

function executeSprite(plan = {}) {
  const emotion = plan.emotion || "calm";
  const act = plan.act || "idle";
  const intensity = Math.max(0, Math.min(1, Number(plan.intensity ?? 0.5)));
  const duration = Math.max(500, Math.min(8000, Number(plan.duration_ms ?? 1600)));
  const motion = plan.motion || {};

  // 先应用显隐，再执行动作
  if (plan.visibility) applyVisibility(plan.visibility);

  const pose = (
    act === "facepalm" ? "facepalm" :
    act === "point" || motion.body === "lean" ? "point" :
    act === "think" || motion.body === "sway" ? "think" :
    emotion === "hype" || act === "cheer" || act === "clap" ? "hype" :
    emotion === "angry" ? "angry" :
    "calm"
  );
  const src = poseImg(pose);
  if (!charEl.src.endsWith(src)) charEl.src = src;

  runBodyMotion(motion.body || ACT_MAP[act]?.fx || "idle", intensity, duration);
  runBallMotion(motion.ball || "idle", intensity, duration);
  runEffect(motion.effect || (emotion === "hype" ? "goal" : "none"), intensity);

  clearTimeout(expireTimer);
  expireTimer = setTimeout(() => { charEl.src = poseImg("calm"); }, Math.max(duration, 4500));
}

// 显隐:永远保持清晰可见、可点(不再淡到几乎透明导致找不到/点不到)。
// 工作专注时只是"安静缩在角落",而不是消失。
function applyVisibility(v) {
  const charLayer = document.getElementById("charwrap");
  const stage = document.getElementById("stage");
  stage.style.transition = "opacity .45s";
  // 角色立绘所在层做"安静缩小",但整窗(含按钮/球标)保持可见可点
  let charOpacity = 1, scale = 1;
  if (v === "hide" || v === "dim") { charOpacity = 0.78; scale = 0.9; }
  stage.style.opacity = "1";
  if (charLayer) {
    charLayer.style.transition = "opacity .45s, transform .45s";
    charLayer.style.opacity = String(charOpacity);
    charLayer.style.transform = `translateX(-50%) scale(${scale})`;
  }
  if (cfg.runtime === "rig" && rigReady && rig) rig.setVisibility(charOpacity < 1 ? "dim" : "show");
  if (cfg.runtime === "live2d" && live2dReady && live2d) live2d.setVisibility(charOpacity < 1 ? "dim" : "show");
}

function runBodyMotion(kind, intensity, duration) {
  charEl.classList.remove("jump", "bounce", "lean", "wave");
  const amp = 1 + intensity * 0.45;
  const ms = duration;
  if (kind === "jump") {
    charEl.animate([
      { transform: "translateY(0) rotate(0) scale(1)" },
      { transform: `translateY(${-34 * amp}px) rotate(${-4 * amp}deg) scale(${1 + 0.06 * amp})` },
      { transform: `translateY(${-8 * amp}px) rotate(${2 * amp}deg) scale(1.02)` },
      { transform: "translateY(0) rotate(0) scale(1)" },
    ], { duration: ms, easing: "cubic-bezier(.25,1.35,.45,1)" });
  } else if (kind === "bounce") {
    charEl.animate([
      { transform: "translateY(0) scale(1)" },
      { transform: `translateY(${-16 * amp}px) scale(${1 + 0.035 * amp})` },
      { transform: "translateY(0) scale(1)" },
    ], { duration: Math.min(ms, 900), iterations: 2, easing: "ease-out" });
  } else if (kind === "lean") {
    charEl.animate([
      { transform: "rotate(0) translateX(0)" },
      { transform: `rotate(${-7 * amp}deg) translateX(${-8 * amp}px)` },
      { transform: "rotate(0) translateX(0)" },
    ], { duration: ms, easing: "ease-in-out" });
  } else if (kind === "shake") {
    charEl.animate([
      { transform: "translateX(0)" },
      { transform: `translateX(${-10 * amp}px) rotate(${-2 * amp}deg)` },
      { transform: `translateX(${10 * amp}px) rotate(${2 * amp}deg)` },
      { transform: "translateX(0)" },
    ], { duration: Math.min(ms, 700), iterations: 2 });
  } else if (kind === "sway") {
    charEl.animate([
      { transform: "rotate(0)" },
      { transform: `rotate(${3 * amp}deg)` },
      { transform: `rotate(${-3 * amp}deg)` },
      { transform: "rotate(0)" },
    ], { duration: ms, easing: "ease-in-out" });
  }
}

function runBallMotion(kind, intensity, duration) {
  const amp = 1 + intensity * 0.7;
  if (kind === "kick") {
    ballEl.animate([
      { transform: "translate(0,0) rotate(0) scale(1)" },
      { transform: `translate(${70 * amp}px,${-105 * amp}px) rotate(${360 * amp}deg) scale(${1.15 + intensity * .25})` },
      { transform: "translate(0,0) rotate(720deg) scale(1)" },
    ], { duration: Math.max(650, duration * .55), easing: "ease-out" });
  } else if (kind === "shake") {
    shakeBall();
  }
}

function runEffect(effect, intensity) {
  // GOAL!!! / 彩纸只在真看球时放,别在写代码刷网页时乱蹦
  if (effect === "goal") { if (soccerMode) celebrateGoal(); }
  else if (effect === "confetti" && soccerMode) spawnConfetti(Math.round(12 + intensity * 22));
}

let ballSpin = 0;
function ballIdle() { ballSpin += 1.2; ballEl.style.transform = `translateY(${Math.sin(Date.now()/600)*5}px) rotate(${ballSpin}deg)`; requestAnimationFrame(ballIdle); }
function kickBall() { ballEl.animate([{transform:"translateY(0) rotate(0)"},{transform:"translateY(-90px) rotate(360deg) scale(1.3)"},{transform:"translateY(0) rotate(720deg)"}],{duration:800,easing:"ease-out"}); }
function shakeBall() { ballEl.animate([{transform:"translateX(0)"},{transform:"translateX(-8px)"},{transform:"translateX(8px)"},{transform:"translateX(0)"}],{duration:400}); }

function celebrateGoal() {
  const goal = document.getElementById("goal");
  goal.style.display = "flex"; spawnConfetti(30);
  clearTimeout(celebrateGoal._t); celebrateGoal._t = setTimeout(() => goal.style.display = "none", 2200);
}
function spawnConfetti(n) {
  const colors = ["#c1121f","#2ea043","#ffd24a","#1f6feb","#ffffff"];
  for (let i=0;i<n;i++){const c=document.createElement("div");c.className="confetti";c.style.left=Math.random()*100+"%";c.style.background=colors[i%colors.length];c.style.borderRadius=Math.random()>.5?"50%":"0";document.getElementById("stage").appendChild(c);c.animate([{transform:"translateY(0) rotate(0)",opacity:1},{transform:`translateY(${360+Math.random()*120}px) rotate(${Math.random()*720}deg)`,opacity:0}],{duration:1600+Math.random()*800,easing:"ease-in"}).onfinish=()=>c.remove();}
}

// 说话:系统语音(免费免配置),配合数字人口型/弹跳。
let zhVoice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  zhVoice = vs.find(v => /zh|Chinese|Ting|Mei|Sin|Yu/i.test(v.lang + v.name)) || vs[0] || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

let mouthRAF = null;
function startTalk() {
  charEl.classList.add("talking");
  if (cfg.runtime === "live2d" && live2dReady && live2d) {
    live2d.talk(true);
    let p = 0;
    const loop = () => { p += 0.4; live2d.setMouthOpen((Math.sin(p) * 0.5 + 0.5) * 0.8); mouthRAF = requestAnimationFrame(loop); };
    loop();
  }
}
function stopTalk() {
  charEl.classList.remove("talking");
  if (mouthRAF) cancelAnimationFrame(mouthRAF);
  if (live2d) live2d.talk(false);
}
function speak(text) {
  if (!text) return false;
  if (!cfg.speak || cfg.mute) { statusEl.textContent = "语音关闭"; return false; }
  if (!window.speechSynthesis) { statusEl.textContent = "无系统语音"; return false; }
  try {
    pickVoice();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (zhVoice) u.voice = zhVoice;
    u.lang = "zh-CN"; u.rate = 1.05; u.pitch = 1.1; u.volume = cfg.vol / 100;
    u.onstart = startTalk; u.onend = stopTalk;
    u.onerror = () => { stopTalk(); statusEl.textContent = "语音失败"; };
    speechSynthesis.speak(u);
    return true;
  } catch (_) { statusEl.textContent = "语音失败"; return false; }
}

// 播放服务端随解说一起返回的 CosyVoice 音频(北京腔同款);失败/无音频回退系统语音。
function say(text, audio) {
  if (!cfg.speak || cfg.mute) { statusEl.textContent = "语音关闭"; return false; }
  if (audio && player) {
    try {
      if (window.speechSynthesis) speechSynthesis.cancel();
      player.pause();
      player.src = audio;
      player.volume = cfg.vol / 100;
      player.onplay = startTalk;
      player.onended = stopTalk;
      player.onerror = () => { stopTalk(); speak(text); };
      player.play().catch(() => speak(text));
      return true;
    } catch (_) { return speak(text); }
  }
  return speak(text);
}

// 最近解说历史(给 Kimi 去重)
const speakHistory = [];
function pushHistory(t, emotion) {
  speakHistory.push(t); if (speakHistory.length > 6) speakHistory.shift();
  STATS.comments = (STATS.comments || 0) + 1;
  if (emotion === "hype") STATS.goals = (STATS.goals || 0) + 1;
  saveStats();
  LOCALHIST.push({ ts: Date.now(), comment: t, emotion: emotion || "calm", team: TEAMS[curTeam].name });
  if (LOCALHIST.length > 60) LOCALHIST.shift();
  saveHist();
}

function showBubble(text) {
  btext.textContent = text; bubble.classList.add("show");
  clearTimeout(showBubble._t); showBubble._t = setTimeout(() => bubble.classList.remove("show"), 8000);
}

// 看屏节奏(ms):对齐 6/7 网页版——统一用用户设置的间隔(默认5s,可选3/5/8s),球赛加紧到 3s。
let curScene = "browse";
const STATE = { sessionStart: Date.now(), lastScene: null };
let lastSpokeAt = 0, loopTimer = null;

function applyStealth(scene) {
  curScene = scene;
  // 只有真在看球才切看球造型;其它一律日常电脑搭子(不再按场景静默/淡化)
  const wantSoccer = (scene === "sports");
  if (wantSoccer !== soccerMode) { soccerMode = wantSoccer; if (charEl) charEl.src = poseImg("calm"); }
  ballEl.style.display = soccerMode ? "block" : "none";
  applyVisibility("show");
}

function scheduleNext(scene) {
  clearTimeout(loopTimer);
  if (!running) return;
  const ms = scene === "sports" ? Math.min(cfg.interval, 3000) : cfg.interval;
  loopTimer = setTimeout(tick, ms);
}

// 防重复:新这句和最近几句太像就先不说(等画面出新内容再说),避免刷同一句。
function _normC(s) { return String(s || "").replace(/[\s，。！!,.~、…?？:：;；"'"']+/g, "").trim(); }
function _bigrams(s) { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; }
// 两句是否共享 ≥n 字连续片段(逮"口癖":同一比喻/同一词组反复出现)
function _sharedPhrase(a, b, n) {
  if (a.length < n || b.length < n) return false;
  const grams = new Set();
  for (let i = 0; i + n <= a.length; i++) grams.add(a.slice(i, i + n));
  for (let i = 0; i + n <= b.length; i++) if (grams.has(b.slice(i, i + n))) return true;
  return false;
}
function isNearDup(comment) {
  const c = _normC(comment); if (!c) return true;
  for (const h of speakHistory.slice(-6)) {
    const x = _normC(h); if (!x) continue;
    if (x === c) return true;
    const a = x.length <= c.length ? x : c, b = x.length <= c.length ? c : x;
    if (a.length >= 5 && b.includes(a)) return true;
    if (_sharedPhrase(x, c, 5)) return true; // 共享5字以上口癖片段 → 视为重复
    const ga = _bigrams(x), gb = _bigrams(c); let inter = 0; ga.forEach(g => { if (gb.has(g)) inter++; });
    const uni = ga.size + gb.size - inter;
    if (uni > 0 && inter / uni > 0.52) return true; // 换个说法重复同一意思也挡住
  }
  // 开头口癖:和最近3句中任意一句开头2个字相同 → 视为重复(逮"老铁…/老铁…""瞅见…/瞅见…"这种)
  for (const h of speakHistory.slice(-3)) {
    const x = _normC(h);
    if (x && c.slice(0, 2) === x.slice(0, 2)) return true;
  }
  return false;
}

// 核心循环:看屏 → 理解 → 反馈。说什么只来自当前画面;没新内容/重复就只动不说,绝不主动唠废话。
// 节奏保障:启动第一帧必开口(打照面+点评正在做的事);静默超 55s 这帧提示模型开口唠一句。
const NUDGE_SILENCE_MS = 55000;
let firstTickPending = false;
const rejectedDrafts = []; // 被去重拦掉的草稿,传回模型避免它反复起草同一句
async function tick() {
  if (busy || !running) return;
  busy = true;
  let scene = curScene, reschedule = true;
  const t0 = Date.now();
  try {
    statusEl.textContent = "👀";
    if (needsKey() && !hasKey) { openKeyPanel(); reschedule = false; return; }
    const img = await window.pet.captureScreen();
    if (!img) { return; }
    const first = firstTickPending;
    const nudge = !first && (Date.now() - lastSpokeAt) > NUDGE_SILENCE_MS;
    // history = 已说过的 + 被拦掉的废稿(让模型别再起草同一句)
    const histAll = speakHistory.concat(rejectedDrafts).slice(-8);
    const resp = await window.pet.commentate({ image: img, homeTeam: TEAMS[curTeam].name, history: histAll, provider: cfg.visionProvider, first, nudge, persona: cfg.persona });
    if (resp.error) {
      statusEl.textContent = resp.error === "no_key" ? "未配置Key" : "✕";
      if (resp.error === "no_key") { openKeyPanel(); reschedule = false; }
      return;
    }
    firstTickPending = false;
    const plan = resp.plan || {};
    scene = plan.scene || "browse";
    STATE.lastScene = scene;
    applyStealth(scene);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    statusEl.textContent = `${plan.activity || scene} ${dt}s`;
    petLog(`act=${plan.activity || scene} say=${plan.say}${first ? " first" : ""}${nudge ? " nudge" : ""} ${dt}s seen="${(plan.seen || "").slice(0, 36)}" comment="${(plan.comment || "").slice(0, 40)}"`);

    if (!plan.say || !plan.comment) { executeMotion(plan); return; }   // 该闭嘴(按场景密度) → 只动不出声
    // 去重:常规帧和最近6句比;first/nudge 帧放宽但仍挡"完全一样/共享口癖片段"
    const lastSaid = _normC(speakHistory[speakHistory.length - 1] || "");
    const dup = (first || nudge)
      ? (_normC(plan.comment) === lastSaid || _sharedPhrase(_normC(plan.comment), lastSaid, 5))
      : isNearDup(plan.comment);
    if (dup) {
      petLog("skip dup");
      // 关键:被拦的句子也记入"别重复"列表,否则模型不知道这句已废,会永远重新起草同一句
      rejectedDrafts.push(plan.comment);
      if (rejectedDrafts.length > 4) rejectedDrafts.shift();
      // 动态场景(球赛/视频/游戏)沉默时也给个可见的小动作,别像死机
      if (["sports", "video", "game"].includes(scene)) {
        const a = ["bounce", "lean", "sway"][Math.floor(Math.random() * 3)];
        executeMotion({ emotion: plan.emotion || "calm", act: plan.act, intensity: 0.45, duration_ms: 1200, motion: { body: a, ball: soccerMode ? "kick" : "idle", effect: "none" } });
      } else executeMotion(plan);
      return;
    }
    rejectedDrafts.length = 0; // 说出新句子后清空废稿列表
    lastSpokeAt = Date.now();
    pushHistory(plan.comment, plan.emotion);
    showBubble(plan.comment);            // 气泡秒出
    executeMotion(plan);                 // 配动作/表情
    say(plan.comment, resp.audio);       // CosyVoice 北京腔(声画同到),失败回退系统语音
  } catch (e) { statusEl.textContent = "✕"; petLog(`tick err: ${e && e.message}`); console.error(e); }
  finally { busy = false; if (reschedule && running) scheduleNext(scene); }
}

let idleTimer = null;
async function startWatching() {
  if (needsKey() && !hasKey) { statusEl.textContent = "未配置Key"; openKeyPanel(); return; }
  running = true;
  STATE.sessionStart = Date.now(); STATE.lastScene = null;
  lastSpokeAt = Date.now(); firstTickPending = true; // 第一帧必开口打照面
  STATS.sessions = (STATS.sessions || 0) + 1; saveStats();
  toggleBtn.textContent = "❚❚"; toggleBtn.className = "btn pause";
  clearTimeout(loopTimer); tick();
  clearInterval(idleTimer); idleTimer = setInterval(idleMicroMotion, 11000); // 仅非语言微动作,保持"活"
  statusEl.textContent = "陪看中";
}
function stopWatching() {
  running = false;
  toggleBtn.textContent = "▶"; toggleBtn.className = "btn play";
  clearTimeout(loopTimer); clearInterval(idleTimer);
  flushWatchTime();
  statusEl.textContent = "暂停";
}
async function autoStart() {
  statusEl.textContent = "待命";
  try { const c = await window.pet.getConfig(); hasKey = !!c.hasKey; } catch (_) { hasKey = false; }
  if (needsKey() && !hasKey) { openKeyPanel(); return; }
  if (cfg.auto) setTimeout(() => startWatching(), 700);
}

// ---- 面板:设置 / 历史统计 ----
function openPanel(id) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("show"));
  document.getElementById(id).classList.add("show");
}
document.querySelectorAll("[data-close]").forEach(x => x.onclick = () => document.getElementById(x.dataset.close).classList.remove("show"));

function setKeyStatus(text, ok) {
  const el = document.getElementById("keyStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "#2ea043" : "#f0883e";
}

async function refreshKeyUI() {
  try {
    const c = await window.pet.getConfig();
    hasKey = !!c.hasKey;
    const input = document.getElementById("kimiKey");
    if (input && c.kimiKey && !input.value) input.value = c.kimiKey;
    setKeyStatus(hasKey ? "已保存" : "未配置", hasKey);
  } catch (_) {
    hasKey = false;
    setKeyStatus("读取失败", false);
  }
}

function openKeyPanel() {
  openPanel("settingsPanel");
  setKeyStatus("请先保存 Key，再点绿色播放", false);
  setTimeout(() => document.getElementById("kimiKey")?.focus(), 50);
  showBubble("先填 Kimi Key，再点绿色播放。");
}

document.getElementById("settingsBtn").onclick = () => openPanel("settingsPanel");
document.getElementById("histBtn").onclick = async () => {
  openPanel("histPanel"); await loadStats(); await loadHistory();
};
document.getElementById("passBtn").onclick = () => window.pet.toggleClickThrough();

// ---- 本地统计/历史(localStorage) ----
let STATS = Object.assign({ sessions: 0, comments: 0, goals: 0, watchMs: 0 },
  JSON.parse(localStorage.getItem("kanqiu_stats") || "{}"));
function saveStats() { localStorage.setItem("kanqiu_stats", JSON.stringify(STATS)); }
let LOCALHIST = JSON.parse(localStorage.getItem("kanqiu_hist") || "[]");
function saveHist() { localStorage.setItem("kanqiu_hist", JSON.stringify(LOCALHIST.slice(-60))); }
function flushWatchTime() {
  if (STATE.sessionStart) { STATS.watchMs += Date.now() - STATE.sessionStart; STATE.sessionStart = Date.now(); saveStats(); }
}

function loadStats() {
  const mins = Math.round((STATS.watchMs || 0) / 60000);
  document.getElementById("statGrid").innerHTML =
    card(mins + "′", "陪伴时长") + card(STATS.comments || 0, "互动条数") +
    card(STATS.goals || 0, "精彩时刻") + card(STATS.sessions || 0, "启动次数");
}
function card(v, k) { return `<div class="stat-card"><div class="v">${v}</div><div class="k">${k}</div></div>`; }
function loadHistory() {
  const emo = { hype:"🔥", angry:"😤", surprise:"😮", calm:"💬", focus:"🤫" };
  document.getElementById("histList").innerHTML = LOCALHIST.slice().reverse().slice(0, 30).map(it =>
    `<div class="item"><div class="t">${new Date(it.ts).toLocaleTimeString()} ${it.team||""}</div>${emo[it.emotion]||"💬"} ${it.comment}</div>`).join("");
}

// ---- 设置面板交互 ----
function syncSettingsUI() {
  document.querySelectorAll("#intervalSeg button").forEach(b => b.classList.toggle("on", +b.dataset.v === cfg.interval));
  document.getElementById("vol").value = cfg.vol;
  document.getElementById("mute").checked = cfg.mute;
  document.getElementById("auto").checked = cfg.auto;
  document.getElementById("speak").checked = cfg.speak;
  document.getElementById("team").value = curTeam;
  document.querySelectorAll("#runtimeSeg button").forEach(b => b.classList.toggle("on", b.dataset.v === cfg.runtime));
  const vp = document.getElementById("visionProvider"); if (vp) vp.value = cfg.visionProvider;
  const ps = document.getElementById("persona"); if (ps) ps.value = cfg.persona;
}
document.getElementById("persona")?.addEventListener("change", (e) => {
  cfg.persona = e.target.value; saveCfg();
  const names = { beijing: "得嘞,北京老炮儿伺候着!", shanghai: "灵额,阿拉上海爷叔来咧~", shandong: "中!俺山东大汉陪恁!", dongbei: "老铁放心,嘎嘎能唠!" };
  showBubble(names[cfg.persona] || "人设换好了!");
});
document.querySelectorAll("#runtimeSeg button").forEach(b => b.onclick = async () => {
  await setRuntime(b.dataset.v); syncSettingsUI();
  showBubble(cfg.runtime === "live2d" ? "换上会动的我啦~" : "回到日常造型。");
});
document.querySelectorAll("#intervalSeg button").forEach(b => b.onclick = () => {
  cfg.interval = +b.dataset.v; saveCfg(); syncSettingsUI();
  if (running) { clearInterval(timer); timer = setInterval(tick, cfg.interval); }
});
document.getElementById("vol").oninput = (e) => { cfg.vol = +e.target.value; player.volume = cfg.vol/100; saveCfg(); };
document.getElementById("mute").onchange = (e) => { cfg.mute = e.target.checked; saveCfg(); };
document.getElementById("auto").onchange = (e) => { cfg.auto = e.target.checked; saveCfg(); };
document.getElementById("speak").onchange = (e) => { cfg.speak = e.target.checked; saveCfg(); };
document.getElementById("voiceTest").onclick = () => {
  cfg.speak = true;
  cfg.mute = false;
  saveCfg();
  syncSettingsUI();
  showBubble("试一下，我现在能说话吗？");
  const ok = speak("试一下，我现在能说话吗？");
  statusEl.textContent = ok ? "试音中" : statusEl.textContent;
};
document.getElementById("saveKey").onclick = async () => {
  const key = document.getElementById("kimiKey").value.trim();
  if (!key) { hasKey = false; await window.pet.setConfig({ kimiKey: "" }); setKeyStatus("未配置", false); return; }
  const r = await window.pet.setConfig({ kimiKey: key });
  hasKey = !!r.hasKey;
  setKeyStatus(hasKey ? "已保存" : "保存失败", hasKey);
  if (hasKey) showBubble("Key 已保存，可以开始陪你了。");
};
document.getElementById("testKey").onclick = async () => {
  const provider = cfg.visionProvider;
  const key = document.getElementById("kimiKey").value.trim();
  if (provider === "k2.6" && !key) { setKeyStatus("K2.6 需先填 Key", false); return; }
  setKeyStatus("测试中...", true);
  const r = await window.pet.testKey({ provider, key });
  setKeyStatus(r.ok ? "测试通过" : "测试失败", !!r.ok);
  if (!r.ok) showBubble("连不上看屏模型，检查 Key 或网络。");
};
document.getElementById("visionProvider")?.addEventListener("change", (e) => {
  cfg.visionProvider = e.target.value; saveCfg();
  setKeyStatus(needsKey() ? (hasKey ? "已保存" : "K2.6 需填 Key") : "Qwen3 免 Key", needsKey() ? hasKey : true);
  showBubble(needsKey() ? "切到 Kimi K2.6,得填你的 Key。" : "切回 Qwen3,免 Key 开箱即用。");
});

// 闲置微动作:安静时偶尔做个非语言小动作(看一眼/想想),让形象"活"一点。
// 不说话、不主动唠嗑、没有开场白——发声只来自看屏 tick。
const IDLE_ACTS = ["think", "wave", "point", "idle"];
function idleMicroMotion() {
  if (!running || busy) return;
  if (Date.now() - lastSpokeAt < 15000) return; // 刚说过话不抢戏
  if (Math.random() < 0.45) {
    const a = IDLE_ACTS[Math.floor(Math.random() * IDLE_ACTS.length)];
    executeMotion({ emotion: "calm", act: a, intensity: 0.25, duration_ms: 1200, motion: { body: a === "think" ? "sway" : "idle", ball: "idle", effect: "none" } });
  }
}

toggleBtn.onclick = () => { running ? stopWatching() : startWatching(); };
window.pet.onToggleRunning(() => { running ? stopWatching() : startWatching(); });
window.pet.onClickThroughChanged((enabled) => {
  document.getElementById("passBtn").style.background = enabled ? "#1f6feb" : "rgba(0,0,0,.55)";
  showBubble(enabled ? "我先不挡你鼠标啦，Cmd+Shift+K 叫我回来。" : "得嘞，我又能点了。");
});
// 召回:强制恢复完全可见
window.pet.onRecalled && window.pet.onRecalled(() => {
  applyVisibility("show");
  document.getElementById("stage").style.opacity = "1";
  showBubble("我在这儿！");
});
document.getElementById("close").onclick = () => { flushWatchTime(); window.pet.quit(); };
document.getElementById("team").onchange = (e) => {
  curTeam = e.target.value; cfg.team = curTeam; saveCfg();
  charEl.src = poseImg("calm");
  const nm = TEAMS[curTeam].name;
  showBubble(nm ? `好嘞，看球时我就给${nm}应援！` : "切回日常啦~");
};

// 启动
syncSettingsUI();
refreshKeyUI();
ballEl.style.display = "none";
ballIdle();
if (cfg.runtime === "rig" || cfg.runtime === "live2d") setRuntime(cfg.runtime);
autoStart();
