# WhatsApp 资金管理机器人 2.0

基于 Electron + Node.js + whatsapp-web.js 的 Windows 桌面应用，在 WhatsApp 群内进行资金记账、查账与撤回。

账本使用 `capital.json`（JSON 原子落盘），**不依赖 SQLite**，普通用户安装后无需 Node.js、npm、Python 或编译工具。

## 功能概览

- WhatsApp Web 扫码登录，session 本地持久化，下次自动恢复
- 群内命令：加减乘除记账、查账、撤回、清账、帮助
- 低延迟消息入口、按群公平调度、异步日志、发送队列
- 桌面控制台：仪表板 / 日志 / 配置 / 帮助
- 运行数据统一写入 Electron `userData`，安装目录只读
- 支持从旧版项目根目录 `data/` 安全迁移（复制，不删除旧文件）

## 给最终用户：安装使用

1. 安装并运行发布包（推荐）：
   - `dist-release/WhatsApp-Fund-Robot-2.0.0-x64-Setup.exe`
   - 或便携版：`WhatsApp-Fund-Robot-2.0.0-x64-Portable.exe`
2. 系统需已安装 **Microsoft Edge**（Win10/11 通常自带）或 **Google Chrome**
3. 首次启动：用手机 WhatsApp 扫描二维码登录
4. 在应用「配置」页填写管理员（显示名、`~显示名` 或 WhatsApp LID/号码），保存后生效
5. 在目标群内发送命令即可记账

普通用户权限即可安装与运行（不要求管理员 UAC）。卸载时默认保留用户账本与 session。

### 用户数据目录

默认位置（Windows）：

```text
C:\Users\<用户名>\AppData\Roaming\whatsapp-robot-2.0\
├── data\
│   ├── capital.json
│   ├── session-whatsapp-bot-v2\
│   └── backups\
├── config\
│   └── config.json
├── logs\
└── migration-v2.json
```

可用环境变量覆盖数据根目录（开发/测试用）：

```powershell
$env:WHATSAPP_ROBOT_DATA_DIR="D:\WhatsAppRobot-TestData"
npm start
```

## 群内命令

| 命令 | 说明 |
|------|------|
| `+100` / `-50` / `*2` / `/3` | 简单运算记账 |
| `+100#备注` | 带注释记账 |
| `+1+2*3` | 复合表达式 |
| `查账` 或 `/查账` | 查看余额与最近操作 |
| `撤回` 或 `/撤回` | 撤回最近一次操作 |
| `清账` 或 `/清账` | 清空该群账本与历史 |
| `帮助` 或 `/帮助` | 显示帮助 |

仅配置中的管理员可执行记账类命令。

## 开发环境

### 要求

- Windows 10/11
- Node.js 18+
- Microsoft Edge 或 Google Chrome
- 可选：本地 whatsapp-web.js 仓库（开发时可用 Junction）

### 安装与启动

```powershell
cd D:\Whatsapp-Robot
npm install
npm start
```

或运行 `start.bat`。

开发模式（打开 DevTools）：

```powershell
npm run dev
```

> 注意：若 `node_modules/whatsapp-web.js` 是指向本地仓库的 Junction，在开发区执行 `npm install` / `npm ci` 可能覆盖该链接。发布请用下方隔离构建命令。

### 项目结构（核心）

```text
Whatsapp-Robot/
├── main.js                 # Electron 主进程
├── bot.js                  # WhatsApp 机器人与启动逻辑
├── preload.js / renderer.js / index.html / styles.css
├── lib/
│   ├── runtime-paths.js    # 统一 userData 路径
│   ├── migrate-legacy.js   # 旧 data 迁移
│   ├── json-capital-store.js
│   ├── command-engine.js
│   ├── classify.js
│   └── runtime-core.js
├── resources/defaults/     # 空账本/配置模板（无真实用户数据）
├── scripts/
│   ├── build-release.ps1   # 正式 Windows 发布
│   └── prepare-release-deps.js
├── test/                   # 性能测试与打包/迁移测试
└── data/                   # 开发期本地数据（不会打进安装包）
```

### 测试

