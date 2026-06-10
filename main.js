const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const kimi = require("./kimi");

// 激活码门禁:用户拿到我们签发的一个 Key 才能用(底层模型/网关 token 已封装,不对外暴露用法)。
// 代码里只存 SHA-256 哈希,明文激活码线下发放。
// 全员通用激活码:明文不入库(线下发放),这里只存 SHA-256 哈希。
const ACTIVATION_HASHES = new Set([
  "a6e7a760740c9afa1b1273ff11ad1341d3043dcc7ad1248c63c35639bd6302e1",
]);
function sha256(s) { return crypto.createHash("sha256").update(String(s).trim()).digest("hex"); }
function isActivated() { return !!(userConfig.activation && ACTIVATION_HASHES.has(sha256(userConfig.activation))); }

let win = null;
let clickThrough = false;

// 语音:CosyVoice2(longxiaochun_v2),经后端代理(激活码鉴权),app 不含任何 token。
const TTS = { host: "llm.yoliyoli.uk", path: "/qiuqiu/tts/v1/audio/speech", model: "cosyvoice-v2", voice: "longxiaochun_v2" };
function synthSpeech(text) {
  return new Promise((resolve, reject) => {
    if (!text) return resolve(null);
    const body = JSON.stringify({ model: TTS.model, input: text, voice: TTS.voice, response_format: "mp3" });
    const req = https.request({
      hostname: TTS.host, path: TTS.path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Activation": userConfig.activation || "" },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`TTS ${res.statusCode}`));
        const type = res.headers["content-type"] || "audio/mpeg";
        resolve(`data:${type};base64,${buf.toString("base64")}`);
      });
    });
    req.on("timeout", () => req.destroy(new Error("TTS 超时")));
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// ---- 用户配置(存到 userData/config.json),含 Kimi Key ----
function configPath() { return path.join(app.getPath("userData"), "config.json"); }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); }
  catch (_) { return { kimiKey: "" }; }
}
function saveConfig(cfg) {
  try { fs.mkdirSync(app.getPath("userData"), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); return true; }
  catch (e) { console.error("保存配置失败", e); return false; }
}
let userConfig = { kimiKey: "" };

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const W = 320, H = 460;

  win = new BrowserWindow({
    width: W,
    height: H,
    x: sw - W - 24,
    y: 80,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 始终浮在最上层(包括全屏应用之上)
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// 召回:把窗口拉回主屏右上角、取消穿透、置顶并高亮,解决"找不到/点不到"。
function recallWindow() {
  if (!win) return;
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const [W, H] = win.getSize();
  win.setPosition(sw - W - 24, 80);
  setClickThrough(false);
  win.setAlwaysOnTop(true, "screen-saver");
  win.show();
  win.focus();
  win.webContents.send("recalled");
}

function setClickThrough(value) {
  clickThrough = Boolean(value);
  if (!win) return;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  win.webContents.send("click-through-changed", clickThrough);
}

function toggleClickThrough() {
  setClickThrough(!clickThrough);
}

// 渲染进程请求抓全屏 → 返回一帧 dataURL
// ~900px + JPEG:实测 1280 PNG 在 Qwen3-VL 上要 6-13s,900 JPEG 只要 ~2s,质量足够读清。
ipcMain.handle("capture-screen", async () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  const scale = Math.min(1, 900 / Math.max(width, height));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    },
  });
  if (!sources.length) return null;
  const jpeg = sources[0].thumbnail.toJPEG(75);
  return "data:image/jpeg;base64," + jpeg.toString("base64");
});

// 运行日志:写到 userData/buddy.log(自动截断),排查"说了啥/多快/为什么不说"。
function logPath() { return path.join(app.getPath("userData"), "buddy.log"); }
ipcMain.on("buddy-log", (e, line) => {
  try {
    const f = logPath();
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    fs.appendFileSync(f, `${stamp} ${String(line).slice(0, 400)}\n`);
    if (fs.statSync(f).size > 256 * 1024) fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(-128 * 1024));
  } catch (_) {}
});

// 鼠标穿透开关(气泡区域可点,数字人区域可拖)
ipcMain.on("set-ignore-mouse", (e, ignore) => {
  setClickThrough(ignore);
});

ipcMain.on("toggle-click-through", () => toggleClickThrough());
ipcMain.on("toggle-running", () => {
  if (win) win.webContents.send("toggle-running");
});
ipcMain.on("quit-app", () => app.quit());

// ---- 配置:读 / 写 / 测 Key ----
ipcMain.handle("get-config", () => ({ kimiKey: userConfig.kimiKey || "", hasKey: !!userConfig.kimiKey, version: app.getVersion(), activated: isActivated() }));
ipcMain.handle("set-config", (e, patch) => {
  userConfig = Object.assign({}, userConfig, patch || {});
  saveConfig(userConfig);
  return { ok: true, hasKey: !!userConfig.kimiKey, activated: isActivated() };
});
ipcMain.handle("test-key", async (e, arg) => {
  const provider = (arg && arg.provider) || "qwen3";
  const key = (arg && arg.key) || (typeof arg === "string" ? arg : "") || userConfig.kimiKey;
  try { await kimi.testProvider({ provider, kimiKey: key, activation: userConfig.activation }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// ---- Kimi 代理:看屏解说 / 主动说话(在主进程发请求,避开浏览器 CORS) ----
ipcMain.handle("commentate", async (e, { image, homeTeam, history, provider, first, nudge, persona, flavor, lang }) => {
  const prov = provider || "qwen3";
  if (!isActivated()) return { error: "not_activated" };
  if (prov === "k2.6" && !userConfig.kimiKey) return { error: "no_key" };
  try {
    // 立即返回 plan,语音由渲染层另发请求并行合成——别让 TTS 拖慢下一轮看屏
    return { plan: await kimi.commentate({ provider: prov, kimiKey: userConfig.kimiKey, image, homeTeam, history, first, nudge, persona, flavor, lang }) };
  } catch (err) { return { error: String(err.message || err) }; }
});

ipcMain.handle("synth-speech", async (e, { text }) => {
  if (!isActivated()) return { error: "not_activated" };
  try { return { audio: await synthSpeech(text) }; }
  catch (err) { return { error: String(err.message || err) }; }
});

app.whenReady().then(() => {
  userConfig = loadConfig();
  // 启动时记录版本与启动方式,排查"跑的是哪个构建"
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString().replace("T", " ").slice(0, 19)} === app v${app.getVersion()} started (packaged=${app.isPackaged}) ===\n`);
  } catch (_) {}
  createWindow();
  globalShortcut.register("CommandOrControl+Shift+K", toggleClickThrough);
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (win) win.webContents.send("toggle-running");
  });
  globalShortcut.register("CommandOrControl+Shift+J", recallWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 再次双击/启动:把已有窗口召回到前台;窗口丢了就重建。
app.on("second-instance", () => {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  recallWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
