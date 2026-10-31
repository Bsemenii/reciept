// Client-side only. Phone photos are 2–5 MB and often 24+ MP; re-encoding to a 1568px JPEG
// keeps uploads ~300 KB, strips EXIF and turns HEIC (Safari decodes it) into something Claude takes.

const MAX_EDGE = 1568; // Claude's recommended long edge; bigger only adds latency
const QUALITY = 0.8;
const MAX_RAW_BYTES = 5 * 1024 * 1024; // Claude's per-image limit, for the send-as-is fallback

/**
 * Returns base64 without the "data:" prefix, ready for /api/parse (the server sniffs the format).
 * Decoders differ per browser, so this tries them in order:
 * 1. createImageBitmap with resize: the decoder downsamples, so huge photos never hit memory limits
 * 2. <img> + canvas: iOS Safari refuses createImageBitmap above ~16.7 MP but decodes big <img>s
 * 3. the original file as-is, if Claude can read it directly (jpeg/png/webp/gif under 5 MB)
 */
export async function compressImage(file: File): Promise<string> {
  for (const draw of [drawViaBitmap, drawViaImg]) {
    try {
      return await toBase64(await canvasToJpeg(await draw(file)));
    } catch (e) {
      console.warn("image decode failed, trying next decoder", e);
    }
  }
  if (file.size <= MAX_RAW_BYTES && /^image\/(jpeg|png|webp|gif)$/.test(file.type)) return toBase64(file);
  throw new Error("image_unreadable");
}

function fit(width: number, height: number) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function canvasFor(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext("2d")! };
}

async function drawViaBitmap(file: File): Promise<HTMLCanvasElement> {
  // Probe the size first: resizeWidth/Height need the aspect ratio
  const probe = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = fit(probe.width, probe.height);
  probe.close();
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
  const { canvas, ctx } = canvasFor(width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas;
}

async function drawViaImg(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode(); // <img> applies EXIF orientation by default
    const { width, height } = fit(img.naturalWidth, img.naturalHeight);
    const { canvas, ctx } = canvasFor(width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode_failed"))), "image/jpeg", QUALITY),
  );
}

async function toBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
