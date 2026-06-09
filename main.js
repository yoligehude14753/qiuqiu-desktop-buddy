const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const kimi = require("./kimi");

let win = null;
let clickThrough = false;

// 语音:CosyVoice2(longxiaochun_v2),与 6/7 北京腔版同款音色。
// 桌面版连不了 heyi 的 localhost,走 Cloudflare 公网网关(实测 ~2s),音频随解说一起返回(声画同到)。
const TTS = {
  url: "https://tts2.yoliyoli.uk",
  model: "cosyvoice-v2",
  voice: "longxiaochun_v2",
  token: "__GATEWAY_TOKEN_REMOVED__",
};
function synthSpeech(text) {
  return new Promise((resolve, reject) => {
    if (!text) return resolve(null);
    const target = new URL(TTS.url.replace(/\/+$/, "") + "/v1/audio/speech");
    const lib = target.protocol === "https:" ? https : http;
    const body = JSON.stringify({ model: TTS.model, input: text, voice: TTS.voice, response_format: "mp3" });
    const req = lib.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TTS.token}`, "Content-Length": Buffer.byteLength(body) },
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
ipcMain.handle("capture-screen", async () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  // 抓取时缩放,降带宽;最大边 ~1280
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    },
  });
  if (!sources.length) return null;
  // 默认抓主屏(第一个)
  return sources[0].thumbnail.toDataURL();
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
ipcMain.handle("get-config", () => ({ kimiKey: userConfig.kimiKey || "", hasKey: !!userConfig.kimiKey }));
ipcMain.handle("set-config", (e, patch) => {
  userConfig = Object.assign({}, userConfig, patch || {});
  saveConfig(userConfig);
  return { ok: true, hasKey: !!userConfig.kimiKey };
});
ipcMain.handle("test-key", async (e, arg) => {
  const provider = (arg && arg.provider) || "qwen3";
  const key = (arg && arg.key) || (typeof arg === "string" ? arg : "") || userConfig.kimiKey;
  try { await kimi.testProvider({ provider, kimiKey: key }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// ---- Kimi 代理:看屏解说 / 主动说话(在主进程发请求,避开浏览器 CORS) ----
ipcMain.handle("commentate", async (e, { image, homeTeam, history, provider }) => {
  const prov = provider || "qwen3";
  if (prov === "k2.6" && !userConfig.kimiKey) return { error: "no_key" };
  try {
    const plan = await kimi.commentate({ provider: prov, kimiKey: userConfig.kimiKey, image, homeTeam, history });
    let audio = null;
    if (plan && plan.comment) { try { audio = await synthSpeech(plan.comment); } catch (_) {} }
    return { plan, audio };
  } catch (err) { return { error: String(err.message || err) }; }
});

app.whenReady().then(() => {
  userConfig = loadConfig();
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
