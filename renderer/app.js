// 球球 · 桌面电脑搭子 渲染层(纯本地 + Kimi 云 API,用户自带 Key)
let hasKey = false;

// ---- 设置(本地持久化) ----
const DEFAULTS = { interval: 5000, vol: 90, mute: false, auto: true, speak: true, team: "default", runtime: "sprite" };
let cfg = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("kanqiu_cfg") || "{}"));
if (cfg.runtime === "rig") cfg.runtime = "sprite"; // 移除惊悚的骨骼切块版
function saveCfg() { localStorage.setItem("kanqiu_cfg", JSON.stringify(cfg)); }

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
  // 默认队:日常造型;进入看球模式才换足球造型。其他国家队始终用队服。
  if (curTeam === "default") {
    const set = soccerMode ? SOCCER : DAILY;
    return set[pose] || set.calm;
  }
  const t = TEAMS[curTeam];
  return t[pose] || t.calm;
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
  if (effect === "goal") celebrateGoal();
  else if (effect === "confetti") spawnConfetti(Math.round(12 + intensity * 22));
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

// 各场景的看屏节奏(毫秒):工作时拉很长、少打扰;球赛最勤
const SCENE_INTERVAL = { sports: 5000, video: 9000, game: 9000, music: 18000, browse: 14000, chat: 16000, work: 25000, reading: 25000, idle: 18000 };
let curScene = "browse";
let stealthTimer = null;

function applyStealth(scene) {
  curScene = scene;
  // 世界杯特色:只有球赛画面才切看球造型;其余场景是日常电脑搭子
  const wantSoccer = (scene === "sports");
  if (wantSoccer !== soccerMode) {
    soccerMode = wantSoccer;
    if (charEl) charEl.src = poseImg("calm");
  }
  ballEl.style.display = soccerMode ? "block" : "none";
  // 高专注工作:进入"安静模式"——缩小、半透明,但始终清晰可见可点,不再消失。
  if (scene === "work" || scene === "reading") {
    applyVisibility("dim");
  } else {
    applyVisibility("show");
  }
}

function rescheduleByScene(scene) {
  const want = SCENE_INTERVAL[scene] || cfg.interval;
  // 用户设的间隔作为下限的参考,场景间隔优先(但不短于用户设的最小)
  const ms = Math.max(want, scene === "sports" ? cfg.interval : want);
  if (running) { clearInterval(timer); timer = setInterval(tick, ms); }
}

async function tick() {
  if (busy || !running) return;
  busy = true;
  try {
    statusEl.textContent = "👀";
    if (!hasKey) { busy = false; openKeyPanel(); return; }
    const img = await window.pet.captureScreen();
    if (!img) { busy = false; return; }
    const resp = await window.pet.commentate({ image: img, homeTeam: TEAMS[curTeam].name, history: speakHistory });
    if (resp.error) {
      statusEl.textContent = resp.error === "no_key" ? "未配置Key" : "✕";
      if (resp.error === "no_key") openKeyPanel();
      busy = false; return;
    }
    const plan = resp.plan || {};
    const d = { scene: plan.scene, skip: !plan.say, comment: plan.say ? plan.comment : "",
                emotion: plan.emotion, act: plan.act, motion: plan };
    const newScene = d.scene || "browse";
    onSceneChanged(AUTONOMY.lastScene, newScene);
    AUTONOMY.lastScene = newScene;
    applyStealth(newScene);
    rescheduleByScene(newScene);
    statusEl.textContent = (d.scene || "") + (d.timing ? " " + d.timing.total + "s" : "");

    if (d.skip || !d.comment) {
      // 该闭嘴:专注工作就保持隐身待机,不说话
      if (d.motion) executeMotion(d.motion);
      else if (d.scene !== "work" && d.scene !== "reading") react("calm", "idle");
      busy = false; return;
    }
    AUTONOMY.lastSpeak = Date.now();
    pushHistory(d.comment, d.emotion);
    showBubble(d.comment);
    executeMotion(d.motion || { emotion: d.emotion || "calm", act: d.act || "idle" });
    speak(d.comment);
  } catch (e) { statusEl.textContent = "✕"; console.error(e); }
  busy = false;
}

