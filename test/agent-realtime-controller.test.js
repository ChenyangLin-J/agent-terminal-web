import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("a draft can launch its Session before Realtime becomes enabled", async () => {
  const source = await readFile(new URL("../public/agent-realtime.js", import.meta.url), "utf8");
  const browser = { AgentRealtime: null };
  const document = { createElement: () => fakeElement() };
  vm.runInNewContext(source, {
    window: browser,
    document,
    Float32Array,
    Uint8Array,
    DataView,
  });

  const launchButton = fakeElement();
  const dialog = fakeElement();
  const startButton = fakeElement();
  const statusElement = fakeElement();
  const sent = [];
  let activations = 0;
  const controller = browser.AgentRealtime.create({
    launchButton,
    dialog,
    dismissButton: fakeElement(),
    startButton,
    stopButton: fakeElement(),
    fallbackButton: fakeElement(),
    voiceSelect: Object.assign(fakeElement(), { value: "marin" }),
    statusElement,
    transcriptElement: fakeElement(),
    errorElement: fakeElement(),
    send: (message) => {
      sent.push(message);
      return true;
    },
    activateSession: () => {
      activations += 1;
      return true;
    },
  });

  controller.install();
  assert.equal(launchButton.disabled, true);

  controller.setLaunchable(true);
  assert.equal(launchButton.disabled, false);
  launchButton.click();

  assert.equal(dialog.open, true);
  assert.equal(activations, 1);
  assert.equal(controller.isPreparing(), true);
  assert.equal(statusElement.textContent, "正在创建 Session…");
  assert.equal(startButton.disabled, true);
  assert.deepEqual(sent, []);

  controller.setLaunchable(false);
  controller.setEnabled(true);

  assert.equal(controller.isPreparing(), false);
  assert.equal(statusElement.textContent, "尚未开始");
  assert.equal(startButton.disabled, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "realtime-voices");
});

function fakeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    disabled: false,
    open: false,
    value: "",
    textContent: "",
    dataset: {},
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    click() {
      listeners.get("click")?.({ target: this });
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    replaceChildren(...children) {
      this.children = children;
    },
  };
}
