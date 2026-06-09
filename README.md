# Qiuqiu Desktop Buddy

球球电脑搭子是一个 macOS 桌面悬浮数字人。它会按固定频率截取当前屏幕缩略图，调用用户自己的 Kimi API Key 做画面理解，再用系统语音和桌面角色给出轻量陪伴、提醒或体育场景解说。

> 当前是原型发布版：重点验证“桌面悬浮角色 + 屏幕理解 + 动作计划 + 系统语音”的产品形态。

## Download

- 版本：`0.9.1`
- 安装包：`dist/qiuqiu-desktop-buddy-0.9.1-arm64.dmg`
- GitHub Release 下载：`qiuqiu-desktop-buddy-0.9.1-arm64.dmg`

## Features

- 桌面悬浮、透明窗口、置顶显示。
- 用户自带 Kimi API Key，不内置任何云端密钥。
- 主进程代理 Kimi 请求，避免浏览器 CORS 问题。
- 屏幕缩略图理解：办公、阅读、浏览、视频、游戏、体育等场景。
- 动作计划：Kimi 输出情绪、动作、显隐、特效，前端执行角色反馈。
- 系统语音播报，不需要额外 TTS 服务。
- 试音按钮，方便排查 macOS 系统语音是否可用。
- 鼠标穿透、窗口召回、暂停/退出、历史统计。

## Usage

1. 打开 `.dmg` 或直接运行 `.app`。
2. 首次启动会打开设置面板。
3. 在 `Kimi API Key` 输入框填入自己生成的 Key（去 platform.moonshot.cn 自助生成），点击“保存”。这是唯一需要填的东西。
4. 可点击“测试”确认 Key 可用。
5. 首次开始时，按提示在“系统设置 → 隐私与安全性 → 屏幕录制”里勾选本应用并重开（否则看不到屏幕内容）。
6. 点击右上角播放按钮开始陪伴。

> 服务端点已内置：看屏理解走 Kimi（用你填的 Key），语音走内置 CosyVoice，无需配置任何地址。

## 快捷键

- `Cmd+Shift+K`：切换鼠标穿透。
- `Cmd+Shift+P`：开始或暂停。
- `Cmd+Shift+J`：把窗口召回到主屏右上角，并取消穿透。

## 行为逻辑

- 日常默认是“电脑搭子”，不会主动强调足球。
- 只有屏幕识别为体育或球赛场景时，才切换到看球模式和足球造型。
- 写代码、看文档、阅读长文时会降低打扰频率，并保持可见可点，不再隐身。
- 历史和统计保存在本机 `localStorage`。
- Kimi Key 保存在 Electron 的本机 `userData/config.json`。

## 隐私边界

本应用会在运行时截取屏幕缩略图，并发送给 Kimi API 做画面理解。不要在处理敏感资料时开启陪伴；可随时暂停或退出。

Kimi Key 只保存在本机 Electron `userData/config.json`，不会提交到仓库，也不会写入 Release 包。

## Project Status

这是一个 Claude Code 风格的公开原型项目：源码可读、Release 可下载、README 可直接上手。当前不承诺生产级安全、签名、公证或跨平台兼容。

## 开发

```bash
npm install
npm run dev
```

## 打包

```bash
npm run pack
npm run dmg
```

## Third-Party Notice

项目内包含 Electron、PixiJS、Live2D Cubism runtime 及示例模型相关文件。它们遵循各自许可证或 EULA；本仓库的 MIT License 只覆盖本项目原创代码。

