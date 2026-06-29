# AI Workspace

Windows 统一办公工作台（Electron）：常用网页、内嵌终端、本地应用一键启动。

## 功能

- **常用网页**：最多 8 个，标题栏右侧 ⚙️ 配置
- **内置终端**：PowerShell、Git Bash
- **本地应用**：标题栏右侧 ⚙️ 自定义启动路径
- **主题设置**：6 种配色，点击左上角 🎨 切换

## 启动

```bash
npm install
npm start
```

## 配置

### 常用网页

- 应用内点击「常用网页」右侧 ⚙️
- 数据保存在：`%APPDATA%/ai-workspace/websites.json`

### 本地应用

- 应用内点击「本地应用」右侧 ⚙️
- 数据保存在：`%APPDATA%/ai-workspace/local-apps.json`
- 每项只需：**名称** + **启动路径**（exe 或 .lnk 的完整路径）

### 主题

- 点击左上角 **🎨** 选择主题，立即生效
- 保存在：`%APPDATA%/ai-workspace/settings.json`
- 可选主题见 `config/themes.json`（可自行增改）

## 说明

- 本地应用以外部窗口启动，无法内嵌
- 若之前已运行过旧版本，可删除 `%APPDATA%/ai-workspace/local-apps.json` 以重新加载默认应用列表
