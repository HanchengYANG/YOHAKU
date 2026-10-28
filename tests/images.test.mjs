import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, { mkdtemp, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createImageStore } from "../server/ai/images.mjs";

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-image-rotation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createImageStore({ storageDir: directory }) };
}

const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
async function cornerImage(orientation = 1) {
  const width = 8, height = 12, pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
      pixels.set(color, (y * width + x) * 3);
    }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png().withMetadata({ orientation }).toBuffer();
}

async function corners(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [[1, 1], [info.width - 2, 1], [1, info.height - 2], [info.width - 2, info.height - 2]]
    .map(([x, y]) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]);
}

test("持久旋转顺时针90/180/270度时四角像素、尺寸和同id元数据一致", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const original = await cornerImage();
  for (const [quarterTurns, order] of [[1, [2, 0, 3, 1]], [2, [3, 2, 1, 0]], [3, [1, 3, 0, 2]]]) {
    const image = await store.save(original, { mimeType: "image/png", originalName: "照片.png" });
    const result = await store.rotate(image.id, { quarterTurns, revision: 1 });
    assert.equal(result.id, image.id);
    assert.equal(result.revision, 2);
    assert.equal(result.orientation, 1);
    assert.equal(result.width, quarterTurns % 2 ? 12 : 8);
    assert.equal(result.height, quarterTurns % 2 ? 8 : 12);
    const current = await store.read(image.id);
    assert.equal(result.bytes, current.length);
    assert.deepEqual(await corners(current), order.map((index) => colors[index]));
    assert.equal((await sharp(current).metadata()).orientation, undefined);
    assert.equal(result.displayWidth, result.width);
    assert.equal(result.displayHeight, result.height);
    assert.deepEqual(await readFile(image.path), original);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    const reopened = createImageStore({ storageDir: directory });
    assert.deepEqual(await reopened.get(image.id), result);
    assert.deepEqual(await reopened.read(image.id), current);
  }
});

test("先应用EXIF方向再旋转，四次90度还原当前显示像素", async (t) => {
  const { store } = await temporaryStore(t);
  const exif = await store.save(await cornerImage(6), { mimeType: "image/png" });
  const rotated = await store.rotate(exif.id, { quarterTurns: 1, revision: 1 });
  assert.deepEqual([rotated.width, rotated.height], [8, 12]);
  assert.deepEqual(await corners(await store.read(exif.id)), [3, 2, 1, 0].map((index) => colors[index]));
  const image = await store.save(await cornerImage(), { mimeType: "image/png" });
  for (let revision = 1; revision <= 4; revision++)
    await store.rotate(image.id, { quarterTurns: 1, revision });
  assert.equal((await store.get(image.id)).revision, 5);
  assert.deepEqual(await corners(await store.read(image.id)), colors);
});

test("同图片并发版本串行核验，过期版本与非法旋转不改变当前像素", async (t) => {
  const { store } = await temporaryStore(t);
  const image = await store.save(await cornerImage(), { mimeType: "image/png" });
  const results = await Promise.allSettled([
    store.rotate(image.id, { quarterTurns: 1, revision: 1 }),
    store.rotate(image.id, { quarterTurns: 1, revision: 1 }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
  const before = await store.read(image.id);
  for (const body of [{ quarterTurns: 0, revision: 2 }, { quarterTurns: 4, revision: 2 },
    { quarterTurns: 1.5, revision: 2 }, { quarterTurns: 1 }, { quarterTurns: 1, revision: "2" }])
    await assert.rejects(store.rotate(image.id, body), (error) => error.status === 400);
  await assert.rejects(store.rotate(image.id, { quarterTurns: 1, revision: 1 }), (error) => error.status === 409);
  await assert.rejects(store.read(image.id, { revision: 1 }), (error) => error.status === 409);
  assert.deepEqual(await store.read(image.id), before);
  assert.equal((await store.get(image.id)).revision, 2);
});

test("元数据切换失败清理未提交版本，旧像素和记录完整可再次旋转", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const original = await cornerImage();
  const image = await store.save(original, { mimeType: "image/png" });
  const metadataPath = join(directory, `${image.id}.json`);
  const record = await readFile(metadataPath);
  const files = (await readdir(directory)).sort();
  const rename = fsPromises.rename;
  fsPromises.rename = async (from, to) => {
    if (to === metadataPath) throw new Error("injected metadata commit failure");
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.rotate(image.id, { quarterTurns: 1, revision: 1 }),
      (error) => error.status === 500 && /原图未更改/.test(error.message));
  } finally {
    fsPromises.rename = rename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(metadataPath), record);
  assert.deepEqual(await store.get(image.id), image);
  assert.deepEqual(await store.read(image.id), original);
  assert.deepEqual((await readdir(directory)).sort(), files);
  assert.equal((await store.rotate(image.id, { quarterTurns: 1, revision: 1 })).revision, 2);
});

test("旧图片默认revision1，可旋转升级，损坏路径与超像素元数据拒绝处理", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const image = await store.save(await cornerImage(), { mimeType: "image/png" });
  const path = join(directory, `${image.id}.json`);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.revision; delete legacy.bytes; delete legacy.updatedAt;
  await writeFile(path, JSON.stringify(legacy));
  assert.equal((await store.get(image.id)).revision, 1);
  assert.equal((await store.get(image.id)).bytes, image.bytes);
  assert.equal((await store.rotate(image.id, { quarterTurns: 3, revision: 1 })).revision, 2);
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...record, file: "../../etc/passwd" }));
  await assert.rejects(store.get(image.id), (error) => error.status === 500);
  await writeFile(path, JSON.stringify({ ...record, width: 40_000_001 }));
  await assert.rejects(store.rotate(image.id, { quarterTurns: 1, revision: 2 }), (error) => error.status === 500);
  await assert.rejects(store.rotate("../escape", { quarterTurns: 1, revision: 1 }), (error) => error.status === 400);
});
