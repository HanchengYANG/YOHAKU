const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxBytes = 12 * 1024 * 1024;

export function imageImportFiles(fileList, selectedCount = 0) {
  const files = Array.from(fileList || []);
  if (selectedCount + files.length > 100) throw new Error("一篇文章最多支持 100 张图片，当前队列已保留。");
  for (const file of files) {
    if (!allowedTypes.has(file.type)) throw new Error(`「${file.name || "这张图片"}」请选择 PNG、JPEG 或 WebP 图片，当前队列已保留。`);
    if (!file.size || file.size > maxBytes) throw new Error(`「${file.name || "这张图片"}」需要有内容，且大小不超过 12 MB，当前队列已保留。`);
  }
  return files;
}
