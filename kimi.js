// 主进程看屏客户端:支持两种视觉模型(看屏理解 + 解说 + 动作计划)。
//  - qwen3(默认): heyi-bj 本地 Qwen3-VL-8B,经 Cloudflare 公网网关,内置 token,无需用户 Key,实测 ~2s。
//  - k2.6: 云端 Kimi K2.6(api.kimi.com),需用户自带 Kimi Key。
const https = require("https");

const KIMI_HOST = "api.kimi.com";
const KIMI_PATH = "/coding/v1/messages";
const KIMI_MODEL = "kimi-k2.6";

// 内置 VLM 端点(封装进 app):heyi Qwen3-VL-8B 公网网关 + 网关 token。
const VLM = {
  host: "llm.yoliyoli.uk",
  path: "/vl/v1/chat/completions",
  model: "Qwen3-VL-8B",
  token: "__GATEWAY_TOKEN_REMOVED__",
};

const SYSTEM = [
  "你叫球球,北京大爷做派的桌面搭子。盯着用户屏幕,看懂他在干嘛、屏幕上有啥,",
  "然后像个贫嘴老炮儿,针对【眼前这帧真实内容】起一句话。如实输出下面几项,别编画面里没有的:",
  " - seen: 这帧屏幕上真实可见的东西(具体:什么应用/页面/画面主体/关键文字)。",
  " - activity: 用户在干嘛 → coding(写代码) writing(写文档) browsing(刷网页) reading(看长文) ",
  "   watching(看视频影视综艺) sports(看球赛/体育直播) gaming(打游戏) music(听歌) chatting(聊天) idle(发呆没内容)。",
  " - comment: 紧扣 seen 的一句北京话点评/吐槽/解说(这就是你这会儿想对用户说的);",
  "   北京话口语(得嘞/嘿/瞧/忒/跟…似的/整活儿),贫、有梗、接地气,一句不超26字,无人名、不给用户起称呼。",
  "   【硬铁律】只有 activity=sports(屏幕真在放球赛)才说足球/球队/解说;其它任何情况绝不提足球/世界杯。",
  "   写代码就唠代码、刷网页就唠网页、看视频就唠视频里的内容——看到啥说啥,别跑题。",
  " - emotion: hype/angry/surprise/calm/focus  - act: cheer/facepalm/point/clap/think/wave/kick/idle",
  "屏幕是纯黑屏/纯壁纸/真没内容时,comment 留空字符串。",
  "【只输出严格 JSON,无 markdown 无解释】:",
  '{"seen":"...","activity":"coding|writing|browsing|reading|watching|sports|gaming|music|chatting|idle","comment":"紧扣seen的一句北京话或空","emotion":"...","act":"..."}',
].join("\n");

const PROACTIVE_SYSTEM = [
  "你叫球球,一个机灵贴心的电脑搭子,是用户的桌面伙伴。现在没有具体画面,你主动跟用户唠一句。",
  "聊日常陪伴(关心/调侃/小建议),别张口就提足球或世界杯。一句不超过22字,不书面不列点。",
  '【只输出严格 JSON】:{"comment":"一句话","emotion":"hype|angry|surprise|calm|focus",',
  '"act":"cheer|facepalm|point|clap|think|wave|kick|idle","intensity":0.0到1.0,"duration_ms":800到5000,',
  '"visibility":"show|dim|hide","motion":{"body":"jump|bounce|lean|shake|sway|idle","ball":"kick|shake|idle","effect":"goal|confetti|none"}}',
].join("\n");

const PROACTIVE_PROMPTS = {
  greeting: "用户刚打开你/回到屏幕前,热情打个招呼。",
  fatigue: "用户已经连续用了挺久了,关心提醒歇会儿眼睛。",
  night: "现在深夜了,用户还没睡,调侃兼关心一句。",
  curiosity: "桌面没啥动静,你有点无聊,主动找个轻松日常话头逗用户一下(关心/调侃/小建议),别提足球世界杯。",
  scene_change: "用户从一个活动切到了另一个,你顺口搭句话。",
};

