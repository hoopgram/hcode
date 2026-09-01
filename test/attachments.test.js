import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AttachmentStore, MAX_IMAGE_BYTES, captureMacClipboard, formatAttachment,
  materializeMessages, modelAcceptsImages, runnerPromptWithImages, sniffImage,
  userMessageContent, validateRunnerImages,
} from "../src/attachments.js";
import { runAgent } from "../src/agent.js";
import { Session } from "../src/session.js";
import { startFakeModel, text } from "./fake-model.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZxnAAAAAASUVORK5CYII=", "base64");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-attachments-test-"));

test("private attachment store keeps image bytes ephemeral and references auditable", () => {
  const base = tmp(); const store = new AttachmentStore({ baseDir: base });
  const image = store.addBuffer(PNG);
  assert.equal(image.label, "Image #1"); assert.equal(sniffImage(PNG).mediaType, "image/png");
  assert.equal(fs.statSync(store.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(image.path).mode & 0o777, 0o600);
  assert.match(formatAttachment(image), /^\[Image #1\] path=".*\.png"$/);
  const content = userMessageContent("inspect this", [image]);
  assert.equal(content[0].type, "image_ref"); assert.equal(content[1].text, "inspect this");
  assert.equal("path" in content[0], false); assert.equal(JSON.stringify(content).includes(PNG.toString("base64")), false);
  assert.deepEqual(validateRunnerImages([image]).map(item => item.path), [image.path]);
  assert.match(runnerPromptWithImages("inspect", [image]), /Owner-pasted image inputs.*\[Image #1\] path=/s);
  const root = store.root; store.cleanup(); assert.equal(fs.existsSync(root), false);
});

test("clipboard capture is explicit, fixed-command and normalized before attachment", async () => {
  const calls = []; const dir = tmp(); const target = path.join(dir, "out.png");
  const run = async (file, args) => {
    calls.push([file, args]);
    if (file === "/usr/bin/osascript") fs.writeFileSync(args.at(-1), "fake tiff");
    else fs.writeFileSync(args.at(-1), PNG);
  };
  await captureMacClipboard(target, { run, platform: "darwin" });
  assert.deepEqual(calls.map(call => call[0]), ["/usr/bin/osascript", "/usr/bin/sips"]);
  assert.deepEqual(sniffImage(fs.readFileSync(target)), { mediaType: "image/png", extension: "png" });

  let captures = 0; const store = new AttachmentStore({ baseDir: dir, capture: async file => { captures++; fs.writeFileSync(file, PNG); } });
  assert.equal(captures, 0, "constructing the store never reads the clipboard");
  const image = await store.captureClipboard(); assert.equal(captures, 1); assert.equal(image.label, "Image #1");
  store.cleanup();
});

test("image limits, formats, forged references and symlink swaps fail closed", () => {
  const base = tmp(); const store = new AttachmentStore({ baseDir: base, maxImages: 1 });
  const image = store.addBuffer(PNG);
  assert.throws(() => store.addBuffer(PNG), /at most 1/);
  assert.throws(() => sniffImage(Buffer.from("not an image")), /unsupported/);
  const limited = new AttachmentStore({ baseDir: base, maxBytes: 8 });
  assert.throws(() => limited.addBuffer(PNG), /larger than/); limited.cleanup();
  const defaultLimit = new AttachmentStore({ baseDir: base });
  assert.throws(() => defaultLimit.addBuffer(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /larger than/); defaultLimit.cleanup();

  const ref = userMessageContent("", [image])[0];
  assert.equal(store.resolve({ ...ref, id: "img-forged" }), null);
  const outside = path.join(base, "outside.png"); fs.writeFileSync(outside, PNG, { mode: 0o600 });
  fs.unlinkSync(image.path); fs.symlinkSync(outside, image.path);
  assert.equal(store.resolve(ref), null, "a swapped symlink is never materialized");
  assert.throws(() => validateRunnerImages([image]), /outside|private|changed/);
  store.cleanup();
});

test("vision messages use official image blocks while DeepSeek gets an honest non-vision notice", () => {
  const store = new AttachmentStore({ baseDir: tmp() }); const image = store.addBuffer(PNG);
  const messages = [{ role: "user", content: userMessageContent("what is this?", [image]) }];
  const vision = materializeMessages(messages, { store, model: "claude-3-7-sonnet" });
  assert.deepEqual(vision[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  assert.equal(vision[0].content[1].text, "what is this?");
  const textOnly = materializeMessages(messages, { store, model: "deepseek-v4-pro" });
  assert.equal(textOnly[0].content[0].type, "text"); assert.match(textOnly[0].content[0].text, /no declared image capability.*Do not claim to see it/);
  assert.equal(modelAcceptsImages("deepseek-v4-pro"), false); assert.equal(modelAcceptsImages("claude-3-7-sonnet"), true);
  store.cleanup();
});

test("agent sends vision bytes only in memory and never stores base64 or temp paths", async () => {
  const cwd = tmp(), store = new AttachmentStore({ baseDir: tmp() }), image = store.addBuffer(PNG);
  const model = await startFakeModel((messages) => {
    assert.equal(messages[0].content[0].type, "image");
    assert.equal(messages[0].content[0].source.data, PNG.toString("base64"));
    return text("I can inspect the image");
  });
  const session = new Session(path.join(cwd, "sessions"), null, { cwd, model: "claude-3-7-sonnet" });
  try {
    const result = await runAgent({
      cfg: { baseUrl: model.base, apiKey: "k", model: "claude-3-7-sonnet", maxTokens: 100, maxTurns: 2, bashTimeoutMs: 1000, cwd, mode: "read", tokenBudget: 120000 },
      settings: {}, session, prompt: "inspect", attachments: [image], attachmentStore: store, quiet: true,
    });
    assert.equal(result.text, "I can inspect the image");
    const raw = fs.readFileSync(session.file, "utf8");
    assert.equal(raw.includes(PNG.toString("base64")), false); assert.ok(!raw.includes(image.path));
    assert.match(raw, /"type":"image_ref"/);
  } finally { model.close(); store.cleanup(); }
});
