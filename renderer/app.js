// 球球 · 桌面电脑搭子 渲染层(纯本地 + Kimi 云 API,用户自带 Key)
let hasKey = false;

// ---- 设置(本地持久化) ----
const DEFAULTS = {
  interval: 5000, vol: 90, mute: false, auto: true, speak: true, team: "default", runtime: "sprite",
  // 看屏模型:qwen3(默认,heyi 本地 VLM,无需 Key,快) / k2.6(云端 Kimi,需用户 Key)
  visionProvider: "qwen3",
  // 语音服务端点已内置(主进程 heyi CosyVoice),这里只留用户可选的音色/语速。
  ttsProvider: "cosyvoice", ttsVoice: "longxiaochun_v2", systemVoice: "", rate: 100, pitch: 105,
};
// k2.6 才需要用户填 Kimi Key;qwen3 默认走内置网关,开箱即用。
function needsKey() { return cfg.visionProvider === "k2.6"; }
let cfg = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("kanqiu_cfg") || "{}"));
if (cfg.runtime === "rig") cfg.runtime = "sprite"; // 移除惊悚的骨骼切块版
function saveCfg() { localStorage.setItem("kanqiu_cfg", JSON.stringify(cfg)); }

// 轻量日志:写到主进程 userData/buddy.log,便于排查"看屏频率/延迟/说了啥"。
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

// 说话:CosyVoice / 系统语音,配合数字人口型/弹跳。
let zhVoice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  zhVoice = vs.find(v => v.name === cfg.systemVoice) ||
            vs.find(v => /zh|Chinese|Ting|Mei|Sin|Yu/i.test(v.lang + v.name)) || vs[0] || null;
  renderVoiceOptions(vs);
}
function renderVoiceOptions(vs) {
  const sel = document.getElementById("voiceSelect");
  if (!sel || sel.dataset.ready === String(vs.length)) return;
  const current = cfg.systemVoice || "";
  sel.innerHTML = `<option value="">自动中文</option>` + vs.map(v =>
    `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} · ${escapeHtml(v.lang)}</option>`).join("");
  sel.value = current;
  sel.dataset.ready = String(vs.length);
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
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
}

function speakSystem(text) {
  if (!text) return false;
  if (!cfg.speak || cfg.mute) { statusEl.textContent = "语音关闭"; return false; }
  if (!window.speechSynthesis) { statusEl.textContent = "无系统语音"; return false; }
  try {
    pickVoice();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (zhVoice) u.voice = zhVoice;
    u.lang = "zh-CN"; u.rate = cfg.rate / 100; u.pitch = cfg.pitch / 100; u.volume = cfg.vol / 100;
    u.onstart = startTalk; u.onend = stopTalk;
    u.onerror = () => { stopTalk(); statusEl.textContent = "语音失败"; };
    speechSynthesis.speak(u);
    return true;
  } catch (_) { statusEl.textContent = "语音失败"; return false; }
}

async function speakCosyVoice(text) {
  if (!text) return false;
  if (!cfg.speak || cfg.mute) { statusEl.textContent = "语音关闭"; return false; }
  try {
    statusEl.textContent = "TTS";
    const resp = await window.pet.synthesizeSpeech({
      text, voice: cfg.ttsVoice, speed: cfg.rate / 100,
    });
    if (!resp.ok || !resp.dataUrl) throw new Error(resp.error || "TTS 失败");
    if (window.speechSynthesis) speechSynthesis.cancel();
    player.pause();
    player.src = resp.dataUrl;
    player.volume = cfg.vol / 100;
    player.onplay = startTalk;
    player.onended = stopTalk;
    player.onerror = () => { stopTalk(); statusEl.textContent = "音频播放失败"; };
    await player.play();
    return true;
  } catch (e) {
    console.warn("CosyVoice 失败,回退系统语音", e);
    statusEl.textContent = "TTS回退";
    return speakSystem(text);
  }
}

