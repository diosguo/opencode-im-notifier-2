import type { FeishuConfig, NotificationMessage } from "../types.js";

export async function sendFeishu(
  config: FeishuConfig,
  msg: NotificationMessage
): Promise<void> {
  const body = {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: msg.title },
      },
      elements: [
        {
          tag: "markdown",
          content: msg.content.replace(/^### .+\n\n?/, ""),
        },
      ],
    },
  };

  const res = await fetch(config.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Feishu webhook error ${res.status}: ${text}`);
  }

  // Feishu returns HTTP 200 even when the request is rejected; inspect the body.
  let code: unknown;
  let message = "";
  try {
    const json = JSON.parse(text) as { code?: unknown; StatusCode?: unknown; msg?: string; StatusMessage?: string };
    code = json.code ?? json.StatusCode;
    message = json.msg ?? json.StatusMessage ?? "";
  } catch {
    return; // non-JSON body with 2xx: assume success
  }
  if (code !== undefined && code !== 0) {
    throw new Error(`Feishu webhook rejected (code=${String(code)}): ${message || text}`);
  }
}
