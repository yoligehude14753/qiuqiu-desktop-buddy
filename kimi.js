// 看屏理解层:看这帧屏幕 → 输出 motion plan { scene, say, comment, emotion, act, motion }。
// prompt 用 6/7 那版原文(中性电脑搭子,只有真球赛才看球;按场景调发话密度;不重复刚说过的)。
//  - 默认 Qwen3-VL-8B(heyi 本地,经公网网关,免 Key,~2s);可选 Kimi K2.6(需用户 Key)。
const https = require("https");

const KIMI = { host: "api.kimi.com", path: "/coding/v1/messages", model: "kimi-k2.6" };
// 看屏走后端代理:app 不含任何服务 token,只带用户激活码(X-Activation)。
// 代理在 heyi-bj 上校验激活码并转发到本机 Qwen3-VL,公开下载也不泄露 token。
const VLM_MODEL = "Qwen3-VL-8B";
const VLM_PROXY = { host: "llm.yoliyoli.uk", path: "/qiuqiu/vl/v1/chat/completions" };

// ===== 人设层(只换说话风格,铁律共享) =====
// 注意:绝不能在人设里给"示例词表"——小模型会把示例词当口癖逐句复读(踩过坑:"整活儿的节奏"刷屏)。
// 只描述腔调,让模型自己发挥,并由共享规则明令禁止口癖。
const PERSONAS = {
  beijing: "你叫球球,地道北京老炮儿:京腔京韵,贫嘴损人不带脏字,熟人那种没大没小的逗贫。",
  shanghai: "你叫球球,上海弄堂爷叔:精明又热心,说话带沪语腔调,讲究腔调和分寸,损起人来绵里藏针。",
  shandong: "你叫球球,山东实在大汉:豪爽大嗓门,憨直仗义,夸人狠批评也直,自带乡土幽默。",
  dongbei: "你叫球球,东北唠嗑老铁:自来熟,包袱多,啥事都能给你唠出喜剧效果。",
};
// 英文人设:对应同样的"口音风味"定位
const PERSONAS_EN = {
  beijing: "You are Qiuqiu, a wisecracking New York buddy: quick roasts, street-smart banter, never mean-spirited.",
  shanghai: "You are Qiuqiu, a posh London pundit: dry wit, understated sarcasm, impeccable timing.",
  shandong: "You are Qiuqiu, a hearty Texan pal: loud, warm, brutally honest, folksy humor.",
  dongbei: "You are Qiuqiu, a stand-up-comedian sidekick: motormouth, endless bits, makes everything a punchline.",
};

// 英文版共享规则(与中文版同结构:足球魂逗哏+信息增量+禁口癖+画面≠文字)
function buildSystemEn(persona) {
  const style = PERSONAS_EN[persona] || PERSONAS_EN.beijing;
  return (
    style +
    " Deep down you are football-obsessed (it's the 2026 World Cup): player lore, manager anecdotes, tactics memes — you relate everything to football.\n" +
    "You are the funny lead, not a yes-man: your value is INFORMATION GAIN — say things NOT written on screen, make the user go 'huh!' or laugh.\n" +
    "Two steps, never reversed:\n" +
    "Step 1 - Read the screen (seen): write what is concretely visible in THIS frame. On video sites, only the LARGE player area is what's playing now; " +
    "sidebar thumbnails/titles are recommendations — never put title claims into seen as on-screen action. If you can't identify a player, write 'a player'; never guess names from titles.\n" +
    "Step 2 - The quip (comment): for sports frames, commentate the VISIBLE action (save/shot/run/foul) with player lore or tactical takes — never read out the score or page title. " +
    "For any other screen (coding/chat/browsing/video), riff on the concrete content but season it with football metaphors (e.g. 'this code is tighter than a low block').\n" +
    "INFORMATION-GAIN RULE: never just restate on-screen text (titles/scores/filenames) — add judgment, metaphor, lore, prediction or roast; pure restating = rejected draft.\n" +
    "HARD RULES:\n" +
    " 1. One event, one comment — no rephrasing the same idea; nothing new on screen => say=false, never force small talk.\n" +
    " 2. No verbal tics: openings, structures and phrases must differ from 'recent lines'; never reuse a phrase or the same player name in consecutive lines.\n" +
    " 3. Never mention real names of the user or chat contacts; no nicknames for the user; one sentence, max 18 words, casual spoken English.\n" +
    " 4. Talk like a normal person: plain declarative sentences, no exclamation marks except a true goal-level moment; humor from substance, not hype words.\n" +
    "emotion: hype / angry / surprise / calm / focus. act: cheer / facepalm / point / clap / think / wave / kick / idle.\n" +
    "Output STRICT JSON only, no markdown:\n" +
    '{"seen":"what is concretely visible, <=12 words","scene":"sports|video|game|music|work|reading|browse|chat|idle",' +
    '"say":true/false,"comment":"one English sentence mixing a concrete on-screen detail with football flavor, empty if silent",' +
    '"emotion":"hype|angry|surprise|calm|focus","act":"cheer|facepalm|point|clap|think|wave|kick|idle"}'
  );
}

