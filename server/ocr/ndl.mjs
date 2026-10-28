import { fileURLToPath } from "node:url";
import { createMangaOcr } from "./manga.mjs";

export function createNdlOcr(options = {}) {
  return createMangaOcr({
    ...options,
    pythonPath: options.pythonPath || process.env.NDLOCR_PYTHON || fileURLToPath(new URL("../../.venv-ndlocr/bin/python", import.meta.url)),
    workerPath: options.workerPath || fileURLToPath(new URL("./ndl-worker.py", import.meta.url)),
    label: "NDLOCR-Lite",
  });
}