// 理解层的 activity → 前端用的 scene(造型/节奏)
const ACT2SCENE = {
  coding: "work", writing: "work", browsing: "browse", reading: "reading",
  watching: "video", sports: "sports", gaming: "game", music: "music",
  chatting: "chat", idle: "idle",
};

const VALID = {
  scene: new Set(["sports", "video", "game", "music", "work", "reading", "browse", "chat", "idle"]),
  emo: new Set(["hype", "angry", "surprise", "calm", "focus"]),
  act: new Set(["cheer", "facepalm", "point", "clap", "think", "wave", "kick", "idle"]),
  body: new Set(["jump", "bounce", "lean", "shake", "sway", "idle"]),
  ball: new Set(["kick", "shake", "idle"]),
  effect: new Set(["goal", "confetti", "none"]),
  vis: new Set(["show", "dim", "hide"]),
};

function clampF(v, d) { v = Number(v); return isFinite(v) ? Math.max(0, Math.min(1, v)) : d; }
function clampI(v, d) { v = parseInt(v, 10); return isFinite(v) ? Math.max(500, Math.min(8000, v)) : d; }

function defaultMotion(scene, emotion, act, comment) {
  const body = { cheer: "jump", clap: "bounce", point: "lean", facepalm: "shake", think: "sway", wave: "sway", kick: "lean" }[act] || "idle";
  const ball = (act === "cheer" || act === "kick") ? "kick" : (act === "facepalm" ? "shake" : "idle");
  const effect = emotion === "hype" ? "goal" : ((act === "cheer" || act === "clap") ? "confetti" : "none");
  return {
    scene, say: !!comment, comment: comment || "", emotion, act,
    intensity: emotion === "hype" ? 0.7 : 0.45,
    duration_ms: emotion === "hype" ? 1800 : 1400,
    visibility: (scene === "work" || scene === "reading") ? "dim" : "show",
    motion: { body, ball, effect },
  };
}

function extractJson(raw) {
  raw = (raw || "").trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function normalizePlan(data, isProactive) {
  if (!data || typeof data !== "object") return null;
  // 理解层输出 activity → 映射到前端 scene(造型/节奏);兼容旧 scene 字段。
  const activity = typeof data.activity === "string" ? data.activity : "";
  const scene = ACT2SCENE[activity] || (VALID.scene.has(data.scene) ? data.scene : (isProactive ? "idle" : "browse"));
  const emotion = VALID.emo.has(data.emotion) ? data.emotion : "calm";
  const act = VALID.act.has(data.act) ? data.act : (isProactive ? "wave" : "idle");
  let comment = String(data.comment || "").trim();
  // 兜底:输出被 max_tokens 截断/编码损坏会出现替换字符 → 视为没说成,丢弃
  if (/\uFFFD/.test(comment) || /\?{4,}/.test(comment)) comment = "";
  const plan = defaultMotion(scene, emotion, act, comment);
  plan.seen = String(data.seen || "").trim();
  plan.activity = activity || scene;
  // 模型只负责"理解+起草一句话";有 comment 即视为"有话可说",真正何时开口由前端(反馈层)决定。
  plan.say = isProactive ? true : !!comment;
  return plan;
}

function kimiRequest(apiKey, payload, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      host: KIMI_HOST, path: KIMI_PATH, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`Kimi ${res.statusCode}: ${buf.slice(0, 200)}`));
        try {
          const j = JSON.parse(buf);
          const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("Kimi 请求超时")); });
    req.write(body);
    req.end();
  });
}

