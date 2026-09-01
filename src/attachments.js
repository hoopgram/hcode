// Owner-pasted images are short-lived capabilities, not project files. They
// exist only in a private hcode-owned temp directory for this process; session
// events keep a reference and digest, never the image bytes or a reusable path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

export const MAX_IMAGES_PER_MESSAGE = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_SESSION = 50;

const JXA_CLIPBOARD_TIFF = `ObjC.import("AppKit")
function run(argv) {
  const image = $.NSImage.alloc.initWithPasteboard($.NSPasteboard.generalPasteboard)
  if (!image) throw new Error("the clipboard does not contain an image")
  const data = image.TIFFRepresentation
  if (!data || !data.writeToFileAtomically($(argv[0]), true)) throw new Error("the clipboard image could not be read")
  return "ok"
}`;

const runFixed = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5000, maxBuffer: 32 * 1024, windowsHide: true, ...options }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

// macOS does not expose a stable image clipboard utility. AppKit reads the
// owner's current pasteboard once, then the system `sips` tool normalizes the
// result to a Messages-API-supported PNG. Both commands and every argument are
// fixed; no shell or clipboard polling is involved.
export async function captureMacClipboard(target, { run = runFixed, platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("image paste currently needs macOS; text paste still works normally");
  const tiff = target + ".tiff";
  try {
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA_CLIPBOARD_TIFF, tiff]);
    await run("/usr/bin/sips", ["-s", "format", "png", tiff, "--out", target]);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").split("\n").filter(Boolean).at(-1) || "the clipboard does not contain an image";
    throw new Error(detail.includes("clipboard") ? "the clipboard does not contain an image" : `could not paste the clipboard image: ${detail.slice(0, 180)}`);
  } finally {
    try { fs.unlinkSync(tiff); } catch { /* never created or already gone */ }
  }
}

export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || "");
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mediaType: "image/png", extension: "png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mediaType: "image/jpeg", extension: "jpg" };
  const six = buffer.subarray(0, 6).toString("ascii");
  if (six === "GIF87a" || six === "GIF89a") return { mediaType: "image/gif", extension: "gif" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { mediaType: "image/webp", extension: "webp" };
  throw new Error("unsupported clipboard image (use PNG, JPEG, GIF or WebP)");
}

const publicRef = image => ({
  type: "image_ref", id: image.id, label: image.label, media_type: image.mediaType,
  bytes: image.bytes, sha256: image.sha256,
});

export const attachmentMetadata = images => (images || []).map(image => {
  const { type: _type, ...metadata } = publicRef(image);
  return metadata;
});

export function userMessageContent(text, images = []) {
  if (!images.length) return String(text || "");
  return [...images.map(publicRef), ...(String(text || "") ? [{ type: "text", text: String(text) }] : [])];
}

export const formatAttachment = image => `[${image.label}] path="${image.path}"`;

function assertPrivateFile(image) {
  if (!image || typeof image !== "object" || !path.isAbsolute(image.path || "") || !path.isAbsolute(image.root || "")) throw new Error("invalid image capability");
  const root = fs.realpathSync(image.root);
  const file = fs.realpathSync(image.path);
  if (!/^hcode-images-[A-Za-z0-9]+$/.test(path.basename(root)) || path.dirname(file) !== root) throw new Error("refused: image is outside hcode's private attachment directory");
  const rootStat = fs.lstatSync(root), fileStat = fs.lstatSync(image.path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.mode & 0o077) throw new Error("refused: image directory is not private");
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.mode & 0o077) throw new Error("refused: image file is not private");
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("refused: image size is outside the safe limit");
  const format = sniffImage(bytes);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== image.sha256 || format.mediaType !== image.mediaType || bytes.length !== image.bytes) throw new Error("refused: image changed after it was pasted");
  return { ...image, path: file, root, buffer: bytes };
}

export function validateRunnerImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_MESSAGE) throw new Error("refused: too many pasted images");
  return images.map(assertPrivateFile);
}

