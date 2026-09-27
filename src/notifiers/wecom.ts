import type { WeComConfig, NotificationMessage } from "../types.js";

export async function sendWeCom(
  config: WeComConfig,
  msg: NotificationMessage
): Promise<void> {
  const body = {
    msgtype: "markdown",
    markdown: {
      content: msg.content,
    },
  };

  const res = await fetch(config.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WeCom webhook error ${res.status}: ${text}`);
  }

  // WeCom returns HTTP 200 even when the request is rejected; inspect the body.
  let errcode: unknown;
  let errmsg = "";
  try {
    const json = JSON.parse(text) as { errcode?: unknown; errmsg?: string };
    errcode = json.errcode;
    errmsg = json.errmsg ?? "";
  } catch {
    return;
  }
  if (errcode !== undefined && errcode !== 0) {
    throw new Error(`WeCom webhook rejected (errcode=${String(errcode)}): ${errmsg || text}`);
  }
}