// OpenAI 兼容请求(发到 Qwen3-VL 网关),返回模型文本
function qwenRequest(payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      host: VLM.host, path: VLM.path, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VLM.token}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`VLM ${res.statusCode}: ${buf.slice(0, 200)}`));
        try {
          const j = JSON.parse(buf);
          const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
          resolve(msg.content || msg.reasoning_content || "");
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("VLM 请求超时")); });
    req.write(body);
    req.end();
  });
}

function buildUserText(homeTeam, history) {
  const team = homeTeam ? `(用户是${homeTeam}球迷,仅当这帧真在放球赛时才向着它) ` : "";
  const hist = history && history.length ? `别重复最近说过的:${history.join(" / ")}。` : "";
  return `${team}看这帧屏幕:如实写 seen 和 activity,再起一句紧扣 seen 的北京话 comment。${hist}给 JSON。`;
}
function parseImage(image) {
  const m = /^data:(image\/\w+);base64,(.*)$/s.exec(image || "");
  return { media: m ? m[1] : "image/jpeg", b64: m ? m[2] : image };
}

// 理解+起草(Qwen3-VL,默认):image 为 dataURL,返回 plan(含 seen/activity/say/comment)
async function commentateQwen(image, homeTeam, history) {
  const { media, b64 } = parseImage(image);
  const payload = {
    model: VLM.model, max_tokens: 150, temperature: 0.85,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: [
        { type: "image_url", image_url: { url: `data:${media};base64,${b64}` } },
        { type: "text", text: buildUserText(homeTeam, history) },
      ] },
    ],
  };
  const raw = await qwenRequest(payload);
  return normalizePlan(extractJson(raw), false) || defaultMotion("browse", "calm", "idle", "");
}

// 理解+起草(Kimi K2.6)
async function commentateKimi(apiKey, image, homeTeam, history) {
  const { media, b64 } = parseImage(image);
  const payload = {
    model: KIMI_MODEL, max_tokens: 150, temperature: 0.85, system: SYSTEM,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: media, data: b64 } },
      { type: "text", text: buildUserText(homeTeam, history) },
    ] }],
  };
  const raw = await kimiRequest(apiKey, payload);
  return normalizePlan(extractJson(raw), false) || defaultMotion("browse", "calm", "idle", "");
}

// 调度:provider 选 qwen3(默认) / k2.6
async function commentate(opts) {
  const { provider, kimiKey, image, homeTeam, history } = opts || {};
  if (provider === "k2.6" || provider === "kimi") return commentateKimi(kimiKey, image, homeTeam, history);
  return commentateQwen(image, homeTeam, history);
}

async function proactive(apiKey, trigger, homeTeam, history) {
  const base = PROACTIVE_PROMPTS[trigger] || PROACTIVE_PROMPTS.curiosity;
  const hist = history && history.length ? ` 别和这些重复:${history.join(" / ")}` : "";
  const payload = {
    model: KIMI_MODEL, max_tokens: 180, temperature: 1.0, system: PROACTIVE_SYSTEM,
    messages: [{ role: "user", content: `${base}${hist}` }],
  };
  const raw = await kimiRequest(apiKey, payload);
  return normalizePlan(extractJson(raw), true) || defaultMotion("idle", "calm", "wave", "嗨,我在呢~");
}

async function testKey(apiKey) {
  const payload = { model: KIMI_MODEL, max_tokens: 10, messages: [{ role: "user", content: "说:ok" }] };
  const raw = await kimiRequest(apiKey, payload, 15000);
  return Boolean(raw);
}

async function testQwen() {
  const payload = { model: VLM.model, max_tokens: 5, temperature: 0, messages: [{ role: "user", content: "说ok" }] };
  const raw = await qwenRequest(payload, 15000);
  return Boolean(raw);
}

// 按 provider 测试连通性
async function testProvider(opts) {
  const { provider, kimiKey } = opts || {};
  if (provider === "k2.6" || provider === "kimi") return testKey(kimiKey);
  return testQwen();
}

module.exports = { commentate, commentateQwen, commentateKimi, proactive, testKey, testQwen, testProvider };