function speak(text) {
  return cfg.ttsProvider === "system" ? speakSystem(text) : speakCosyVoice(text);
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
// 看屏节奏(ms):看得勤,但"说不说"由 say 决定(没新内容就 say=false 不出声),所以勤看不等于话多。
const SCENE_INTERVAL = { sports: 2500, video: 5000, game: 5000, music: 10000, browse: 6000, chat: 7000, work: 9000, reading: 9000, idle: 10000 };

// 变化驱动:动态场景(看视频/球赛/游戏)持续给反馈;静态场景(工作/阅读/浏览/聊天)只在画面"明显变化"时才开口。
const DYNAMIC_SCENES = new Set(["sports", "video", "game"]);
// 画面变化阈值(16x16 灰度均差 0-255):打字/光标这类小改动 < 阈值不触发;切屏/滚动/视频切换 ≥ 阈值才算明显变化。
const CHANGE_THRESHOLD = 6;
const MIN_SPEAK_GAP = 3000; // 最小开口间隔,防止话赶话/盖过 TTS
let lastSig = null;
function sigDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// 去重:VLM 对变化不大的画面常吐同一句,光靠 prompt 管不住,客户端硬挡。
function _normC(s) { return String(s || "").replace(/[\s，。！!,.~、…?？:：;；"'"']+/g, "").trim(); }
function _bigrams(s) { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; }
function isDuplicateComment(comment) {
  const c = _normC(comment);
  if (!c) return true;
  for (const h of speakHistory) {
    const x = _normC(h);
    if (!x) continue;
    if (x === c) return true;
    const short = x.length <= c.length ? x : c, long = x.length <= c.length ? c : x;
    if (short.length >= 6 && long.includes(short)) return true; // 一句基本包含另一句
    const ga = _bigrams(x), gb = _bigrams(c); let inter = 0;
    ga.forEach(g => { if (gb.has(g)) inter++; });
    const uni = ga.size + gb.size - inter;
    if (uni > 0 && inter / uni > 0.68) return true; // 二元组相似度过高
  }
  return false;
}
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

// 自调度:每次看屏「完成后」再排下一次,绝不堆积(看屏 ~4-5s,固定 interval 会撞车)。
// 球赛跟得紧,工作/阅读拉长少打扰。
let loopTimer = null;
const SPORTS_GAP = 2500;
function scheduleNext(scene) {
  clearTimeout(loopTimer);
  if (!running) return;
  const base = SCENE_INTERVAL[scene] || cfg.interval;
  const gap = scene === "sports" ? Math.min(base, SPORTS_GAP) : Math.max(base, cfg.interval);
  loopTimer = setTimeout(tick, gap);
}

// 唯一的发声来源:看屏。读懂画面 → 该说才说(plan.say),否则只动不说,绝不"没话找话"。
async function tick() {
  if (busy || !running) return;
  busy = true;
  let scene = curScene;
  let reschedule = true;
  const t0 = Date.now();
  try {
    statusEl.textContent = "👀";
    if (needsKey() && !hasKey) { openKeyPanel(); reschedule = false; return; }
    const cap = await window.pet.captureScreen();
    if (!cap || !cap.image || cap.empty) {
      if (cap && (cap.permission === "denied" || cap.permission === "restricted" || cap.empty)) warnScreenPermission();
      scene = "idle"; petLog(`capture empty perm=${cap && cap.permission}`); return;
    }
    // 画面变化检测:静态场景(工作/阅读等)画面没明显变化就不打扰,连 VLM 都不调,保持安静。
    const diff = sigDiff(cap.sig, lastSig);
    const firstFrame = lastSig === null;
    lastSig = cap.sig || lastSig;
    const prevScene = AUTONOMY.lastScene;
    const dynamic = DYNAMIC_SCENES.has(prevScene);
    if (!firstFrame && !dynamic && diff < CHANGE_THRESHOLD) {
      scene = prevScene || "idle";
      statusEl.textContent = `${scene}·静`;
      petLog(`skip nochange diff=${diff.toFixed(1)} scene=${scene}`);
      return; // 画面没变,安静,下次再看
    }

    const changed = firstFrame || diff >= CHANGE_THRESHOLD;
    const resp = await window.pet.commentate({ image: cap.image, homeTeam: TEAMS[curTeam].name, history: speakHistory, provider: cfg.visionProvider, changed });
    if (resp.error) {
      statusEl.textContent = resp.error === "no_key" ? "未配置Key" : "✕";
      petLog(`commentate error: ${resp.error}`);
      if (resp.error === "no_key") { openKeyPanel(); reschedule = false; }
      return;
    }
    const plan = resp.plan || {};
    scene = plan.scene || "browse";
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    onSceneChanged(prevScene, scene);
    AUTONOMY.lastScene = scene;
    applyStealth(scene);
    statusEl.textContent = `${scene} ${dt}s`;
    petLog(`scene=${scene} say=${plan.say} diff=${diff.toFixed(1)} ${dt}s seen="${(plan.seen || "").slice(0, 44)}" comment="${(plan.comment || "").slice(0, 44)}"`);

    // 不该说就只做表情/动作,不出声
    if (!plan.say || !plan.comment) { executeMotion(plan); return; }
    // 去重 + 最小间隔(由画面变化驱动开口,不再用固定长冷却)
    const tooSoon = (Date.now() - AUTONOMY.lastSpeak) < MIN_SPEAK_GAP;
    if (tooSoon || isDuplicateComment(plan.comment)) {
      petLog(`suppress(${tooSoon ? "gap" : "dup"}) "${(plan.comment || "").slice(0, 30)}"`);
      executeMotion(plan);
      return;
    }
    AUTONOMY.lastSpeak = Date.now();
    pushHistory(plan.comment, plan.emotion);
    showBubble(plan.comment);
    executeMotion(plan);
    speak(plan.comment);
  } catch (e) { statusEl.textContent = "✕"; petLog(`tick exception: ${e && e.message || e}`); console.error(e); }
  finally {
    busy = false;
    if (reschedule && running) scheduleNext(scene);
  }
}

// 屏幕录制权限引导:抓不到画面时提示并引导去系统设置开权限(节流,避免反复弹)
let _permWarnAt = 0;
function warnScreenPermission() {
  statusEl.textContent = "需屏幕权限";
  const now = Date.now();
  if (now - _permWarnAt < 60e3) return;
  _permWarnAt = now;
  showBubble("我看不到屏幕内容,去“系统设置→隐私→屏幕录制”勾选我,再重开。");
  if (window.pet.openScreenSettings) window.pet.openScreenSettings();
}

// 启动时检查一次权限:未授权直接引导,别白跑一圈拿到空帧
async function checkScreenPermission() {
  try {
    if (!window.pet.screenPermission) return true;
    const r = await window.pet.screenPermission();
    if (r && (r.status === "denied" || r.status === "restricted")) {
      warnScreenPermission();
      return false;
    }
  } catch (_) {}
  return true;
}

let autonomyTimer = null, idleTimer = null;
async function startWatching() {
  if (needsKey() && !hasKey) {
    statusEl.textContent = "未配置Key";
    openKeyPanel();
    return;
  }
  running = true;
  AUTONOMY.sessionStart = Date.now(); AUTONOMY.lastSpeak = Date.now(); AUTONOMY.lastScene = null;
  STATS.sessions = (STATS.sessions || 0) + 1; saveStats();
  toggleBtn.textContent = "❚❚"; toggleBtn.className = "btn pause";
  petLog("start watching");
  // 自调度循环:tick 跑完再排下一次。只留"安静微动作",不再有主动唠嗑引擎。
  clearTimeout(loopTimer); tick();
  clearInterval(idleTimer); idleTimer = setInterval(idleMicroMotion, 12000);
  statusEl.textContent = "陪看中";
}
function stopWatching() {
  running = false;
  toggleBtn.textContent = "▶"; toggleBtn.className = "btn play";
  clearTimeout(loopTimer); clearInterval(idleTimer);
  flushWatchTime();
  petLog("stop watching");
  statusEl.textContent = "暂停";
}
async function autoStart() {
  statusEl.textContent = "待命";
  // 读取 Key 状态:没配则弹配置面板,不自动开始。
  try { const c = await window.pet.getConfig(); hasKey = !!c.hasKey; } catch (_) { hasKey = false; }
  if (needsKey() && !hasKey) { openKeyPanel(); return; }
  checkScreenPermission();
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
    setKeyStatus(needsKey() ? (hasKey ? "已保存" : "未配置") : "Qwen3 无需 Key", needsKey() ? hasKey : true);
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
  const vp = document.getElementById("visionProvider"); if (vp) vp.value = cfg.visionProvider;
  const tp = document.getElementById("ttsProvider"); if (tp) tp.value = cfg.ttsProvider;
  const tv = document.getElementById("ttsVoice"); if (tv) tv.value = cfg.ttsVoice;
  const rt = document.getElementById("rate"); if (rt) rt.value = cfg.rate;
  const pt = document.getElementById("pitch"); if (pt) pt.value = cfg.pitch;
}
document.querySelectorAll("#runtimeSeg button").forEach(b => b.onclick = async () => {
  await setRuntime(b.dataset.v); syncSettingsUI();
  showBubble(cfg.runtime === "live2d" ? "换上会动的我啦~" : "回到日常造型。");
});
document.querySelectorAll("#intervalSeg button").forEach(b => b.onclick = () => {
  cfg.interval = +b.dataset.v; saveCfg(); syncSettingsUI();
  // 自调度循环会在下次 scheduleNext 时读取新的 interval,无需重启定时器。
});
document.getElementById("vol").oninput = (e) => { cfg.vol = +e.target.value; player.volume = cfg.vol/100; saveCfg(); };
document.getElementById("mute").onchange = (e) => { cfg.mute = e.target.checked; saveCfg(); };
document.getElementById("auto").onchange = (e) => { cfg.auto = e.target.checked; saveCfg(); };
document.getElementById("speak").onchange = (e) => { cfg.speak = e.target.checked; saveCfg(); };
document.getElementById("ttsProvider")?.addEventListener("change", (e) => { cfg.ttsProvider = e.target.value; saveCfg(); });
document.getElementById("ttsVoice")?.addEventListener("change", (e) => {
  cfg.ttsVoice = e.target.value; saveCfg();
  cfg.speak = true; cfg.mute = false; saveCfg(); syncSettingsUI();
  speak("换个音色,你听听这个怎么样?");
});
document.getElementById("rate")?.addEventListener("input", (e) => { cfg.rate = +e.target.value; saveCfg(); });
document.getElementById("pitch")?.addEventListener("input", (e) => { cfg.pitch = +e.target.value; saveCfg(); });
document.getElementById("voiceSelect")?.addEventListener("change", (e) => { cfg.systemVoice = e.target.value; saveCfg(); pickVoice(); });
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
  if (!r.ok) showBubble("看屏模型连不上，检查 Key 或网络。");
};
document.getElementById("visionProvider")?.addEventListener("change", (e) => {
  cfg.visionProvider = e.target.value; saveCfg(); syncSettingsUI();
  setKeyStatus(needsKey() ? (hasKey ? "已保存" : "K2.6 需填 Key") : "Qwen3 无需 Key", needsKey() ? hasKey : true);
  showBubble(needsKey() ? "切到 Kimi K2.6，需要填你的 Key。" : "切回 Qwen3，本地看屏，开箱即用。");
});

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

// 场景切换感知:只记录,不主动搭话(发声只由看屏 commentate 决定)。
function onSceneChanged(prev, next) {
  if (!prev || prev === next) return;
  petLog(`scene change: ${prev} -> ${next}`);
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

// 注意:截屏时主进程会 win.hide()/show(),会触发 visibilitychange。
// 过去这里挂了"回来啦"问候,导致每个截屏周期都刷一句废话——已移除,不再主动问候。

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
