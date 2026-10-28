# 首页摄影素材

生成日期：2026-10-28（Europe/Paris）。

两张素材均按本轮首页设计需求，以内置 `image_gen.imagegen` 全新生成，属于摄影风格的 AI 图像，不是来自图库的实拍照片。使用内置工具模式，未使用 CLI 或 API key。

## 项目文件

| 用途 | 项目素材 | 像素 | 文件大小 |
| --- | --- | --- | --- |
| 首页主视觉 | [reading-room.webp](../client/assets/reading-room.webp) | 1536 × 1024 | 150,738 字节 |
| 阅读辅助卡片 | [study-detail.webp](../client/assets/study-detail.webp) | 1254 × 1254 | 214,432 字节 |

使用 Sharp 转为 WebP，`quality: 84`、`effort: 6`。尺寸限制分别为最大宽度 1600 和 1400 像素，禁止放大；本次原图已低于限制，因此像素尺寸未变。未裁切、合成或修改画面内容。两张最终素材均已目检：书籍、纸张、织物、茶具的质感与统一配色可用；无人物、可读正文、书名、商标、水印或界面元素。图片仅作装饰，不作为学习材料内容。

原始 PNG 副本保留在本项目被 Git 忽略的目录：

- `artifacts/design-2026-10-28/reading-room-original.png`
- `artifacts/design-2026-10-28/study-detail-original.png`

内置工具最初保存位置：

- `/home/hancheng/.codex/generated_images/01a18406-991e-78b1-9836-942f36ba5dad/exec-af75747e-a650-4edc-804f-b238b5e3c109.png`
- `/home/hancheng/.codex/generated_images/01a18406-991e-78b1-9836-942f36ba5dad/exec-a7ac8412-3705-4455-aba0-21af90ebd9e7.png`

应用引用上面的 `client/assets/` 文件，不依赖用户目录中的生成位置。

## 最终提示词：reading-room

```text
Use case: photorealistic-natural
Asset type: wide editorial photograph for the homepage of a personal Japanese reading app.
Primary request: A calm, premium Japanese-inspired personal reading corner, photographed as a real interior still life.
Scene/backdrop: Warm afternoon sunlight from a nearby window falls across a honey oak desk. Softly blurred leafy plants and a window in the background.
Subject: An open Japanese-style book, a small stack of beautiful unbranded notebooks, a rust-orange woven fabric bookmark, a simple ceramic cup of tea, and a little tactile ivory linen on the desk.
Style/medium: Natural editorial lifestyle photography, realistic optics, dimensional shadows, tactile materials, quiet sophistication. A real photographed scene, not an illustration or rendered interface.
Composition/framing: Landscape 3:2 composition, moderately wide view with the desk objects clustered center-right and generous breathing room around them. The open book and orange bookmark remain visible in a center crop; no text overlay. Slightly elevated three-quarter camera angle.
Lighting/mood: Low warm afternoon sun, soft but defined shadow and rich tonal depth; welcoming, focused, lived-in but uncluttered.
Color palette: Warm ivory, oak, deep teal-ink shadows and one rust-orange accent, subtle green plant color.
Materials/textures: Fine textured book paper, oak grain, matte pottery, woven linen and fabric.
Constraints: No people, no logos, no watermarks, no graphics, no UI, no legible words, no readable book titles, no specific lesson content. Pages may show only very faint out-of-focus typographic texture without decipherable text. Do not render blank white featureless book pages.
```

## 最终提示词：study-detail

```text
Use case: photorealistic-natural
Asset type: supporting editorial still-life photograph for the same premium personal Japanese reading app.
Primary request: An intimate tactile close-up of a small stack of unbranded Japanese-style books with a rust-orange woven bookmark, photographed against a rich deep teal backdrop.
Scene/backdrop: A deep teal-ink painted tabletop and softly receding backdrop; subtle warm ambient light from the left. Quiet uncluttered still life.
Subject: Three beautiful clothbound paperback and hardcover books stacked slightly unevenly, with warm ivory textured page edges, teal and muted ivory fabric covers, and one rust-orange woven bookmark gently draping over the pages toward the foreground. A softly folded edge of natural linen can sit below the books.
Style/medium: Natural premium editorial product photography, realistic dimensional book geometry and believable fine paper grain. Real photograph, no illustration, no graphics.
Composition/framing: Square composition, close-up, stack in the lower-middle and center-right, angled so the layered page edges and tactile covers are prominent. Enough negative space around the subject to crop to a landscape supporting card.
Lighting/mood: Beautiful soft directional afternoon light, deep teal shadows, warm ivory highlights, rich tonal depth, calm and contemplative.
Color palette: Deep teal-ink dominant, warm ivory paper and natural linen, rust-orange bookmark as a single accent, restrained subtle green undertones.
Constraints: No people, no visible hands, no logos, no watermarks, no UI, no legible text, no book titles or lettering, no lesson content. Spines and covers must be entirely unbranded and free of text. Book geometry should look natural and physically plausible.
```
