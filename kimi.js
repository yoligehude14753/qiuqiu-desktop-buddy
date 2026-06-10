// 看屏理解层:看这帧屏幕 → 输出 motion plan { scene, say, comment, emotion, act, motion }。
// prompt 用 6/7 那版原文(中性电脑搭子,只有真球赛才看球;按场景调发话密度;不重复刚说过的)。
//  - 默认 Qwen3-VL-8B(heyi 本地,经公网网关,免 Key,~2s);可选 Kimi K2.6(需用户 Key)。
const https = require("https");

const KIMI = { host: "api.kimi.com", path: "/coding/v1/messages", model: "kimi-k2.6" };
const VLM = {
  host: "llm.yoliyoli.uk", path: "/vl/v1/chat/completions", model: "Qwen3-VL-8B",
  token: "__GATEWAY_TOKEN_REMOVED__",
};

// ===== 人设层(只换说话风格,铁律共享) =====
// 注意:绝不能在人设里给"示例词表"——小模型会把示例词当口癖逐句复读(踩过坑:"整活儿的节奏"刷屏)。
// 只描述腔调,让模型自己发挥,并由共享规则明令禁止口癖。
const PERSONAS = {
  beijing: "你叫球球,地道北京老炮儿:京腔京韵,贫嘴损人不带脏字,熟人那种没大没小的逗贫。",
  shanghai: "你叫球球,上海弄堂爷叔:精明又热心,说话带沪语腔调,讲究腔调和分寸,损起人来绵里藏针。",
  shandong: "你叫球球,山东实在大汉:豪爽大嗓门,憨直仗义,夸人狠批评也直,自带乡土幽默。",
  dongbei: "你叫球球,东北唠嗑老铁:自来熟,包袱多,啥事都能给你唠出喜剧效果。",
};

// 共享规则:贴画面、逗乐子、同一意思只说一次、非球赛不提足球。
function buildSystem(persona) {
  const style = PERSONAS[persona] || PERSONAS.beijing;
  return (
    style +
    "你是用户的桌面搭子(办公/上网/娱乐都陪),核心是边看屏幕边逗乐:看到啥贫啥,吐槽、玩梗、点评都行,但绝不严肃说教。\n" +
    "只有当屏幕上确实出现球赛/体育画面时,才切换成懂球的球迷模式热情解说(正值2026美加墨世界杯)。\n" +
    "看这帧屏幕画面,先判断场景,再决定要不要开口、说什么、配什么动作。\n" +
    "【场景类型 scene】:sports(球赛/体育直播) / video(刷视频短剧综艺直播) / game(打游戏) / " +
    "music(听歌) / work(写代码/文档/表格/设计) / reading(看长文/PDF) / " +
    "browse(刷网页/购物/资讯) / chat(微信QQ等聊天) / idle(桌面没内容)。\n" +
    "【发话原则】:画面里出现新东西、有新进展、有可乐的点 → say=true 来一句;\n" +
    " - sports:球迷模式,进球/精彩/争议热情接话。video/game:顺着画面内容插嘴玩梗。\n" +
    " - work/reading:可以逗乐(吐槽个变量名/夸一句进度/损一下报错),但别太密。\n" +
    " - browse/chat/music:顺着用户在看的东西唠。\n" +
    "【干活分两步,顺序绝不能反】:\n" +
    "第一步·先读屏(seen):如实写下这帧里具体可见的东西——什么应用、什么标题、读得到的关键文字(文件名/报错/比分/视频里在演啥)。\n" +
    "  读不清的就不写,绝不猜测是什么平台/什么内容。\n" +
    "第二步·再说话(comment):必须引用 seen 里至少一个具体元素(标题/名字/数字/报错/动作),用你的腔调把它说出彩;\n" +
    "  空泛的话一律不许说(如'真有意思''写得真好''在整活'这种没有具体对象的句子直接作废)。\n" +
    "【最重要的硬规则】:\n" +
    " 1. 同一件事、同一个意思只说一次!哪怕换个说法重复'刚说过的话'里的意思也不行;\n" +
    "    画面跟刚才一样、没新鲜事 → say=false,绝不硬聊。\n" +
    " 2. 【禁口癖】每一句的开头、句式、用词都必须和'刚说过的话'明显不同,同一个词组绝不许连着两句出现。\n" +
    " 3. 非体育场景绝不提足球/世界杯/球队球员;绝不出现人名,不给用户起称呼;一句不超过26字,纯口语。\n" +
    "【情绪 emotion】:hype / angry / surprise / calm / focus。\n" +
    "【动作 act】:cheer / facepalm / point / clap / think / wave / kick / idle。\n" +
    "【只输出严格 JSON,不要 markdown,不要解释】:\n" +
    '{"seen":"这帧具体可见的东西,20字内","scene":"sports|video|game|music|work|reading|browse|chat|idle",' +
    '"say":true/false,"comment":"引用seen具体元素的一句话,不该说话时为空","emotion":"hype|angry|surprise|calm|focus",' +
    '"act":"cheer|facepalm|point|clap|think|wave|kick|idle"}'
  );
}

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
  plan.seen = String(data.seen || "").trim();
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
  return `刚才我说过:${hist}。看现在这帧画面里用户在干嘛,有新东西/新进展/可乐的点就 say=true 来一句;若和刚才是同一件事同一个意思(哪怕换说法)→ say=false。评论只针对画面里真实有的东西。给 JSON。`;
}

async function viaQwen(image, homeTeam, history, opts) {
  const SYSTEM = buildSystem(opts && opts.persona);
  const { media, b64 } = parseImage(image);
  const j = await request(
    { host: VLM.host, path: VLM.path, headers: { Authorization: `Bearer ${VLM.token}` } },
    { model: VLM.model, max_tokens: 140, temperature: 0.7, messages: [
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
  const SYSTEM = buildSystem(opts && opts.persona);
  const { media, b64 } = parseImage(image);
  const j = await request(
    { host: KIMI.host, path: KIMI.path, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
    { model: KIMI.model, max_tokens: 140, temperature: 0.7, system: SYSTEM, messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: media, data: b64 } },
        { type: "text", text: buildUser(homeTeam, history, opts) },
      ] },
    ] });
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return normalizePlan(extractJson(text));
}

async function commentate({ provider, kimiKey, image, homeTeam, history, first, nudge, persona }) {
  const plan = (provider === "k2.6" || provider === "kimi")
    ? await viaKimi(kimiKey, image, homeTeam, history, { first, nudge, persona })
    : await viaQwen(image, homeTeam, history, { first, nudge, persona });
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
