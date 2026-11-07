import sharp from "sharp";

// "42" drawn as strokes for the image capability check. Not <text>: a server
// without fonts renders text as nothing and the model would see a blank picture.
export const DIGIT_TEST_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="white"/><path d="M100 132V28L42 104H118M140 56C140 22 202 22 202 56C202 84 152 104 140 132H206" fill="none" stroke="black" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const digitTestImage = () => sharp(Buffer.from(DIGIT_TEST_SVG)).png().toBuffer();