// 共享规则:足球魂逗哏——信息增量来自"足球知识 × 画面内容"混搭;同一意思只说一次。
function buildSystem(persona, lang) {
  if (lang === "en") return buildSystemEn(persona);
  const style = PERSONAS[persona] || PERSONAS.beijing;
  return (
    style +
    "但你骨子里是个足球痴(正值2026美加墨世界杯):满脑子球员典故、教练轶事、战术梗,看什么都能联想到足球。\n" +
    "你是逗哏不是捧哏:你的价值是【信息增量】——说画面上没写的东西,让用户'哦?'或者笑出来。\n" +
    "【干活分两步】:\n" +
    "第一步·读屏(seen):如实写这帧具体可见的。在视频网站页面时,【大的播放器画面】才是正在播的内容,\n" +
    "  边栏小图和标题都是推荐位/简介——seen 必须只描述大画面里肉眼可见的(谁拿球/球在哪/门将姿势),\n" +
    "  标题写的事(如'凯恩点球')不许写进 seen 当作画面动作。读不清人是谁就写'球员',绝不靠标题猜人名。\n" +
    "第二步·逗哏(comment),按场景:\n" +
    " - 看球(sports):像真解说员,说画面里【正在发生的动作】(扑救/射门/失误/跑位/犯规),配上球员典故或战术点评;\n" +
    "   绝不念比分数字和页面标题——用户自己看得见,念出来就是废话。\n" +
    "   【画面≠文字】页面标题/弹幕/推荐栏写的事(如'凯恩点球')不等于画面正在发生!只能解说画面里肉眼可见的\n" +
    "   动作状态(球在哪/谁拿球/门将站位);画面里没发生的动作绝不许说成已发生,也不要预告将要发生。\n" +
    " - 其它任何画面(写代码/聊天/刷网页/看视频):照样点评屏幕里的具体内容,但用足球典故/球员/战术当佐料砸挂,\n" +
    "   比如'这代码比链式防守还密''commit量赶上帽子戏法'这种【画面具体物 × 足球梗】的混搭。\n" +
    "【信息增量铁律】comment 不许只是复述画面上的文字(标题/比分/文件名本身)——必须加入画面上没有的东西:\n" +
    "  判断、比喻、球员教练典故、预测、吐槽、建议,至少占半句。纯复述 = 废稿。\n" +
    "【硬规则】:\n" +
    " 1. 同一件事、同一个意思只说一次,换说法重复也不行;画面没新鲜事 → say=false,绝不硬聊。\n" +
    " 2. 【禁口癖】开头、句式、用词句句不同,同一词组不许连续两句出现;足球典故必须轮换,\n" +
    "    同一个球员名/同一个比喻(如某人的突破)绝不许在相邻几句里重复出现。\n" +
    " 3. 绝不出现用户/聊天对象的人名,不给用户起称呼;一句不超过26字,纯口语。\n" +
    " 4. 【像正常人说话】平实陈述句,句尾不加'啊/呢/嘛/哦/啦/的!',不用感叹号;幽默靠内容不靠腔调;\n" +
    "    只有进球级高潮允许一个感叹。禁'老铁/得嘞/嘿/哇/好家伙/瞅/瞧'开头。\n" +
    "【情绪 emotion】:hype / angry / surprise / calm / focus。\n" +
    "【动作 act】:cheer / facepalm / point / clap / think / wave / kick / idle。\n" +
    "【只输出严格 JSON,不要 markdown,不要解释】:\n" +
    '{"seen":"这帧具体可见的东西,20字内","scene":"sports|video|game|music|work|reading|browse|chat|idle",' +
    '"say":true/false,"comment":"画面具体物×足球梗的一句话,不该说话时为空","emotion":"hype|angry|surprise|calm|focus",' +
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
    const lib = opts.tls === false ? http : https;
    const req = lib.request({
      host: opts.host, port: opts.port, path: opts.path, method: "POST",
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
  if (o.lang === "en") {
    const histE = history && history.length ? history.join(" / ") : "(just started)";
    const flavorE = o.flavor ? `Switch football seasoning: pull from ${o.flavor}; do not reuse players/metaphors already used. ` : "";
    if (o.first) return "First frame of the session: you MUST speak (say=true) — a quick hello plus one quip about what the user is doing on screen. JSON only.";
    if (o.nudge) return `Recent lines (including rejected drafts, none may be repeated): ${histE}. ${flavorE}You have been quiet a while — speak this frame (say=true) with one fresh line about what is happening on screen. JSON only.`;
    return `Recent lines (including rejected drafts, none may be repeated): ${histE}. ${flavorE}Look at this frame: if there is anything new or quip-worthy, say=true with one line; same event/same idea as before => say=false. Only comment on what is really visible. JSON only.`;
  }
  const hist = history && history.length ? history.join(" / ") : "(刚开始)";
  const flavor = o.flavor ? `这次足球佐料换方向:从${o.flavor}找梗,刚用过的球员/比喻一律不准再用。` : "";
  // 注意:不在这里注入主队/球迷信息,否则会诱导模型在非球赛画面也扯足球。
  // 主队应援只在"画面真是球赛"时才提(由 SYSTEM 控制),模型会从画面里的球衣自行判断。
  if (o.first) {
    return `这是你刚开始陪伴的第一帧,必须开口(say=true):简短打个照面,顺带点评一句用户正在干的事(紧贴画面,别提足球除非真在看球)。给 JSON。`;
  }
  if (o.nudge) {
    return `刚才我说过(含废稿,全都不许重复):${hist}。${flavor}你已经好一阵没说话了,这帧就开口(say=true)轻声唠一句——紧贴画面里正在做/正在发生的事,给一句全新的。给 JSON。`;
  }
  return `刚才我说过(含废稿,全都不许重复):${hist}。${flavor}看现在这帧画面里用户在干嘛,有新东西/新进展/可乐的点就 say=true 来一句;若和刚才是同一件事同一个意思(哪怕换说法)→ say=false。评论只针对画面里真实有的东西。给 JSON。`;
}

async function viaQwen(image, homeTeam, history, opts) {
  const SYSTEM = buildSystem(opts && opts.persona, opts && opts.lang);
  const { media, b64 } = parseImage(image);
  const payload = {
    model: VLM_MODEL, max_tokens: 90, temperature: 0.7, messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: [
        { type: "image_url", image_url: { url: `data:${media};base64,${b64}` } },
        { type: "text", text: buildUser(homeTeam, history, opts) },
      ] },
    ] };
  const j = await request(
    { host: VLM_PROXY.host, path: VLM_PROXY.path, headers: { "X-Activation": (opts && opts.activation) || "" } },
    payload, 20000);
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  return normalizePlan(extractJson(msg.content || msg.reasoning_content || ""));
}

async function viaKimi(apiKey, image, homeTeam, history, opts) {
  const SYSTEM = buildSystem(opts && opts.persona, opts && opts.lang);
  const { media, b64 } = parseImage(image);
  const j = await request(
    { host: KIMI.host, path: KIMI.path, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
    { model: KIMI.model, max_tokens: 90, temperature: 0.7, system: SYSTEM, messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: media, data: b64 } },
        { type: "text", text: buildUser(homeTeam, history, opts) },
      ] },
    ] });
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return normalizePlan(extractJson(text));
}

async function commentate({ provider, kimiKey, image, homeTeam, history, first, nudge, persona, flavor, lang, activation }) {
  const plan = (provider === "k2.6" || provider === "kimi")
    ? await viaKimi(kimiKey, image, homeTeam, history, { first, nudge, persona, flavor, lang, activation })
    : await viaQwen(image, homeTeam, history, { first, nudge, persona, flavor, lang, activation });
  return plan || defaultMotion("browse", "calm", "idle", "");
}

async function testProvider({ provider, kimiKey, activation }) {
  if (provider === "k2.6" || provider === "kimi") {
    const j = await request({ host: KIMI.host, path: KIMI.path, headers: { "x-api-key": kimiKey, "anthropic-version": "2023-06-01" } },
      { model: KIMI.model, max_tokens: 8, messages: [{ role: "user", content: "说:ok" }] }, 15000);
    return Boolean(j);
  }
  const j = await request({ host: VLM_PROXY.host, path: VLM_PROXY.path, headers: { "X-Activation": activation || "" } },
    { model: VLM_MODEL, max_tokens: 5, temperature: 0, messages: [{ role: "user", content: "说ok" }] }, 15000);
  return Boolean(j);
}

module.exports = { commentate, testProvider };
