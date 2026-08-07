import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("a draft can launch its Session before Realtime becomes enabled", async () => {
  const source = await readFile(new URL("../public/agent-realtime.js", import.meta.url), "utf8");
  const browser = { AgentRealtime: null, setTimeout, clearTimeout };
  const document = { createElement: () => fakeElement() };
  const inputTrack = { stopped: false, stop() { this.stopped = true; } };
  const inputStream = {
    getAudioTracks: () => [inputTrack],
    getTracks: () => [inputTrack],
  };
  let peerConnection = null;
  class FakePeerConnection {
    constructor() {
      peerConnection = this;
      this.iceGatheringState = "complete";
      this.signalingState = "stable";
      this.connectionState = "new";
    }
    addTrack(track, stream) {
      this.addedTrack = track;
      this.addedStream = stream;
    }
    createDataChannel(label) {
      this.dataChannel = { label, close() {} };
      return this.dataChannel;
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=fake-offer" };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
      this.signalingState = "have-local-offer";
    }
    async setRemoteDescription(description) {
      if (this.remoteDescriptionGate) await this.remoteDescriptionGate.promise;
      this.remoteDescription = description;
      this.signalingState = "stable";
    }
    close() {
      this.signalingState = "closed";
    }
  }
  vm.runInNewContext(source, {
    window: browser,
    document,
    navigator: { mediaDevices: { getUserMedia: async () => inputStream } },
    RTCPeerConnection: FakePeerConnection,
    Float32Array,
    Uint8Array,
    DataView,
  });

  const launchButton = fakeElement();
  const dialog = fakeElement();
  const startButton = fakeElement();
  const stopButton = fakeElement();
  const statusElement = fakeElement();
  const voiceSelect = Object.assign(fakeElement(), { value: "juniper" });
  const sent = [];
  let activations = 0;
  const controller = browser.AgentRealtime.create({
    launchButton,
    dialog,
    dismissButton: fakeElement(),
    startButton,
    stopButton,
    fallbackButton: fakeElement(),
    voiceSelect,
    statusElement,
    transcriptElement: fakeElement(),
    errorElement: fakeElement(),
    outputAudio: fakeElement(),
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

  controller.handleMessage("realtime-voices", {
    voices: ["marin", "cedar"],
    defaultVoice: "marin",
  });
  assert.equal(voiceSelect.value, "juniper");
  assert.deepEqual(
    voiceSelect.children.map((option) => option.value),
    ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"],
  );

  await startButton.click();
  const startMessage = sent.at(-1);
  assert.equal(startMessage.type, "realtime-start");
  assert.equal(startMessage.voice, "juniper");
  assert.equal(startMessage.transport.type, "webrtc");
  assert.equal(startMessage.transport.sdp, "v=0\r\no=fake-offer");
  assert.equal(peerConnection.dataChannel.label, "oai-events");
  assert.equal(peerConnection.addedTrack, inputTrack);

  controller.handleMessage("realtime-sdp", { sdp: "v=0\r\no=fake-answer" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.remoteDescription.type, "answer");
  assert.equal(peerConnection.remoteDescription.sdp, "v=0\r\no=fake-answer");

  controller.handleMessage("realtime-state", { status: "live", voice: "juniper", transcript: [] });
  peerConnection.connectionState = "failed";
  peerConnection.onconnectionstatechange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.at(-1).type, "realtime-stop");
  assert.equal(inputTrack.stopped, true);

  controller.handleMessage("realtime-state", { status: "idle", voice: "juniper", transcript: [] });
  await startButton.click();
  const staleConnection = peerConnection;
  staleConnection.remoteDescriptionGate = deferred();
  controller.handleMessage("realtime-sdp", { sdp: "v=0\r\no=stale-answer" });
  await fakeElementLastListenerTick();
  await stopButton.click();
  controller.handleMessage("realtime-state", { status: "idle", voice: "juniper", transcript: [] });
  await startButton.click();
  const currentConnection = peerConnection;
  staleConnection.remoteDescriptionGate.reject(new Error("late stale answer failure"));
  await fakeElementLastListenerTick();
  assert.notEqual(currentConnection.signalingState, "closed");
  assert.equal(sent.at(-1).type, "realtime-start");
});

test("stopping while microphone permission is pending cancels the stale Realtime start", async () => {
  const source = await readFile(new URL("../public/agent-realtime.js", import.meta.url), "utf8");
  const browser = { AgentRealtime: null, setTimeout, clearTimeout };
  const document = { createElement: () => fakeElement() };
  const inputTrack = { stopped: false, stop() { this.stopped = true; } };
  const inputStream = {
    getAudioTracks: () => [inputTrack],
    getTracks: () => [inputTrack],
  };
  let resolvePermission;
  const permission = new Promise((resolve) => { resolvePermission = resolve; });
  let peerConnections = 0;
  let throwOnConstruct = false;
  class FakePeerConnection {
    constructor() {
      peerConnections += 1;
      if (throwOnConstruct) throw new Error("peer connection unavailable");
    }
  }
  vm.runInNewContext(source, {
    window: browser,
    document,
    navigator: { mediaDevices: { getUserMedia: () => permission } },
    RTCPeerConnection: FakePeerConnection,
    Float32Array,
    Uint8Array,
    DataView,
  });

  const startButton = fakeElement();
  const stopButton = fakeElement();
  const statusElement = fakeElement();
  const sent = [];
  const controller = browser.AgentRealtime.create({
    launchButton: fakeElement(),
    dialog: fakeElement(),
    dismissButton: fakeElement(),
    startButton,
    stopButton,
    fallbackButton: fakeElement(),
    voiceSelect: Object.assign(fakeElement(), { value: "juniper" }),
    statusElement,
    transcriptElement: fakeElement(),
    errorElement: fakeElement(),
    outputAudio: fakeElement(),
    send: (message) => {
      sent.push(message);
      return true;
    },
  });

  controller.install();
  controller.setEnabled(true);
  const starting = startButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  await stopButton.click();
  resolvePermission(inputStream);
  await starting;

  assert.equal(inputTrack.stopped, true);
  assert.equal(peerConnections, 0);
  assert.equal(sent.some((message) => message.type === "realtime-start"), false);
  assert.equal(sent.some((message) => message.type === "realtime-stop"), false);
  assert.equal(statusElement.textContent, "尚未开始");
  assert.equal(startButton.disabled, false);

  inputTrack.stopped = false;
  throwOnConstruct = true;
  await startButton.click();
  assert.equal(peerConnections, 1);
  assert.equal(inputTrack.stopped, true);
  assert.equal(statusElement.textContent, "连接失败");
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeElementLastListenerTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
      return listeners.get("click")?.({ target: this });
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    play: async () => {},
    pause: () => {},
    replaceChildren(...children) {
      this.children = children;
    },
  };
}
