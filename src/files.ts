// Output handling: copy each generated image into the caller's directory
// without ever overwriting, and build small previews for inline display.
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import sharp from "sharp";

export function slugify(input: string, fallback = "image"): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function resolveOutDir(outDir: string | undefined, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const chosen = outDir ?? env.CODEX_IMAGEGEN_OUT_DIR ?? join(cwd, "generated-images");
  return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
}

/** Copies `source` to `<dir>/<base>.<ext>`, or `<base>-2`, `-3`… if taken. */
export async function copyWithoutOverwrite(source: string, dir: string, base: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const ext = extname(source) || ".png";
  for (let n = 1; n < 1000; n++) {
    const target = join(dir, n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`);
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`No free filename for ${base}${ext} in ${dir}`);
}

/** Downscaled JPEG so several variants fit in one tool result. */
export async function makePreview(path: string, maxEdge = 768): Promise<{ data: string; mimeType: string }> {
  const buf = await sharp(path)
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 72 })
    .toBuffer();
  return { data: buf.toString("base64"), mimeType: "image/jpeg" };
}

export async function imageSize(path: string): Promise<{ width: number; height: number } | null> {
  const meta = await sharp(path).metadata();
  return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
}
