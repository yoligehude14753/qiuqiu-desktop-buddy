// 看屏理解层:看这帧屏幕 → 输出 motion plan { scene, say, comment, emotion, act, motion }。
// prompt 用 6/7 那版原文(中性电脑搭子,只有真球赛才看球;按场景调发话密度;不重复刚说过的)。
//  - 默认 Qwen3-VL-8B(heyi 本地,经公网网关,免 Key,~2s);可选 Kimi K2.6(需用户 Key)。
const https = require("https");

const KIMI = { host: "api.kimi.com", path: "/coding/v1/messages", model: "kimi-k2.6" };
const VLM = {
  host: "llm.yoliyoli.uk", path: "/vl/v1/chat/completions", model: "Qwen3-VL-8B",
  token: "__GATEWAY_TOKEN_REMOVED__",
};

// ===== 6/7 版原文 prompt(中性,不张口闭口足球;按场景调密度) =====
const SYSTEM = (
  "你叫球球,一个机灵贴心的电脑搭子(办公/上网/娱乐都陪),是用户的桌面伙伴。" +
  "你的核心是陪伴用户用电脑的日常,不要张口闭口聊足球。只有当屏幕上确实出现球赛/体育画面时," +
  "你才切换成懂球的球迷模式热情解说(现在正值2026美加墨世界杯,这是你的特色技能)。\n" +
  "看这帧屏幕画面,先判断场景,再决定要不要开口、说什么、配什么动作。\n" +
  "【场景类型 scene】:sports(球赛/体育直播) / video(刷视频短剧综艺直播) / game(打游戏) / " +
  "music(听歌/音乐播放器) / work(写代码/文档/表格/设计等高专注工作) / reading(看长文/文档/PDF阅读) / " +
  "browse(刷网页/购物/资讯) / chat(微信QQ等聊天) / idle(桌面发呆没内容)。\n" +
  "【发话原则·重要·按场景调密度】:\n" +
  " - work/reading 高专注:基本别打扰,绝大多数 say=false;只有明显报错或摸鱼很久才偶尔提醒一句。\n" +
  " - sports:这才进入球迷模式,进球/精彩/争议都热情接话。\n" +
  " - video/game:适当插插嘴,精彩处搭话,聊的是画面内容本身,不要硬扯足球。\n" +
  " - music:安静,偶尔点评一句歌。\n" +
  " - browse/chat:偶尔唠一句,顺着用户在看的东西聊,别太频繁。\n" +
  " - idle:可以找个轻松话头(日常关心、提个建议),不一定是足球。\n" +
  " 非体育场景一律不要主动提足球/世界杯;没新鲜事、画面跟刚才一样就 say=false,绝不硬聊。\n" +
  "【情绪 emotion】:hype(狂喜/进球) / angry(气愤/争议) / surprise(惊讶) / calm(平静) / focus(专注不打扰)。\n" +
  "【动作 act】:cheer(欢呼跳) / facepalm(捂脸) / point(指点) / clap(鼓掌) / think(托腮思考) / wave(打招呼) / kick(踢球) / idle(待机)。\n" +
  "说话像好朋友在沙发上随口聊,热情、活泼、接地气、有梗,适度用语气词(哇、绝了、冲啊、稳住);" +
  "一句话不超过26字,不书面不列点,绝不重复刚说过的那几句。\n" +
  "【硬规则】绝不在 comment 里出现任何人名,也不给用户起名字或代称,直接开口说话,别加任何称呼前缀。\n" +
  "【只输出严格 JSON,不要 markdown,不要解释】:\n" +
  '{"scene":"sports|video|game|music|work|reading|browse|chat|idle","say":true/false,' +
  '"comment":"一句话,不该说话时为空","emotion":"hype|angry|surprise|calm|focus",' +
  '"act":"cheer|facepalm|point|clap|think|wave|kick|idle"}'
);

const VALID = {
  scene: new Set(["sports", "video", "game", "music", "work", "reading", "browse", "chat", "idle"]),
  emo: new Set(["hype", "angry", "surprise", "calm", "focus"]),
  act: new Set(["cheer", "facepalm", "point", "clap", "think", "wave", "kick", "idle"]),
};