export class AttachmentStore {
  constructor({ baseDir = os.tmpdir(), capture = captureMacClipboard, maxImages = MAX_IMAGES_PER_SESSION, maxBytes = MAX_IMAGE_BYTES } = {}) {
    const base = fs.realpathSync(baseDir);
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(base, "hcode-images-")));
    fs.chmodSync(this.root, 0o700);
    const rootStat = fs.lstatSync(this.root); this.rootDevice = rootStat.dev; this.rootInode = rootStat.ino;
    this.capture = capture;
    this.maxImages = Math.min(MAX_IMAGES_PER_SESSION, Math.max(1, Number(maxImages) || MAX_IMAGES_PER_SESSION));
    this.maxBytes = Math.min(MAX_IMAGE_BYTES, Math.max(1, Number(maxBytes) || MAX_IMAGE_BYTES));
    this.items = new Map();
    this.closed = false;
  }

  addBuffer(value) {
    if (this.closed) throw new Error("the image attachment store is closed");
    if (this.items.size >= this.maxImages) throw new Error(`this hcode session can hold at most ${this.maxImages} pasted images`);
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
    if (!buffer.length) throw new Error("the clipboard image was empty");
    if (buffer.length > this.maxBytes) throw new Error(`image is larger than ${Math.floor(this.maxBytes / 1024 / 1024)} MB`);
    const { mediaType, extension } = sniffImage(buffer);
    const id = "img-" + crypto.randomBytes(6).toString("hex");
    const file = path.join(this.root, `${id}.${extension}`);
    fs.writeFileSync(file, buffer, { flag: "wx", mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const image = Object.freeze({ id, label: `Image #${this.items.size + 1}`, path: file, root: this.root, mediaType, bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") });
    this.items.set(id, image);
    return image;
  }

  async captureClipboard() {
    if (this.closed) throw new Error("the image attachment store is closed");
    if (this.items.size >= this.maxImages) throw new Error(`this hcode session can hold at most ${this.maxImages} pasted images`);
    const capture = path.join(this.root, `.capture-${crypto.randomBytes(5).toString("hex")}.png`);
    try {
      await this.capture(capture);
      const stat = fs.lstatSync(capture);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("clipboard capture was not a regular file");
      return this.addBuffer(fs.readFileSync(capture));
    } finally {
      try { fs.unlinkSync(capture); } catch { /* capture failed before writing */ }
    }
  }

  resolve(ref) {
    const image = this.items.get(String(ref?.id || ""));
    if (!image || ref?.sha256 !== image.sha256 || ref?.media_type !== image.mediaType) return null;
    try { return assertPrivateFile(image); } catch { return null; }
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true; this.items.clear();
    try {
      const stat = fs.lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.rootDevice || stat.ino !== this.rootInode || fs.realpathSync(this.root) !== this.root || !/^hcode-images-[A-Za-z0-9]+$/.test(path.basename(this.root))) return;
      fs.rmSync(this.root, { recursive: true, force: true });
    } catch { /* already removed */ }
  }
}

export function modelAcceptsImages(model) {
  const id = String(model || "").toLowerCase();
  if (/deepseek|(?:^|[-_/])text(?:[-_/]|$)/.test(id)) return false;
  return /claude-(?:3|sonnet|opus|haiku)|gpt-(?:4o|4\.1|5)|(?:^|[-_/])o[134](?:[-_/]|$)|gemini|qwen[^/]*(?:vl|vision)|llava|pixtral|vision/.test(id);
}

export function materializeMessages(messages, { store, model } = {}) {
  const vision = modelAcceptsImages(model);
  return (messages || []).map(message => {
    if (!Array.isArray(message.content) || !message.content.some(block => block?.type === "image_ref")) return message;
    const content = message.content.map(block => {
      if (block?.type !== "image_ref") return block;
      const image = store?.resolve(block);
      if (image && vision) return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.buffer.toString("base64") } };
      const state = image ? `The current brain (${model || "unknown"}) has no declared image capability.` : "The temporary image is no longer available in this process.";
      return { type: "text", text: `[${block.label || "Image"}] is an owner-pasted local image. ${state} Do not claim to see it; if visual inspection is necessary, use an owner-approved image-capable subagent.` };
    });
    return { ...message, content };
  });
}

export function runnerPromptWithImages(prompt, images = []) {
  if (!images.length) return String(prompt || "");
  return `${String(prompt || "")}\n\nOwner-pasted image inputs (read only these exact files):\n${images.map(formatAttachment).join("\n")}`.trim();
}
