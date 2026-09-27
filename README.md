# opencode-im-notifier-2

[![GitHub](https://img.shields.io/badge/GitHub-diosguo/opencode--im--notifier--2-181717?logo=github)](https://github.com/diosguo/opencode-im-notifier-2)

> ⚠️ **重要说明**：本项目是 [freakchick/opencode-im-notifier](https://github.com/freakchick/opencode-im-notifier) 的**二次开发改造**版本，主要目的是适配 **OpenCode 2.x** 版本。原始项目请访问 https://github.com/freakchick/opencode-im-notifier。

OpenCode 插件 — 当 OpenCode 执行完毕或需要用户确认时，自动发送通知到**钉钉**、**飞书**、**企业微信**群。

> 本插件面向 **OpenCode 2.x**（V2 插件 API，`@opencode/plugin`）。插件以 V2 约定的 `{ id, setup }` 形式导出。

## 功能

| 事件（OpenCode 2.x） | 触发时机 | 通知示例 |
|------|----------|----------|
| `session.execution.succeeded` | 会话执行完成（空闲） | ✅ OpenCode 执行完成 |
| `permission.asked` | 工具需要用户授权 | 🔐 OpenCode 需要授权 |
| `form.created`（兼容旧版 `question.asked`） | AI 通过交互表单向用户提问 | ❓ OpenCode 正在询问 |
| `session.execution.failed` | 执行出错 | ❌ OpenCode 执行出错 |

> OpenCode 2.0.18 实际发出的是 `session.execution.started/succeeded/failed`；`session.status` / `session.idle` 虽在事件 schema 中定义，但当前版本不会发出。插件以 `session.execution.succeeded` 作为"执行完成"信号，同时保留对 `session.status`/`session.idle` 的兼容处理。

额外特性：

- **用户提问追踪**：通过 V2 的 `session` prompt hook 自动记录每个会话最近一次用户提问，在通知中附带，方便追溯上下文
- **跨实例去重**：V2 会为每个已打开的位置各实例化一份插件，同一条事件会广播给所有实例；插件用进程内全局去重表保证同一条事件只发送一次通知（不会重复刷屏）
- **失败可见**：钉钉/飞书/企业微信即使返回 HTTP 200 也可能在响应体中报错，插件会解析响应体，失败时写入日志
- **静默时段**：可配置 `quietHours`，在指定时间段内不发送通知
- **子 Agent 过滤**：子 Agent（如 `@explore`）的执行完成和出错通知会被自动跳过，避免干扰；但子 Agent 的权限申请和用户提问仍会正常通知

> 排查问题时，可设置环境变量 `OPENCODE_IM_NOTIFIER_DEBUG=/path/to/log`（值为日志文件路径）后重启 OpenCode，插件会输出事件分发与发送结果到该文件；不设置则不产生任何日志。

> OpenCode 2.x 用统一的交互式表单（`form.created`）承载"提问"，因此 `question` 通知覆盖所有需要用户输入的表单（包括授权/引导表单）。如不需要，可将其从 `notifyOn` 中移除。

## 安装

本插件目前仅支持**本地安装**。先克隆仓库并编译：

```bash
git clone https://github.com/diosguo/opencode-im-notifier-2.git
cd opencode-im-notifier-2
npm install
npm run build
```

然后通过本地目录注册插件：

```bash
opencode plugin add /path/to/opencode-im-notifier-2
```

也可以手动在 `~/.config/opencode/opencode.json`（或项目的 `opencode.jsonc`）中注册，`plugins` 指向本地仓库目录：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-im-notifier-2"]
}
```

安装后会自动在 `~/.config/opencode/opencode-im-notifier.jsonc` 生成示例配置文件，编辑它填入你的 webhook 地址即可使用。

> 兼容说明：OpenCode 2.x 仍接受旧版 `plugin` 字段（`plugin: ["/path/to/opencode-im-notifier-2"]` 或 `plugin: [["/path/to/opencode-im-notifier-2", { ... }]]`），插件会同时支持这两种注册方式。

## 配置

配置有两种方式：**单独配置文件**（推荐）或 **opencode.jsonc 内联**。

### 方式一：单独配置文件（推荐）

在项目目录或全局配置目录创建 `opencode-im-notifier.jsonc`（也支持 `.json`）：

```jsonc
{
  "dingtalk": {
    "enable": true,
    "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
    "secret": "SEC..."
  },
  "feishu": {
    "enable": true,
    "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
  },
  "wecom": {
    "enable": true,
    "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
  },
  "notifyOn": ["idle", "permission", "question", "error"],
  "quietHours": {
    "start": "22:00",
    "end": "08:00"
  },
  "title": "我的项目"
}
```

然后 `opencode.jsonc` 只需要注册插件，不需要写配置：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-im-notifier-2"]
}
```

插件会自动按以下顺序查找配置文件（先找到的生效，`.jsonc` 与 `.json` 都会尝试）：

| 优先级 | 路径 |
|--------|------|
| 1 | `plugins` 选项中 `options.configFile` 指定的路径 |
| 2 | `{项目目录}/opencode-im-notifier.jsonc`（或 `.json`） |
| 3 | `{项目目录}/.opencode/opencode-im-notifier.jsonc`（或 `.json`） |
| 4 | `~/.config/opencode/opencode-im-notifier.jsonc`（或 `.json`） |

### 方式二：opencode.jsonc 内联

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-im-notifier-2",
      "options": {
        "dingtalk": {
          "enable": true,
          "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
          "secret": "SEC..."
        },
        "feishu": {
          "enable": true,
          "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
        },
        "wecom": {
          "enable": true,
          "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
        },
        "notifyOn": ["idle", "permission", "question"],
        "title": "我的项目"
      }
    }
  ]
}
```

> OpenCode 2.x 的 `plugins` 字段支持 `string | { package, options }`；旧版 `plugin` 字段（`["name"]` 或 `[["name", { ... }]]`）仍兼容。
> 内联配置优先级高于文件配置，两者同时存在时内联会覆盖文件中的对应字段。

### 配置说明

- **enable**：每个平台独立的开关，`true` 启用，`false` 关闭。不填时默认为 `true`
- **notifyOn**：全局控制哪些事件触发通知，可选值：`idle`、`permission`、`question`、`error`，默认全部
- **title**：通知中显示的项目名称，默认为项目目录名称
- **quietHours**：静默时段，在指定时间段内不发送通知。格式：`{ "start": "22:00", "end": "08:00" }`
- **configFile**：自定义配置文件路径，插件会优先读取该路径

### 最小配置（只用飞书）

`opencode-im-notifier.jsonc`:

```json
{
  "feishu": {
    "enable": true,
    "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
  }
}
```

## 通知格式

### 钉钉（markdown 消息）

```markdown
### ✅ OpenCode 执行完成