```powershell
npm test                 # 性能 + 迁移 + 打包配置 + 样式资源
npm run test:migration   # 仅迁移
npm run bench            # 仅性能基准
```

## 打包发布（Windows）

**请使用隔离发布脚本**，将 whatsapp-web.js 打成 tarball 装入临时目录再构建，避免把开发机 Junction 打进安装包：

```powershell
cd D:\Whatsapp-Robot
npm run release:win
```

产物目录：`dist-release\`

| 文件 | 说明 |
|------|------|
| `WhatsApp-Fund-Robot-2.0.0-x64-Setup.exe` | NSIS 安装版（发给用户优先用这个） |
| `WhatsApp-Fund-Robot-2.0.0-x64-Portable.exe` | 便携版 |

不要在开发区直接执行 `npm run dist:all` 作为正式发布方式（可能仍依赖本机 `D:\whatsapp-web.js`）。

安装包不会包含：真实 `capital.json`、session、开发日志、SQLite 文件。

## 配置说明

运行时配置文件位于用户目录：

`%AppData%\whatsapp-robot-2.0\config\config.json`

也可在应用「配置」页编辑。主要字段：

```json
{
  "version": "2.0.0",
  "adminIds": ["显示名", "~显示名", "LID或号码"],
  "maxHistoryRecords": 1000,
  "autoBackup": true
}
```

全新安装会从 `resources/defaults/` 初始化空账本与空管理员列表，需自行添加管理员后才能记账。

## 旧版数据迁移

启动时会在创建 WhatsApp Client 之前尝试迁移旧 `data/`（**复制，不删除**）。

候选旧目录包括：Portable EXE 所在目录及其项目父目录下的 `data`、当前工作目录 `data`、安装目录旁 `data`、`resources/data` 等。可以用 `WHATSAPP_ROBOT_LEGACY_DATA_DIR` 显式指定旧数据目录。

对当前项目结构，将 Portable EXE 放在 `dist-release/` 内直接启动，会自动发现项目根目录的 `data/`。迁移前请先退出脚本启动的机器人，避免两个进程同时登录 WhatsApp。

规则摘要：

- `capital.json` 和 `config.json` 在新目录不存在时直接复制
- EXE 只有空账本/默认配置时 → 先备份新文件，再迁入脚本数据
- EXE 已有真实数据时 → 保留 EXE 数据，将旧文件保存为 `*.legacy-conflict-*` 供人工核对
- EXE 文件损坏 → 先备份损坏文件，报错停止，不自动覆盖
- session 仅在新目录不存在或为空时复制；两套 session 都存在时保留 EXE 会话，不合并 Chromium 数据
- 成功后写入版本 3 的迁移状态；为兼容旧版，文件名仍为 `migration-v2.json`

## 故障排除

### 未找到浏览器 / Failed to launch the browser process

- 确认已安装 Edge 或 Chrome
- 应用会优先 Edge，失败时自动重试并回退 Chrome
- 若首次启动偶发失败，关掉再开一次；新版本已加入锁文件清理与重试

### WhatsApp 一直要扫码

- 检查 `%AppData%\...\data\session-whatsapp-bot-v2` 是否被清理
- 确认没有第二个实例争用同一 session（应用已启用单实例锁）

### 提示无权限 / UNAUTHORIZED

- 在配置中加入你的 WhatsApp **显示名**、LID 或号码后保存
- 名称需与群内推送名匹配（可同时配置带 `~` 的形式）

### 界面没有样式

- 请使用 `npm run release:win` 产出的安装包；确认包内含 `styles.css`

### 日志位置

`%AppData%\whatsapp-robot-2.0\logs\`

应用内「日志」页也可查看。

## 脚本速查

| 命令 | 用途 |
|------|------|
| `npm start` | 开发启动 |
| `npm run dev` | 开发启动 + DevTools |
| `npm test` | 测试 |
| `npm run release:win` | **正式打包（推荐）** |
| `npm run dist:win` | 仅本机构建 NSIS（非正式发布路径） |

## 许可与合规

请遵守 WhatsApp 使用条款，仅在授权群组内合理使用。

---

版本：2.0.0
