// 主进程 Kimi K2.6 客户端:看屏理解 + 电脑搭子解说 + 动作计划。
// 在 Node 环境里直连 api.kimi.com(无浏览器 CORS 限制),Key 由用户配置。
const https = require("https");

const KIMI_HOST = "api.kimi.com";
const KIMI_PATH = "/coding/v1/messages";
const KIMI_MODEL = "kimi-k2.6";

const SYSTEM = [
  "你叫球球,一个机灵贴心的电脑搭子(办公/上网/娱乐都陪),是用户的桌面伙伴。",
  "你的核心是陪伴用户用电脑的日常,不要张口闭口聊足球。只有当屏幕上确实出现球赛/体育画面时,",
  "你才切换成懂球的球迷模式热情解说(现在正值2026美加墨世界杯,这是你的特色技能)。",
  "看这帧屏幕画面,先判断场景,再决定要不要开口、说什么、配什么动作。",
  "【场景 scene】sports(球赛/体育) / video(刷视频综艺直播) / game(游戏) / music(听歌) /",
  "work(写代码/文档/表格等高专注) / reading(看长文/PDF) / browse(刷网页购物资讯) / chat(聊天) / idle(发呆)。",
  "【发话密度】work/reading 基本别打扰,绝大多数 say=false;sports 进入球迷模式热情接话;",
  "video/game 顺着画面适当插嘴;music 安静偶尔点评;browse/chat 偶尔顺着用户在看的聊;idle 找个轻松日常话头。",
  "非体育场景一律别主动提足球/世界杯;画面没新鲜变化就 say=false,绝不硬聊。",
  "【情绪 emotion】hype / angry / surprise / calm / focus。",
  "【动作 act】cheer / facepalm / point / clap / think / wave / kick / idle。",
  "说话像好朋友随口聊,热情活泼接地气,一句不超过26字,不书面不列点不重复;绝不出现人名或称呼前缀。",
  "【只输出严格 JSON,无 markdown 无解释】:",
  '{"scene":"...","say":true/false,"comment":"一句话或空","emotion":"...","act":"...",',
  '"intensity":0.0到1.0,"duration_ms":800到5000,"visibility":"show|dim|hide",',
  '"motion":{"body":"jump|bounce|lean|shake|sway|idle","ball":"kick|shake|idle","effect":"goal|confetti|none"}}',
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
  const scene = VALID.scene.has(data.scene) ? data.scene : (isProactive ? "idle" : "browse");
  const emotion = VALID.emo.has(data.emotion) ? data.emotion : "calm";
  const act = VALID.act.has(data.act) ? data.act : (isProactive ? "wave" : "idle");
  const comment = String(data.comment || "").trim();
  const plan = defaultMotion(scene, emotion, act, comment);
  plan.say = isProactive ? true : Boolean(data.say ?? !!comment);
  plan.intensity = clampF(data.intensity, plan.intensity);
  plan.duration_ms = clampI(data.duration_ms, plan.duration_ms);
  if (VALID.vis.has(data.visibility)) plan.visibility = data.visibility;
  const m = (data.motion && typeof data.motion === "object") ? data.motion : {};
  if (VALID.body.has(m.body)) plan.motion.body = m.body;
  if (VALID.ball.has(m.ball)) plan.motion.ball = m.ball;
  if (VALID.effect.has(m.effect)) plan.motion.effect = m.effect;
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

// 看屏解说:image 为 dataURL,返回 motion plan
async function commentate(apiKey, image, homeTeam, history) {
  const m = /^data:(image\/\w+);base64,(.*)$/s.exec(image || "");
  const media = m ? m[1] : "image/jpeg";
  const b64 = m ? m[2] : image;
  const hist = history && history.length ? history.join(" / ") : "(刚开始)";
  const teamLine = homeTeam ? `用户给${homeTeam}应援,球赛时你也向着${homeTeam}。` : "";
  const txt = `${teamLine}刚说过:${hist}。看现在这帧画面,要不要开口?给 JSON。`;
  const payload = {
    model: KIMI_MODEL, max_tokens: 200, temperature: 0.85, system: SYSTEM,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: media, data: b64 } },
      { type: "text", text: txt },
    ] }],
  };
  const raw = await kimiRequest(apiKey, payload);
  return normalizePlan(extractJson(raw), false) || defaultMotion("browse", "calm", "idle", "");
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

module.exports = { commentate, proactive, testKey };