- **项目**：我的项目
- **会话**：修复登录页面样式
- **主机**：my-server
- **时间**：2026-06-04 10:30:00
```

### 飞书（交互式卡片）

头部标题 + markdown 正文（自动去掉 `###` 标题行避免重复），内容同上。

### 企业微信（markdown 消息）

```markdown
### ✅ OpenCode 执行完成

- **项目**：我的项目
- **会话**：修复登录页面样式
- **主机**：my-server
- **时间**：2026-06-04 10:30:00
```

## 通知示例

**执行完成：**

> ✅ OpenCode 执行完成
> 用户提问：实现用户登录功能
> 项目：my-app
> 会话：添加用户注册功能
> 主机：my-server
> 时间：2026-06-04 10:30:00

**需要授权：**

> 🔐 OpenCode 需要授权
> 用户提问：清理 node_modules
> 操作：bash
> 资源：rm -rf node_modules
> 项目：my-app
> 会话：清理依赖
> 主机：my-server

**正在询问：**

> ❓ OpenCode 正在询问
> 用户提问：设计 API 架构
> 问题：请选择实现方案
> 选项：REST API / GraphQL
> 项目：my-app
> 会话：设计 API 架构
> 主机：my-server

**执行出错：**

> ❌ OpenCode 执行出错
> 用户提问：部署到生产环境
> 错误类型：RuntimeError
> 错误信息：Connection refused
> 项目：my-app
> 会话：部署脚本
> 主机：my-server
> 时间：2026-06-04 10:30:00

## 获取 Webhook 地址

### 钉钉

1. 群设置 → 智能群助手 → 添加机器人 → 自定义
2. 复制 Webhook 地址
3. 如果开启安全设置中的「加签」，复制 Secret

### 飞书

1. 群设置 → 群机器人 → 添加机器人 → Webhook 机器人
2. 复制 Webhook 地址

### 企业微信

1. 群设置 → 群机器人 → 添加机器人 → 新机器人
2. 给机器人起名，复制 Webhook 地址

## 开发

```bash
# 安装依赖（@opencode/plugin 仅用于类型，编译后会被擦除）
npm install

# 编译
npm run build
```

本地测试：在 `opencode.json` 中通过绝对路径注册本目录（加载的是 `dist/index.js`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-im-notifier-2"]
}
```

> OpenCode 2.x 会读取插件目录的 `package.json` 并加载其入口（`dist/index.js`）。也可以直接使用 `opencode plugin add /path/to/opencode-im-notifier-2`。

### 项目结构

```
opencode-im-notifier/
├── opencode-im-notifier.example.json   # 示例配置文件
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts            # 插件入口（V2 { id, setup }，事件分发）
│   ├── types.ts            # 配置类型
│   └── notifiers/
│       ├── dingtalk.ts     # 钉钉机器人
│       ├── feishu.ts       # 飞书机器人
│       └── wecom.ts        # 企业微信机器人
└── dist/                   # 编译产物
```

## 技术细节

- 纯 TypeScript，运行时零外部依赖（仅使用 `@opencode/plugin` 的类型，编译后会被擦除）
- 使用原生 `fetch` 调用 webhook API
- 钉钉支持 HMAC-SHA256 签名校验
- 所有通知请求异步并行发送，不阻塞 OpenCode 事件处理
- 失败时仅打印错误日志，不会影响 OpenCode 正常运行