let autonomyTimer = null, idleTimer = null;
async function startWatching() {
  if (!hasKey) {
    statusEl.textContent = "未配置Key";
    openKeyPanel();
    return;
  }
  running = true;
  AUTONOMY.sessionStart = Date.now(); AUTONOMY.lastSpeak = Date.now(); AUTONOMY.lastScene = null;
  STATS.sessions = (STATS.sessions || 0) + 1; saveStats();
  toggleBtn.textContent = "❚❚"; toggleBtn.className = "btn pause";
  tick(); clearInterval(timer); timer = setInterval(tick, cfg.interval);
  clearInterval(autonomyTimer); autonomyTimer = setInterval(autonomyTick, 20000);
  clearInterval(idleTimer); idleTimer = setInterval(idleMicroMotion, 12000);
  statusEl.textContent = "陪看中";
}
function stopWatching() {
  running = false;
  toggleBtn.textContent = "▶"; toggleBtn.className = "btn play";
  clearInterval(timer); clearInterval(autonomyTimer); clearInterval(idleTimer);
  flushWatchTime();
  statusEl.textContent = "暂停";
}
async function autoStart() {
  statusEl.textContent = "待命";
  // 读取 Key 状态:没配则弹配置面板,不自动开始。
  try { const c = await window.pet.getConfig(); hasKey = !!c.hasKey; } catch (_) { hasKey = false; }
  if (!hasKey) { openKeyPanel(); return; }
  if (cfg.auto) setTimeout(() => startWatching(), 2500);
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
  if (AUTONOMY.sessionStart) { STATS.watchMs += Date.now() - AUTONOMY.sessionStart; AUTONOMY.sessionStart = Date.now(); saveStats(); }
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
}
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
  const key = document.getElementById("kimiKey").value.trim();
  if (!key) { setKeyStatus("请先填写 Key", false); return; }
  setKeyStatus("测试中...", true);
  const r = await window.pet.testKey(key);
  setKeyStatus(r.ok ? "测试通过" : "测试失败", !!r.ok);
  if (!r.ok) showBubble("Key 测试失败，检查一下是否填对。");
};

// ============ 自主行为引擎(融合 animo behavior-engine + Open-LLM-VTuber 主动说话)============
const AUTONOMY = {
  lastSpeak: Date.now(),       // 上次开口(主动或解说)
  sessionStart: Date.now(),    // 本次陪看开始
  lastScene: null,
  cooldowns: {},               // 各行为冷却到期时间
  // 行为定义:冷却(ms) + 触发判断 + 权重
  behaviors: [
    { id: "greeting", cd: 9e9,  weight: 1, // 仅启动/回到屏幕时
      can: () => false },
    { id: "fatigue",  cd: 25*60e3, weight: 3,
      can: (s) => (Date.now()-AUTONOMY.sessionStart) > 45*60e3 },
    { id: "night",    cd: 40*60e3, weight: 2,
      can: (s) => { const h=new Date().getHours(); return h>=1 && h<5; } },
    { id: "curiosity",cd: 6*60e3,  weight: 2,
      can: (s) => ["idle","browse","music"].includes(s) && (Date.now()-AUTONOMY.lastSpeak)>90e3 },
  ],
};

async function proactive(trigger) {
  if (!hasKey) return;
  try {
    const resp = await window.pet.proactive({ trigger, homeTeam: TEAMS[curTeam].name, history: speakHistory });
    if (resp.error) return;
    const plan = resp.plan || {};
    if (plan.comment) {
      AUTONOMY.lastSpeak = Date.now();
      pushHistory(plan.comment, plan.emotion);
      showBubble(plan.comment);
      executeMotion(plan);
      speak(plan.comment);
    }
  } catch (e) { console.error(e); }
}

// 行为调度器:每 20 秒挑一个可触发、已过冷却的行为
function autonomyTick() {
  if (!running || curScene === "work" || curScene === "reading") return;
  const now = Date.now();
  const ready = AUTONOMY.behaviors.filter(b =>
    b.can(curScene) && (AUTONOMY.cooldowns[b.id] || 0) < now);
  if (!ready.length) return;
  // 按权重随机
  const total = ready.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total, pick = ready[0];
  for (const b of ready) { r -= b.weight; if (r <= 0) { pick = b; break; } }
  AUTONOMY.cooldowns[pick.id] = now + pick.cd;
  proactive(pick.id);
}

// 场景切换感知:scene 变化时顺口搭话(work/reading 不打扰)
function onSceneChanged(prev, next) {
  if (!prev || prev === next) return;
  if (next === "work" || next === "reading" || next === "idle") return;
  if (Date.now() - AUTONOMY.lastSpeak < 30e3) return;
  proactive("scene_change", `从${prev}切到了${next}`);
}

// 闲置微动作:安静时偶尔做个小动作(看一眼/思考),更"活"
const IDLE_ACTS = ["think", "wave", "point", "idle"];
function idleMicroMotion() {
  if (!running || busy) return;
  if (Date.now() - AUTONOMY.lastSpeak < 20e3) return; // 刚说过话不抢戏
  if (curScene === "work" || curScene === "reading") return;
  if (Math.random() < 0.5) {
    const a = IDLE_ACTS[Math.floor(Math.random() * IDLE_ACTS.length)];
    executeMotion({ emotion: "calm", act: a, intensity: 0.25, duration_ms: 1200, visibility: "show", motion: { body: a === "think" ? "sway" : "idle", ball: "idle", effect: "none" } });
  }
}

// 回到屏幕欢迎
let wasHidden = false;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { wasHidden = true; }
  else if (wasHidden) { wasHidden = false; if (running) setTimeout(() => proactive("greeting"), 800); }
});

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
