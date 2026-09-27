import { createHmac } from "node:crypto";
import type { DingTalkConfig, NotificationMessage } from "../types.js";

function sign(timestamp: number, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}\n${secret}`);
  return encodeURIComponent(hmac.digest("base64"));
}

export async function sendDingTalk(
  config: DingTalkConfig,
  msg: NotificationMessage
): Promise<void> {
  let url = config.webhook;

  if (config.secret) {
    const timestamp = Date.now();
    url += `&timestamp=${timestamp}&sign=${sign(timestamp, config.secret)}`;
  }

  const body = {
    msgtype: "markdown",
    markdown: {
      title: msg.title,
      text: msg.content,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DingTalk webhook error ${res.status}: ${text}`);
  }

  // DingTalk returns HTTP 200 even when the request is rejected; inspect the body.
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
    throw new Error(`DingTalk webhook rejected (errcode=${String(errcode)}): ${errmsg || text}`);
  }
}