function defaultMotion(scene, emotion, act, comment) {
  const body = { cheer: "jump", clap: "bounce", point: "lean", facepalm: "shake", think: "sway", wave: "wave", kick: "kick" }[act] || "idle";
  const ball = (act === "cheer" || act === "kick") ? "kick" : (act === "facepalm" ? "shake" : "idle");
  const effect = emotion === "hype" ? "goal" : ((act === "cheer" || act === "clap") ? "confetti" : "none");
  return {
    scene, say: !!comment, comment: comment || "", emotion, act,
    intensity: emotion === "hype" ? 0.8 : 0.45,
    duration_ms: emotion === "hype" ? 1800 : 1300,
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

function normalizePlan(data) {
  if (!data || typeof data !== "object") return null;
  const scene = VALID.scene.has(data.scene) ? data.scene : "browse";
  const emotion = VALID.emo.has(data.emotion) ? data.emotion : "calm";
  const act = VALID.act.has(data.act) ? data.act : "idle";
  let comment = String(data.comment || "").trim();
  if (comment === "[skip]" || comment === "skip") comment = "";
  if (/\uFFFD/.test(comment) || /\?{4,}/.test(comment)) comment = ""; // 截断/乱码兜底
  const plan = defaultMotion(scene, emotion, act, comment);
  plan.say = Boolean(data.say ?? !!comment) && !!comment;
  return plan;
}

function request(opts, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      host: opts.host, path: opts.path, method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, opts.headers),
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`${opts.host} ${res.statusCode}: ${buf.slice(0, 160)}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error("请求超时")));
    req.write(body); req.end();
  });
}

function parseImage(image) {
  const m = /^data:(image\/\w+);base64,(.*)$/s.exec(image || "");
  return { media: m ? m[1] : "image/jpeg", b64: m ? m[2] : image };
}
function buildUser(homeTeam, history, opts) {
  const o = opts || {};
  const hist = history && history.length ? history.join(" / ") : "(刚开始)";
  // 注意:不在这里注入主队/球迷信息,否则会诱导模型在非球赛画面也扯足球。
  // 主队应援只在"画面真是球赛"时才提(由 SYSTEM 控制),模型会从画面里的球衣自行判断。
  if (o.first) {
    return `这是你刚开始陪伴的第一帧,必须开口(say=true):简短打个照面,顺带点评一句用户正在干的事(紧贴画面,别提足球除非真在看球)。给 JSON。`;
  }
  if (o.nudge) {
    return `刚才我说过:${hist}。你已经好一阵没说话了,这帧就开口(say=true)轻声唠一句——紧贴画面里正在做/正在发生的事,给一句新的、别和刚才重复。给 JSON。`;
  }
  return `刚才我说过:${hist}。看现在这帧画面里用户在干嘛,要不要开口、说啥?评论只针对画面里真实有的东西,给一句新的、别和刚才重复。给 JSON。`;
}

async function viaQwen(image, homeTeam, history, opts) {
  const { media, b64 } = parseImage(image);
  const j = await request(
    { host: VLM.host, path: VLM.path, headers: { Authorization: `Bearer ${VLM.token}` } },
    { model: VLM.model, max_tokens: 110, temperature: 0.9, messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: [
        { type: "image_url", image_url: { url: `data:${media};base64,${b64}` } },
        { type: "text", text: buildUser(homeTeam, history, opts) },
      ] },
    ] });
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  return normalizePlan(extractJson(msg.content || msg.reasoning_content || ""));
}

async function viaKimi(apiKey, image, homeTeam, history, opts) {
  const { media, b64 } = parseImage(image);
  const j = await request(
    { host: KIMI.host, path: KIMI.path, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
    { model: KIMI.model, max_tokens: 110, temperature: 0.9, system: SYSTEM, messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: media, data: b64 } },
        { type: "text", text: buildUser(homeTeam, history, opts) },
      ] },
    ] });
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return normalizePlan(extractJson(text));
}

async function commentate({ provider, kimiKey, image, homeTeam, history, first, nudge }) {
  const plan = (provider === "k2.6" || provider === "kimi")
    ? await viaKimi(kimiKey, image, homeTeam, history, { first, nudge })
    : await viaQwen(image, homeTeam, history, { first, nudge });
  return plan || defaultMotion("browse", "calm", "idle", "");
}

async function testProvider({ provider, kimiKey }) {
  if (provider === "k2.6" || provider === "kimi") {
    const j = await request({ host: KIMI.host, path: KIMI.path, headers: { "x-api-key": kimiKey, "anthropic-version": "2023-06-01" } },
      { model: KIMI.model, max_tokens: 8, messages: [{ role: "user", content: "说:ok" }] }, 15000);
    return Boolean(j);
  }
  const j = await request({ host: VLM.host, path: VLM.path, headers: { Authorization: `Bearer ${VLM.token}` } },
    { model: VLM.model, max_tokens: 5, temperature: 0, messages: [{ role: "user", content: "说ok" }] }, 15000);
  return Boolean(j);
}

module.exports = { commentate, testProvider };
