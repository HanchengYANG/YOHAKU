import { randomUUID } from "node:crypto";
import {
  mkdir,
  chmod,
  writeFile,
  readFile,
  rename,
  unlink,
  stat,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const formats = {
  "image/png": { format: "png", extension: "png" },
  "image/jpeg": { format: "jpeg", extension: "jpg" },
  "image/webp": { format: "webp", extension: "webp" },
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireId(id) {
  if (typeof id !== "string" || !uuid.test(id)) fail(400, "图片编号无效。");
}

function safeName(value) {
  if (typeof value !== "string") return "导入图片";
  return (
    value
      .split(/[\\/]/)
      .at(-1)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200) || "导入图片"
  );
}

function matchesSignature(buffer, mimeType) {
  if (mimeType === "image/png")
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg")
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  );
}

export function createImageStore({ storageDir } = {}) {
  if (typeof storageDir !== "string" || !storageDir)
    throw new Error("需要指定图片存储目录。");
  const directory = resolve(storageDir);
  const rotations = new Map();
  let initialized;
  const ensureDirectory = () =>
    (initialized ??= mkdir(directory, { recursive: true, mode: 0o700 }).then(
      () => chmod(directory, 0o700),
    ));

  async function get(id) {
    requireId(id);
    let metadata;
    try {
      metadata = JSON.parse(
        await readFile(join(directory, `${id}.json`), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") fail(404, "找不到这张图片。");
      fail(500, "图片记录无法读取，请检查本地资料备份。");
    }
    const format = formats[metadata?.mimeType];
    const revision = metadata?.revision === undefined ? 1 : metadata.revision;
    const updatedAt = metadata?.updatedAt ?? metadata?.createdAt;
    if (
      !metadata ||
      metadata.id !== id ||
      !format ||
      !Number.isSafeInteger(metadata.width) ||
      metadata.width < 1 ||
      !Number.isSafeInteger(metadata.height) ||
      metadata.height < 1 ||
      metadata.width * metadata.height > MAX_PIXELS ||
      !Number.isSafeInteger(metadata.orientation) ||
      metadata.orientation < 1 ||
      metadata.orientation > 8 ||
      typeof metadata.originalName !== "string" ||
      metadata.originalName !== safeName(metadata.originalName) ||
      typeof metadata.createdAt !== "string" ||
      !Number.isFinite(Date.parse(metadata.createdAt)) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      typeof updatedAt !== "string" ||
      !Number.isFinite(Date.parse(updatedAt))
    ) {
      fail(500, "图片记录损坏，请检查本地资料备份。");
    }
    let filename = `${id}.${format.extension}`;
    if (metadata.file !== undefined) {
      const prefix = `${id}.r${revision}.`,
        suffix = `.${format.extension}`;
      if (
        typeof metadata.file !== "string" ||
        !metadata.file.startsWith(prefix) ||
        !metadata.file.endsWith(suffix) ||
        !uuid.test(metadata.file.slice(prefix.length, -suffix.length))
      )
        fail(500, "图片记录损坏，请检查本地资料备份。");
      filename = metadata.file;
    } else if (revision !== 1) {
      fail(500, "图片记录损坏，请检查本地资料备份。");
    }
    const path = join(directory, filename);
    let bytes = metadata.bytes;
    if (bytes === undefined) {
      try {
        bytes = (await stat(path)).size;
      } catch {
        fail(404, "原始图片文件已不存在。");
      }
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES)
      fail(500, "图片记录损坏，请检查本地资料备份。");
    const swapped = metadata.orientation >= 5;
    return {
      id,
      mimeType: metadata.mimeType,
      originalName: metadata.originalName,
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation,
      displayWidth: swapped ? metadata.height : metadata.width,
      displayHeight: swapped ? metadata.width : metadata.height,
      createdAt: metadata.createdAt,
      updatedAt,
      revision,
      bytes,
      path,
    };
  }

  async function save(buffer, { mimeType, originalName } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length)
      fail(400, "请选择一张图片。");
    if (buffer.length > MAX_BYTES)
      fail(413, "图片最大为 12 MB，请缩小后再导入。");
    const format = formats[mimeType];
    if (!format) fail(415, "仅支持 PNG、JPEG 和 WebP 图片。");
    if (!matchesSignature(buffer, mimeType))
      fail(415, "图片格式与内容不符，请选择有效的 PNG、JPEG 或 WebP 图片。");
    let metadata;
    try {
      metadata = await sharp(buffer, {
        limitInputPixels: MAX_PIXELS,
        failOn: "warning",
      }).metadata();
      if (
        metadata.format !== format.format ||
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > MAX_PIXELS ||
        (metadata.pages ?? 1) > 1
      )
        throw new Error("format");
      // Fully decode a small validation output, retaining the original bytes.
      await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "warning" })
        .resize({ width: 1, height: 1, fit: "inside" })
        .raw()
        .toBuffer();
    } catch {
      fail(
        415,
        "图片格式与内容不符、文件损坏，或尺寸超过 4000 万像素。请换一张清晰的静态图片。",
      );
    }
    await ensureDirectory();
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      mimeType,
      originalName: safeName(originalName),
      width: metadata.width,
      height: metadata.height,
      orientation:
        metadata.orientation >= 1 && metadata.orientation <= 8
          ? metadata.orientation
          : 1,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      bytes: buffer.length,
    };
    const path = join(directory, `${id}.${format.extension}`);
    const recordPath = join(directory, `${id}.json`);
    const temporary = join(directory, `${id}.json.tmp`);
    try {
      await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
      await writeFile(temporary, JSON.stringify(record), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, recordPath);
    } catch (error) {
      await Promise.all(
        [path, temporary, recordPath].map((file) =>
          unlink(file).catch(() => {}),
        ),
      );
      throw error;
    }
    return get(id);
  }

  async function read(id, { normalizeOrientation = false, revision } = {}) {
    const metadata = await get(id);
    if (revision !== undefined && revision !== metadata.revision)
      fail(409, "图片方向已变化，请重新打开后再识别。");
    let buffer;
    try {
      buffer = await readFile(metadata.path);
    } catch (error) {
      if (error.code === "ENOENT") fail(404, "原始图片文件已不存在。");
      fail(500, "原始图片暂时无法读取。");
    }
    if (!normalizeOrientation || metadata.orientation === 1) return buffer;
    try {
      // Inference receives a rotated copy with EXIF orientation applied. The
      // stored original remains byte-for-byte unchanged for future proofreading.
      return await sharp(buffer, {
        limitInputPixels: MAX_PIXELS,
        failOn: "warning",
      })
        .rotate()
        .toBuffer();
    } catch {
      fail(415, "图片方向无法处理，请重新导入原图。");
    }
  }

  async function rotate(id, { quarterTurns, revision } = {}) {
    requireId(id);
    if (
      ![1, 2, 3].includes(quarterTurns) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      fail(400, "请提供有效的旋转角度和图片版本。");
    const operation = (rotations.get(id) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = await get(id);
        if (current.revision !== revision)
          fail(409, "图片方向已被更新，请重新打开原图后再旋转。");
        if (revision >= Number.MAX_SAFE_INTEGER)
          fail(409, "图片版本无法继续更新，请重新导入。");
        let output;
        try {
          output = await sharp(await read(id), {
            limitInputPixels: MAX_PIXELS,
            failOn: "warning",
          })
            .autoOrient()
            .rotate(quarterTurns * 90)
            .toFormat(
              formats[current.mimeType].format,
              current.mimeType === "image/png" ? {} : { quality: 95 },
            )
            .toBuffer({ resolveWithObject: true });
        } catch {
          fail(415, "图片方向无法处理，原图未更改，请重新导入有效图片。");
        }
        if (output.data.length > MAX_BYTES)
          fail(413, "旋转后的图片超过12 MB，原图未更改。");
        const updatedAt = new Date().toISOString();
        const file = `${id}.r${revision + 1}.${randomUUID()}.${formats[current.mimeType].extension}`;
        const path = join(directory, file);
        const temporary = join(directory, `${id}.json.tmp-${randomUUID()}`);
        const { path: previousPath, ...publicMetadata } = current;
        const record = {
          ...publicMetadata,
          width: output.info.width,
          height: output.info.height,
          displayWidth: output.info.width,
          displayHeight: output.info.height,
          orientation: 1,
          bytes: output.data.length,
          revision: revision + 1,
          updatedAt,
          file,
        };
        try {
          await writeFile(path, output.data, { flag: "wx", mode: 0o600 });
          await writeFile(temporary, JSON.stringify(record), {
            flag: "wx", mode: 0o600,
          });
          // Old pixel versions remain readable until this atomic pointer switch.
          await rename(temporary, join(directory, `${id}.json`));
        } catch {
          await Promise.all(
            [path, temporary].map((file) => unlink(file).catch(() => {})),
          );
          fail(500, "旋转图片未保存，原图未更改，请重试。");
        }
        const { file: storedFile, ...result } = record;
        return { ...result, path };
      });
    rotations.set(id, operation);
    try {
      return await operation;
    } finally {
      if (rotations.get(id) === operation) rotations.delete(id);
    }
  }

  return { save, get, read, rotate };
}
