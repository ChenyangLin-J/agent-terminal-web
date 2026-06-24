import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const AUDIO_CHUNK_BYTES = 32 * 1024;
const STT_TIMEOUT_MS = 25_000;

const DOUBAO_STT_APP_ID = process.env.DOUBAO_STT_APP_ID || "";
const DOUBAO_STT_ACCESS_TOKEN = process.env.DOUBAO_STT_ACCESS_TOKEN || "";
const DOUBAO_STT_RESOURCE_ID = process.env.DOUBAO_STT_RESOURCE_ID || "volc.bigasr.sauc.duration";
const DOUBAO_STT_WS_URL =
  process.env.DOUBAO_STT_WS_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";

const MESSAGE_TYPE = {
  FULL_CLIENT_REQUEST: 1,
  AUDIO_ONLY_REQUEST: 2,
  FULL_SERVER_RESPONSE: 9,
  ERROR_RESPONSE: 15,
};

const MESSAGE_FLAGS = {
  NONE: 0,
  LAST_PACKET: 2,
};

const SERIALIZATION = {
  NONE: 0,
  JSON: 1,
};

const COMPRESSION = {
  GZIP: 1,
};

export async function transcribeAudio(audioBuffer, contentType) {
  if (!DOUBAO_STT_APP_ID || !DOUBAO_STT_ACCESS_TOKEN) {
    throw new Error("Doubao STT is not configured");
  }

  const pcmBuffer = await convertToPcm(audioBuffer, contentType);
  return transcribePcm(pcmBuffer);
}

async function convertToPcm(audioBuffer, contentType) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-audio-"));
  const inputPath = path.join(tempDir, `input${extensionForContentType(contentType)}`);
  const outputPath = path.join(tempDir, "output.pcm");

  try {
    await writeFile(inputPath, audioBuffer);
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function extensionForContentType(contentType) {
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("mpeg")) return ".mp3";
  if (contentType.includes("wav")) return ".wav";
  return ".webm";
}

function transcribePcm(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DOUBAO_STT_WS_URL, {
      headers: {
        "X-Api-App-Key": DOUBAO_STT_APP_ID,
        "X-Api-Access-Key": DOUBAO_STT_ACCESS_TOKEN,
        "X-Api-Resource-Id": DOUBAO_STT_RESOURCE_ID,
        "X-Api-Connect-Id": randomUUID(),
      },
    });

    const transcripts = [];
    let settled = false;

    const timeout = setTimeout(() => {
      finishWithError(new Error("Doubao STT timed out"));
    }, STT_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(buildFullClientRequest());
      for (let offset = 0; offset < pcmBuffer.length; offset += AUDIO_CHUNK_BYTES) {
        ws.send(buildAudioRequest(pcmBuffer.subarray(offset, offset + AUDIO_CHUNK_BYTES), false));
      }
      ws.send(buildAudioRequest(Buffer.alloc(0), true));
    });

    ws.on("message", (message) => {
      try {
        const parsed = parseServerResponse(Buffer.from(message));
        if (parsed.type === "error") {
          finishWithError(new Error(`Doubao STT error ${parsed.data.code}: ${parsed.data.message}`));
          return;
        }

        const transcript = extractTranscript(parsed.data);
        if (transcript) transcripts.push(transcript);

        if (parsed.isLast) {
          finishWithResult(transcripts.at(-1) || transcripts.join("").trim());
        }
      } catch (error) {
        finishWithError(error);
      }
    });

    ws.on("error", finishWithError);
    ws.on("close", () => {
      if (!settled) finishWithResult(transcripts.at(-1) || transcripts.join("").trim());
    });

    function finishWithResult(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      resolve(text.trim());
    }

    function finishWithError(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    }
  });
}

function buildFullClientRequest() {
  return buildPacket(
    MESSAGE_TYPE.FULL_CLIENT_REQUEST,
    MESSAGE_FLAGS.NONE,
    SERIALIZATION.JSON,
    COMPRESSION.GZIP,
    Buffer.from(
      JSON.stringify({
        user: {
          uid: "agent-terminal-web",
        },
        audio: {
          format: "pcm",
          rate: 16000,
          bits: 16,
          channel: 1,
        },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
          result_type: "full",
        },
      }),
      "utf8",
    ),
  );
}

function buildAudioRequest(audioBuffer, isLast) {
  return buildPacket(
    MESSAGE_TYPE.AUDIO_ONLY_REQUEST,
    isLast ? MESSAGE_FLAGS.LAST_PACKET : MESSAGE_FLAGS.NONE,
    SERIALIZATION.NONE,
    COMPRESSION.GZIP,
    audioBuffer,
  );
}

function buildPacket(messageType, flags, serialization, compression, payload) {
  const compressedPayload = gzipSync(payload);
  const header = Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | compression, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressedPayload.length, 0);
  return Buffer.concat([header, size, compressedPayload]);
}

function parseServerResponse(buffer) {
  if (buffer.length < 8) throw new Error("Invalid STT response");

  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = (buffer[1] >> 4) & 0x0f;
  const flags = buffer[1] & 0x0f;
  const serialization = (buffer[2] >> 4) & 0x0f;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize;

  if ((flags & 0x01) === 0x01) offset += 4;
  const isLast = (flags & MESSAGE_FLAGS.LAST_PACKET) === MESSAGE_FLAGS.LAST_PACKET;

  if (messageType === MESSAGE_TYPE.ERROR_RESPONSE) {
    const code = buffer.readUInt32BE(offset);
    offset += 4;
    const messageLength = buffer.readUInt32BE(offset);
    offset += 4;
    return {
      type: "error",
      isLast: true,
      data: {
        code,
        message: buffer.subarray(offset, offset + messageLength).toString("utf8"),
      },
    };
  }

  if (messageType !== MESSAGE_TYPE.FULL_SERVER_RESPONSE) {
    throw new Error(`Unknown STT response type: ${messageType}`);
  }

  const payloadLength = buffer.readUInt32BE(offset);
  offset += 4;
  if (payloadLength === 0) return { type: "result", isLast, data: {} };

  let payload = buffer.subarray(offset, offset + payloadLength);
  if (compression === COMPRESSION.GZIP) payload = gunzipSync(payload);

  return {
    type: "result",
    isLast,
    data: serialization === SERIALIZATION.JSON ? JSON.parse(payload.toString("utf8")) : {},
  };
}

function extractTranscript(data) {
  const directText = firstNonEmptyString(data?.result?.text, data?.text);
  if (directText) return directText;

  const utterances = data?.result?.utterances || data?.utterances;
  if (Array.isArray(utterances)) {
    const text = utterances.map((utterance) => utterance?.text).filter(Boolean).join("");
    if (text.trim()) return text.trim();
  }

  return "";
}

function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}
