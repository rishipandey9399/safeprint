"use client";

/** A rendered page: pixels plus its physical size, so layout can work in millimetres. */
export interface RenderedPage {
  canvas: HTMLCanvasElement;
  widthMm: number;
  heightMm: number;
}

const MM_PER_PT = 25.4 / 72;
// Photos have no physical size; place their long side on A4's long side.
const A4_LONG_MM = 297;

/**
 * Renders document bytes to off-DOM canvases. Nothing here creates a URL or
 * DOM node the browser could save — callers decide what (if anything) to show.
 */
export async function renderPages(buf: ArrayBuffer, mimeType: string, scale = 2): Promise<RenderedPage[]> {
  if (mimeType === "application/pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages: RenderedPage[] = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
        pages.push({ canvas, widthMm: base.width * MM_PER_PT, heightMm: base.height * MM_PER_PT });
      }
    } finally {
      void doc.destroy();
    }
    return pages;
  }

  const bitmap = await createImageBitmap(new Blob([buf], { type: mimeType }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const mmPerPx = A4_LONG_MM / Math.max(canvas.width, canvas.height);
  return [{ canvas, widthMm: canvas.width * mmPerPx, heightMm: canvas.height * mmPerPx }];
}

/** Blanks and detaches canvases so their pixels don't linger in memory or the DOM. */
export function wipe(canvases: Iterable<HTMLCanvasElement>) {
  for (const c of canvases) {
    c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    c.width = 0;
    c.height = 0;
    c.remove();
  }
}
