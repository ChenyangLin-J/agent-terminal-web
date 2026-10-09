import assert from "node:assert/strict";
import test from "node:test";

import { presentAppServerUserText } from "../lib/app-server-user-message.js";

test("product follow-up wrappers are hidden without changing the user text", () => {
  const original = "第一段\n\n第二段\n带换行";
  assert.equal(
    presentAppServerUserText(`【追加要求 #2｜不替换前面的要求】\n\n${original}\n\n请把它加入当前任务；原始请求和此前追加仍需一起完成。最终答复前逐项核对。`),
    original,
  );
  assert.equal(presentAppServerUserText(`【下一轮任务｜当前任务完成后再做】\n\n${original}`), original);
  assert.equal(
    presentAppServerUserText(`【追加要求到达时上一轮刚刚结束｜作为下一轮继续】\n\n${original}\n\n请结合上一轮的原始请求和所有追加要求，只补做尚未覆盖的内容。`),
    original,
  );
});

test("unwrapped text, reference envelopes, and attachment-only content remain intact", () => {
  const reference = "普通问题\n\n<session-reference>{\"id\":\"ref-1\"}</session-reference>";
  assert.equal(presentAppServerUserText(reference), reference);
  assert.equal(presentAppServerUserText(""), "");
});
