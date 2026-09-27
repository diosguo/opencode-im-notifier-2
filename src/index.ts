import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import type { Plugin } from "@opencode/plugin";
import type { NotifierConfig, NotificationMessage } from "./types.js";
import { sendDingTalk } from "./notifiers/dingtalk.js";
import { sendFeishu } from "./notifiers/feishu.js";
import { sendWeCom } from "./notifiers/wecom.js";

const PLUGIN_ID = "opencode-im-notifier";
const CONFIG_FILENAME = "opencode-im-notifier.jsonc";
const CONFIG_FILENAME_LEGACY = "opencode-im-notifier.json";
const DEFAULT_NOTIFY_ON = ["idle", "permission", "question", "error"] as const;

/**
 * Opt-in diagnostic log. Set OPENCODE_IM_NOTIFIER_DEBUG=/path/to/file to enable.
 * Disabled (no-op) by default so the plugin writes nothing in normal use.
 */
const DEBUG_FILE = process.env.OPENCODE_IM_NOTIFIER_DEBUG || "";
function debugLog(line: string): void {
  if (!DEBUG_FILE) return;
  void appendFile(DEBUG_FILE, `${new Date().toISOString()} ${line}\n`, "utf-8").catch(() => {});
}
debugLog("MODULE-LOAD");

/**
 * V2 instantiates the plugin once per loaded location, and every instance
 * subscribes to the same process-wide event stream. Without deduping, a single
 * logical event would be handled (and notified) once per instance. A global
 * (process-wide) recent-keys map makes only the first instance act on an event.
 */
const DEDUPE_KEY = Symbol.for("opencode-im-notifier.dedupe");
function isDuplicate(key: string, ttlMs = 10000): boolean {
  const store: Map<string, number> = ((globalThis as any)[DEDUPE_KEY] ??= new Map());
  const now = Date.now();
  for (const [k, t] of store) if (now - t > ttlMs) store.delete(k);
  if (store.has(key)) return true;
  store.set(key, now);
  return false;
}

/**
 * The V2 event envelope is a large discriminated union. We only consume a few
 * fields and must also tolerate legacy events that are not part of the generated
 * union, so handlers work against this minimal shape.
 */
interface PluginEvent {
  id?: string;
  type: string;
  created?: number;
  data?: Record<string, any>;
}

function parseJSONC(text: string): unknown {
  const stripped = text
    .split("\n")
    .map((line) => {
      // Remove full-line comments: optional whitespace then //
      line = line.replace(/^\s*\/\/.*$/, "");
      // Remove inline comments: // preceded by whitespace (avoid URLs like https://)
      line = line.replace(/(\s)\/\/.*$/, "$1");
      return line;
    })
    .join("\n");
  return JSON.parse(stripped);
}

function isQuietHours(quietHours?: { start: string; end: string }): boolean {
  if (!quietHours?.start || !quietHours?.end) return false;
  if (quietHours.start === quietHours.end) return false;

  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();

  const [sh, sm] = quietHours.start.split(":").map(Number);
  const [eh, em] = quietHours.end.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;

  if (start < end) {
    return cur >= start && cur < end;
  }
  return cur >= start || cur < end;
}

async function notifyAll(
  config: NotifierConfig,
  msg: NotificationMessage
): Promise<void> {
  debugLog(`NOTIFY-ATTEMPT ${msg.title}`);
  if (isQuietHours(config.quietHours)) return;

  const tasks: Array<{ platform: string; promise: Promise<void> }> = [];

  const dingEnabled = config.dingtalk && config.dingtalk.enable !== false;
  const feishuEnabled = config.feishu && config.feishu.enable !== false;
  const wecomEnabled = config.wecom && config.wecom.enable !== false;

  if (dingEnabled) {
    tasks.push({ platform: "dingtalk", promise: sendDingTalk(config.dingtalk!, msg) });
  }

  if (feishuEnabled) {
    tasks.push({ platform: "feishu", promise: sendFeishu(config.feishu!, msg) });
  }

  if (wecomEnabled) {
    tasks.push({ platform: "wecom", promise: sendWeCom(config.wecom!, msg) });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.promise));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const platform = tasks[i].platform;
      console.error(`[${PLUGIN_ID}] ${platform} notify failed:`, result.reason);
      debugLog(`NOTIFY-FAIL ${platform}: ${String(result.reason)}`);
    }
  });
  debugLog(`NOTIFY ${msg.title} -> platforms=${tasks.length}`);
  console.error(`[${PLUGIN_ID}] notify dispatched: ${msg.title} -> platforms=${tasks.length}`);
}

function formatTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function truncate(text: string, max = 100): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

async function loadConfigFile(path?: string): Promise<NotifierConfig | null> {
  if (!path) return null;
  try {
    const content = await readFile(path, "utf-8");
    return parseJSONC(content) as NotifierConfig;
  } catch {
    return null;
  }
}

function mergeConfig(fileCfg: NotifierConfig | null, inlineCfg: NotifierConfig): NotifierConfig {
  if (!fileCfg) return inlineCfg;
  return {
    dingtalk: inlineCfg.dingtalk ?? fileCfg.dingtalk,
    feishu: inlineCfg.feishu ?? fileCfg.feishu,
    wecom: inlineCfg.wecom ?? fileCfg.wecom,
    quietHours: inlineCfg.quietHours ?? fileCfg.quietHours,
    notifyOn: inlineCfg.notifyOn ?? fileCfg.notifyOn,
    title: inlineCfg.title ?? fileCfg.title,
  };
}

/** Render the fields of a V2 interactive form into markdown bullet lines. */
function formatFormFields(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  const lines: string[] = [];
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const f = field as { title?: string; key?: string; options?: Array<{ label?: string }> };
    const label = f.title || f.key;
    const options = Array.isArray(f.options)
      ? f.options.map((o) => o?.label).filter((v): v is string => Boolean(v))
      : [];
    if (options.length > 0) {
      lines.push(`- **${label || "选项"}**：${options.join(" / ")}`);
    } else if (label) {
      lines.push(`- **${label}**`);
    }
  }
  return lines;
}

