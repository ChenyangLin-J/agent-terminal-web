const STEER_HEADER = /^【追加要求 #\d+｜不替换前面的要求】$/;
const STEER_FOOTER = "请把它加入当前任务；原始请求和此前追加仍需一起完成。最终答复前逐项核对。";
const QUEUE_HEADER = "【下一轮任务｜当前任务完成后再做】";
const LATE_HEADER = "【追加要求到达时上一轮刚刚结束｜作为下一轮继续】";
const LATE_FOOTER = "请结合上一轮的原始请求和所有追加要求，只补做尚未覆盖的内容。";

/** Removes only product-owned follow-up wrappers from a native user message. */
export function presentAppServerUserText(value) {
  const blocks = String(value || "").split("\n\n");
  if (STEER_HEADER.test(blocks[0] || "") && blocks.at(-1) === STEER_FOOTER) {
    return blocks.slice(1, -1).join("\n\n");
  }
  if (blocks[0] === QUEUE_HEADER) return blocks.slice(1).join("\n\n");
  if (blocks[0] === LATE_HEADER && blocks.at(-1) === LATE_FOOTER) {
    return blocks.slice(1, -1).join("\n\n");
  }
  return String(value || "");
}