const plugin = {
  id: PLUGIN_ID,

  async setup(ctx: Plugin.Context) {
    const inline = (ctx.options ?? {}) as NotifierConfig;

    // 加载配置文件：自定义路径 > 项目目录 / .opencode/ > 全局配置（支持 .jsonc 和 .json）
    const location = ctx.location as
      | { directory?: string; project?: { directory?: string } }
      | undefined;
    const dirs = Array.from(
      new Set(
        [location?.project?.directory, location?.directory].filter(
          (d): d is string => typeof d === "string" && d.length > 0
        )
      )
    );

    const candidates = [
      inline.configFile || null,
      ...dirs.flatMap((dir) => [
        join(dir, CONFIG_FILENAME),
        join(dir, CONFIG_FILENAME_LEGACY),
        join(dir, ".opencode", CONFIG_FILENAME),
        join(dir, ".opencode", CONFIG_FILENAME_LEGACY),
      ]),
      join(homedir(), ".config", "opencode", CONFIG_FILENAME),
      join(homedir(), ".config", "opencode", CONFIG_FILENAME_LEGACY),
    ].filter((p): p is string => Boolean(p));

    let fileCfg: NotifierConfig | null = null;
    for (const p of candidates) {
      fileCfg = await loadConfigFile(p);
      if (fileCfg) break;
    }

    // 如果没有任何配置文件，自动生成全局配置
    if (!fileCfg && !inline.dingtalk && !inline.feishu && !inline.wecom) {
      const globalPath = join(homedir(), ".config", "opencode", CONFIG_FILENAME);
      try {
        await mkdir(join(homedir(), ".config", "opencode"), { recursive: true });
        await writeFile(
          globalPath,
          [
            `{`,
            `  "dingtalk": {`,
            `    "enable": true,`,
            `    "webhook": "https://oapi.dingtalk.com/robot/send?access_token=你的token",`,
            `    "secret": "你的加签密钥（可选）"`,
            `  },`,
            `  "feishu": {`,
            `    "enable": true,`,
            `    "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/你的webhook"`,
            `  },`,
            `  "wecom": {`,
            `    "enable": true,`,
            `    "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key"`,
            `  },`,
            `  // 可选：静默时段，在此时间段内不发送通知`,
            `  // start / end 格式：HH:mm（24小时制），留空或相同表示不启用`,
            `  "quietHours": {`,
            `    "start": "",    // 例如 "23:00"`,
            `    "end": ""       // 例如 "09:00"`,
            `  },`,
            `  "notifyOn": ["idle", "permission", "question", "error"],`,
            `  "title": ""`,
            `}`,
          ].join("\n") + "\n",
          "utf-8"
        );
        console.error(`[${PLUGIN_ID}] config file created:`, globalPath);
      } catch {
        /* ignore */
      }
    }

    const config = mergeConfig(fileCfg, inline);
    const notifyOn = new Set<string>(config.notifyOn ?? [...DEFAULT_NOTIFY_ON]);
    const projectDir =
      location?.project?.directory || location?.directory || process.cwd();
    const projectTitle =
      config.title && config.title.trim() !== "" ? config.title : basename(projectDir);
    const machineInfo = hostname();

    console.error(
      `[${PLUGIN_ID}] setup: dir=${projectDir} notifyOn=${[...notifyOn].join(",")} ` +
        `feishu=${!!config.feishu} dingtalk=${!!config.dingtalk} wecom=${!!config.wecom} ` +
        `feishuEnabled=${config.feishu?.enable !== false}`
    );
    debugLog(
      `SETUP dir=${projectDir} notifyOn=${[...notifyOn].join(",")} ` +
        `feishu=${!!config.feishu} dingtalk=${!!config.dingtalk} wecom=${!!config.wecom}`
    );

    // 记录每个会话最近一次的用户提问，通知中附带，方便追溯上下文
    const lastUserQuestions = new Map<string, string>();
    const setLastQuestion = (sessionID: string | undefined, text: string) => {
      if (!sessionID || !text) return;
      lastUserQuestions.set(sessionID, truncate(text, 100));
    };
    const lastQuestionFor = (sessionID: string | undefined) =>
      (sessionID && lastUserQuestions.get(sessionID)) || "";

    // 空闲去重：同一会话短时间内（如 execution.succeeded 与 session.idle 同发）只通知一次
    const recentIdle = new Map<string, number>();
    // 出错后短时间内不再发送「执行完成」，避免同一次失败被重复通知
    const recentError = new Map<string, number>();

    const resolveSession = async (
      sessionID: string | undefined
    ): Promise<{ title: string; parentID?: string }> => {
      if (!sessionID) return { title: "" };
      try {
        const res = (await ctx.session.get({ sessionID })) as any;
        const info = res?.data ?? res;
        if (info) {
          return { title: info.title || sessionID, parentID: info.parentID };
        }
      } catch {
        /* fall through */
      }
      return { title: sessionID };
    };

    const onIdle = async (sessionID: string | undefined) => {
      if (!notifyOn.has("idle") || !sessionID) return;
      const now = Date.now();
      debugLog(
        `ONIDLE enter session=${sessionID} notifyOn=${notifyOn.has("idle")} errAge=${now - (recentError.get(sessionID) ?? 0)} idleAge=${now - (recentIdle.get(sessionID) ?? 0)}`
      );
      if (now - (recentError.get(sessionID) ?? 0) < 3000) return;
      if (now - (recentIdle.get(sessionID) ?? 0) < 2000) return;
      recentIdle.set(sessionID, now);

      const { title: sessionTitle, parentID } = await resolveSession(sessionID);
      debugLog(`ONIDLE resolved title=${sessionTitle} parentID=${parentID ?? ""}`);
      // 子 Agent 的完成通知会被跳过，避免干扰
      if (parentID) return;

      await notifyAll(config, {
        title: "✅ OpenCode 执行完成",
        content: [
          `### ✅ OpenCode 执行完成`,
          ``,
          lastQuestionFor(sessionID) ? `- **用户提问**：${lastQuestionFor(sessionID)}` : "",
          `- **项目**：${projectTitle}`,
          `- **会话**：${sessionTitle}`,
          `- **主机**：${machineInfo}`,
          `- **时间**：${formatTime()}`,
        ].filter(Boolean).join("\n"),
      });
    };

    const onError = async (sessionID: string | undefined, error: any) => {
      if (!notifyOn.has("error")) return;
      if (sessionID) recentError.set(sessionID, Date.now());

      const errType = error?.type ?? error?.name ?? "UnknownError";
      const errMsg = error?.message ?? error?.data?.message ?? JSON.stringify(error ?? {});

      const { title: sessionTitle, parentID } = await resolveSession(sessionID);
      // 子 Agent 的出错通知会被跳过
      if (parentID) return;

      await notifyAll(config, {
        title: "❌ OpenCode 执行出错",
        content: [
          `### ❌ OpenCode 执行出错`,
          ``,
          lastQuestionFor(sessionID) ? `- **用户提问**：${lastQuestionFor(sessionID)}` : "",
          `- **错误类型**：\`${errType}\``,
          `- **错误信息**：${errMsg}`,
          `- **项目**：${projectTitle}`,
          sessionTitle ? `- **会话**：${sessionTitle}` : "",
          `- **主机**：${machineInfo}`,
          `- **时间**：${formatTime()}`,
        ].filter(Boolean).join("\n"),
      });
    };

    const onPermission = async (data: Record<string, any>) => {
      if (!notifyOn.has("permission")) return;
      const sessionID = data.sessionID as string | undefined;
      const action = data.action as string | undefined;
      const resources = Array.isArray(data.resources) ? (data.resources as string[]) : [];
      const { title: sessionTitle } = await resolveSession(sessionID);

      await notifyAll(config, {
        title: "🔐 OpenCode 需要授权",
        content: [
          `### 🔐 OpenCode 需要授权`,
          ``,
          lastQuestionFor(sessionID) ? `- **用户提问**：${lastQuestionFor(sessionID)}` : "",
          action ? `- **操作**：\`${action}\`` : "",
          resources.length > 0 ? `- **资源**：\`${resources.join(" ")}\`` : "",
          data.message ? `- **说明**：${data.message}` : "",
          `- **项目**：${projectTitle}`,
          `- **会话**：${sessionTitle}`,
          `- **主机**：${machineInfo}`,
        ].filter(Boolean).join("\n"),
      });
    };

    // V2 使用交互式 form 向用户提问（旧版 question.asked 事件为兼容保留）
    const onForm = async (form: Record<string, any> | undefined) => {
      if (!notifyOn.has("question") || !form) return;
      const sessionID = form.sessionID as string | undefined;
      const { title: sessionTitle } = await resolveSession(sessionID);
      const fieldLines = formatFormFields(form.fields);

      await notifyAll(config, {
        title: "❓ OpenCode 正在询问",
        content: [
          `### ❓ OpenCode 正在询问`,
          ``,
          lastQuestionFor(sessionID) ? `- **用户提问**：${lastQuestionFor(sessionID)}` : "",
          form.title ? `- **问题**：${form.title}` : "",
          ...fieldLines,
          `- **项目**：${projectTitle}`,
          `- **会话**：${sessionTitle}`,
          `- **主机**：${machineInfo}`,
        ].filter(Boolean).join("\n"),
      });
    };

    const onLegacyQuestion = async (data: Record<string, any>) => {
      if (!notifyOn.has("question")) return;
      const questions = data.questions as
        | Array<{ header?: string; question?: string; options?: Array<{ label?: string }> }>
        | undefined;
      if (!Array.isArray(questions) || questions.length === 0) return;
      const q = questions[0];
      const sessionID = data.sessionID as string | undefined;
      const { title: sessionTitle } = await resolveSession(sessionID);
      const options = (q.options ?? []).map((o) => o.label).filter(Boolean).join(" / ");

      await notifyAll(config, {
        title: "❓ OpenCode 正在询问",
        content: [
          `### ❓ OpenCode 正在询问`,
          ``,
          lastQuestionFor(sessionID) ? `- **用户提问**：${lastQuestionFor(sessionID)}` : "",
          `- **问题**：${q.header || q.question || ""}`,
          options ? `- **选项**：${options}` : "",
          `- **项目**：${projectTitle}`,
          `- **会话**：${sessionTitle}`,
          `- **主机**：${machineInfo}`,
        ].filter(Boolean).join("\n"),
      });
    };

    // 这些事件会触发通知，需要跨实例去重（同一事件只由第一个实例处理一次）
    const NOTIFY_EVENTS = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.idle",
      "session.status",
      "permission.asked",
      "form.created",
      "question.asked",
    ]);

    const handleEvent = async (ev: PluginEvent) => {
      const data = ev.data ?? {};

      if (NOTIFY_EVENTS.has(ev.type)) {
        const key =
          ev.id ?? `${ev.type}:${data.sessionID ?? ""}:${ev.created ?? ""}:${JSON.stringify(data).slice(0, 80)}`;
        if (isDuplicate(key)) return;
        debugLog(`EVENT ${ev.type} ${JSON.stringify(data).slice(0, 300)}`);
      }

      switch (ev.type) {
        // V2 的真实完成事件（session.status / session.idle 在 2.x 中不再发出）
        case "session.execution.succeeded":
        case "session.idle":
          await onIdle(data.sessionID as string | undefined);
          return;
        case "session.execution.failed":
          await onError(data.sessionID as string | undefined, data.error);
          return;
        // 兼容：若后续版本恢复 session.status，仍按 idle 处理
        case "session.status": {
          const sessionID = data.sessionID as string | undefined;
          const status = data.status as { type?: string } | undefined;
          if (status?.type === "idle") await onIdle(sessionID);
          return;
        }
        case "permission.asked":
          await onPermission(data);
          return;
        case "form.created":
          await onForm(data.form as Record<string, any> | undefined);
          return;
        case "question.asked":
          await onLegacyQuestion(data);
          return;
        default:
          return;
      }
    };

    const controller = new AbortController();
    const disposers: Array<() => Promise<void> | void> = [];

    // 记录用户提问：V2 通过 session 的 prompt hook 捕获（替代 V1 的 chat.message）
    try {
      const registration = await ctx.session.hook("prompt", (input) => {
        try {
          const text = input?.prompt?.text ?? "";
          setLastQuestion(input?.sessionID, text);
        } catch (err) {
          console.error(`[${PLUGIN_ID}] prompt hook error:`, err);
        }
      });
      disposers.push(() => registration.dispose());
    } catch (err) {
      console.error(`[${PLUGIN_ID}] failed to register prompt hook:`, err);
    }

    // 订阅事件流（在后台运行，不阻塞 setup）
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break;
          try {
            await handleEvent(event as unknown as PluginEvent);
          } catch (err) {
            console.error(`[${PLUGIN_ID}] event handler error:`, err);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error(`[${PLUGIN_ID}] event stream error:`, err);
        }
      }
    })();

    return async () => {
      controller.abort();
      await Promise.allSettled(disposers.map((dispose) => Promise.resolve().then(dispose)));
    };
  },
} satisfies Plugin.Plugin;

export default plugin;
