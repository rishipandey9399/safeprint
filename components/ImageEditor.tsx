"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Canvas as FabricCanvas, FabricObject } from "fabric";
import type { RenderedPage } from "@/lib/pdfRender";
import {
  cloneCanvas,
  cropCanvas,
  rotate90,
  toneCanvas,
  warpPerspective,
  type Quad,
  type Tone,
} from "@/lib/imageOps";

type Fabric = typeof import("fabric");

export interface EditedPage {
  blob: Blob;
  widthPt: number;
  heightPt: number;
}

interface Props {
  pages: RenderedPage[];
  busy: boolean;
  onSubmit: (pages: EditedPage[], tools: string[]) => Promise<void>;
  onCancel: () => void;
}

type Tool = "select" | "crop" | "perspective" | "whiteout" | "eraser" | "pen" | "text" | "rect" | "line" | "arrow";

interface Snapshot {
  base: HTMLCanvasElement;
  objects: object[];
}

interface PageDoc {
  base: HTMLCanvasElement;
  pxPerMm: number;
  objects: object[]; // serialized overlay objects (text, shapes, strokes)
  history: Snapshot[];
  future: Snapshot[];
}

const PT_PER_MM = 72 / 25.4;
const HISTORY_LIMIT = 15;
const NO_TONE: Tone = { brightness: 0, contrast: 0, grayscale: false };

// Helper objects (crop box, corner handles) are never part of the page.
const isHelper = (o: object | undefined) => (o as { spHelper?: boolean } | undefined)?.spHelper === true;

/**
 * Photoshop-style page editor for the shop, opened only after the citizen
 * allowed editing. Works on in-memory canvases; the result goes straight into
 * a FormData upload to SafePrint for the citizen's review — never to a URL,
 * download link, or the clipboard.
 */
export default function ImageEditor({ pages, busy, onSubmit, onCancel }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Fabric | null>(null);
  const canvasRef = useRef<FabricCanvas | null>(null);
  const docsRef = useRef<PageDoc[]>([]);
  const helpersRef = useRef<FabricObject[]>([]);
  const restoringRef = useRef(false);
  const toolsUsed = useRef(new Set<string>());

  const [ready, setReady] = useState(false);
  const [pageIdx, setPageIdx] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#111111");
  const [size, setSize] = useState(4);
  const [fontSize, setFontSize] = useState(28);
  const [straightenDeg, setStraightenDeg] = useState(0);
  const [tone, setTone] = useState<Tone>(NO_TONE);
  const [cleanup, setCleanup] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [historyLen, setHistoryLen] = useState({ undo: 0, redo: 0 });
  const [error, setError] = useState("");

  const zoom = () => canvasRef.current?.getZoom() ?? 1;

  // -------------------------------------------------------------------------
  // Page <-> fabric canvas
  // -------------------------------------------------------------------------

  const overlayObjects = () => (canvasRef.current?.getObjects() ?? []).filter((o) => !isHelper(o));
  const serialize = () => overlayObjects().map((o) => o.toObject());

  const fitToHost = useCallback((base: HTMLCanvasElement) => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const maxW = Math.max(240, host.clientWidth - 2);
    const maxH = Math.max(320, window.innerHeight * 0.72);
    const z = Math.min(maxW / base.width, maxH / base.height, 1.5);
    canvas.setDimensions({ width: Math.round(base.width * z), height: Math.round(base.height * z) });
    canvas.setZoom(z);
  }, []);

  const setBase = useCallback(
    (base: HTMLCanvasElement) => {
      const f = fabricRef.current!;
      const canvas = canvasRef.current!;
      canvas.backgroundImage = new f.FabricImage(base, {
        left: base.width / 2,
        top: base.height / 2,
        originX: "center",
        originY: "center",
        selectable: false,
        evented: false,
      });
      fitToHost(base);
    },
    [fitToHost]
  );

  const loadObjects = useCallback(async (objects: object[]) => {
    const f = fabricRef.current!;
    const canvas = canvasRef.current!;
    restoringRef.current = true;
    try {
      overlayObjects().forEach((o) => canvas.remove(o));
      const live = await f.util.enlivenObjects<FabricObject>(objects);
      live.forEach((o) => canvas.add(o));
    } finally {
      restoringRef.current = false;
    }
    canvas.requestRenderAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncHistoryLen = (d: PageDoc) => setHistoryLen({ undo: d.history.length - 1, redo: d.future.length });

  /** Records the current page state as an undo step. */
  const commit = useCallback(() => {
    if (restoringRef.current) return;
    const d = docsRef.current[pageIdxRef.current];
    if (!d) return;
    d.objects = serialize();
    d.history.push({ base: d.base, objects: d.objects });
    if (d.history.length > HISTORY_LIMIT) d.history.shift();
    d.future = [];
    syncHistoryLen(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageIdxRef = useRef(0);

  const showPage = useCallback(
    async (i: number) => {
      const d = docsRef.current[i];
      pageIdxRef.current = i;
      setPageIdx(i);
      clearHelpers();
      setBase(d.base);
      await loadObjects(d.objects);
      syncHistoryLen(d);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setBase, loadObjects]
  );

  const saveCurrent = () => {
    const d = docsRef.current[pageIdxRef.current];
    if (d) d.objects = serialize();
  };

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  useEffect(() => {
    let disposed = false;
    (async () => {
      const f = await import("fabric");
      if (disposed || !elRef.current) return;
      fabricRef.current = f;
      const canvas = new f.Canvas(elRef.current, {
        backgroundColor: "#ffffff",
        preserveObjectStacking: true,
        selection: true,
      });
      canvasRef.current = canvas;
      docsRef.current = pages.map((p) => {
        const base = cloneCanvas(p.canvas);
        return { base, pxPerMm: p.canvas.width / p.widthMm, objects: [], history: [{ base, objects: [] }], future: [] };
      });

      canvas.on("object:added", (e) => {
        if (!isHelper(e.target)) commit();
      });
      canvas.on("object:modified", (e) => {
        if (e.target && !isHelper(e.target)) commit();
      });
      canvas.on("object:removed", (e) => {
        if (!isHelper(e.target)) commit();
      });
      canvas.on("text:editing:exited", () => commit());
      canvas.on("path:created", () => toolsUsed.current.add(canvas.freeDrawingBrush?.color === "#ffffff" ? "eraser" : "pen"));
      canvas.on("selection:created", () => setHasSelection(true));
      canvas.on("selection:updated", () => setHasSelection(true));
      canvas.on("selection:cleared", () => setHasSelection(false));

      await showPage(0);
      setReady(true);
    })();
    return () => {
      disposed = true;
      // Blank every working canvas on the way out.
      for (const d of docsRef.current) {
        for (const s of d.history) s.base.width = 0;
        d.base.width = 0;
      }
      docsRef.current = [];
      void canvasRef.current?.dispose();
      canvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onResize = () => {
      const d = docsRef.current[pageIdxRef.current];
      if (d) fitToHost(d.base);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitToHost]);

  // -------------------------------------------------------------------------
  // Raster operations (flatten overlays into the page, then transform)
  // -------------------------------------------------------------------------

  /** The page as it looks now (base + overlays, no helpers), at full resolution. */
  const flatten = (): HTMLCanvasElement => {
    const canvas = canvasRef.current!;
    return canvas.toCanvasElement(1 / zoom(), { filter: (o) => !isHelper(o) });
  };

  const replaceBase = async (next: HTMLCanvasElement, toolName: string) => {
    const d = docsRef.current[pageIdxRef.current];
    clearHelpers();
    setStraightenDeg(0);
    d.base = next;
    setBase(next);
    await loadObjects([]);
    toolsUsed.current.add(toolName);
    commit();
    setTool("select");
  };

  const rotate = (dir: 1 | -1) => void replaceBase(rotate90(flatten(), dir), "rotate");

  const applyStraighten = () => {
    if (!straightenDeg) return;
    const out = flatten(); // includes the rotated preview of the page
    void replaceBase(out, "straighten");
  };

  const applyTone = () => {
    if (!cleanup && !tone.brightness && !tone.contrast && !tone.grayscale) return;
    const out = toneCanvas(flatten(), tone, cleanup);
    toolsUsed.current.add(cleanup ? "scan-cleanup" : "tone");
    setTone(NO_TONE);
    setCleanup(false);
    void replaceBase(out, "tone");
  };

  // Straighten preview: turn the page image under the overlays.
  useEffect(() => {
    const bg = canvasRef.current?.backgroundImage;
    if (!bg) return;
    bg.set({ angle: straightenDeg });
    canvasRef.current!.requestRenderAll();
  }, [straightenDeg]);

  // -------------------------------------------------------------------------
  // Helpers: crop box and perspective corners
  // -------------------------------------------------------------------------

  function clearHelpers() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    helpersRef.current.forEach((h) => canvas.remove(h));
    helpersRef.current = [];
  }

  const addHelper = <T extends FabricObject>(o: T): T => {
    (o as FabricObject & { spHelper?: boolean }).spHelper = true;
    helpersRef.current.push(o);
    canvasRef.current!.add(o);
    return o;
  };

  const startCrop = () => {
    const f = fabricRef.current!;
    const d = docsRef.current[pageIdxRef.current];
    clearHelpers();
    const inset = 0.04;
    const box = addHelper(
      new f.Rect({
        left: d.base.width * inset,
        top: d.base.height * inset,
        width: d.base.width * (1 - 2 * inset),
        height: d.base.height * (1 - 2 * inset),
        fill: "rgba(178, 62, 29, 0.06)",
        stroke: "#b23e1d",
        strokeWidth: 2 / zoom(),
        strokeDashArray: [8 / zoom(), 6 / zoom()],
        strokeUniform: true,
        lockRotation: true,
        hasRotatingPoint: false,
        cornerColor: "#b23e1d",
        transparentCorners: false,
        cornerSize: 14,
      } as never)
    );
    box.setControlsVisibility({ mtr: false });
    canvasRef.current!.setActiveObject(box);
    canvasRef.current!.requestRenderAll();
  };

  const applyCrop = () => {
    const box = helpersRef.current[0];
    if (!box) return;
    const r = box.getBoundingRect();
    if (r.width < 20 || r.height < 20) return setError("Crop area is too small.");
    const out = cropCanvas(flatten(), r.left, r.top, r.width, r.height);
    void replaceBase(out, "crop");
  };

  const startPerspective = () => {
    const f = fabricRef.current!;
    const d = docsRef.current[pageIdxRef.current];
    clearHelpers();
    const w = d.base.width;
    const h = d.base.height;
    const i = 0.08;
    const pts: [number, number][] = [
      [w * i, h * i],
      [w * (1 - i), h * i],
      [w * (1 - i), h * (1 - i)],
      [w * i, h * (1 - i)],
    ];
    const outline = addHelper(
      new f.Polygon(
        pts.map(([x, y]) => ({ x, y })),
        { fill: "rgba(178, 62, 29, 0.08)", stroke: "#b23e1d", strokeWidth: 2 / zoom(), selectable: false, evented: false, objectCaching: false }
      )
    );
    const r = 11 / zoom();
    pts.forEach(([x, y], idx) => {
      const c = addHelper(
        new f.Circle({
          left: x,
          top: y,
          radius: r,
          originX: "center",
          originY: "center",
          fill: "#b23e1d",
          stroke: "#fff",
          strokeWidth: 2 / zoom(),
          hasControls: false,
          hasBorders: false,
        })
      );
      c.on("moving", () => {
        const p = outline.points[idx];
        p.x = c.left;
        p.y = c.top;
        outline.set({ dirty: true });
        outline.setBoundingBox(true);
        canvasRef.current!.requestRenderAll();
      });
    });
    canvasRef.current!.requestRenderAll();
  };

  const applyPerspective = () => {
    const corners = helpersRef.current.slice(1) as FabricObject[];
    if (corners.length !== 4) return;
    const quad = corners.map((c) => [c.left, c.top]) as Quad;
    try {
      const out = warpPerspective(flatten(), quad);
      void replaceBase(out, "perspective");
    } catch {
      setError("Those corners don't form a page — drag them onto the page's four corners.");
    }
  };

  // -------------------------------------------------------------------------
  // Drawing tools
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const f = fabricRef.current;
    if (!canvas || !f || !ready) return;
    setError("");

    canvas.isDrawingMode = tool === "pen" || tool === "eraser";
    if (canvas.isDrawingMode) {
      const brush = new f.PencilBrush(canvas);
      brush.color = tool === "eraser" ? "#ffffff" : color;
      brush.width = (tool === "eraser" ? size * 5 : size) / zoom();
      canvas.freeDrawingBrush = brush;
    }
    const creating = ["whiteout", "rect", "line", "arrow", "text"].includes(tool);
    canvas.selection = !creating;
    canvas.defaultCursor = creating ? "crosshair" : "default";
    overlayObjects().forEach((o) => o.set({ selectable: !creating, evented: !creating }));

    if (tool === "crop") startCrop();
    else if (tool === "perspective") startPerspective();
    else clearHelpers();
    canvas.requestRenderAll();

    if (!creating) return;

    let start: { x: number; y: number } | null = null;
    let shape: FabricObject | null = null;
    const stroke = size / zoom();

    const down = (e: { scenePoint: { x: number; y: number } }) => {
      const p = e.scenePoint;
      if (tool === "text") {
        const t = new f.IText("Type here", {
          left: p.x,
          top: p.y,
          fontSize: fontSize / zoom(),
          fill: color,
          fontFamily: "Arial, Helvetica, sans-serif",
        });
        canvas.add(t);
        canvas.setActiveObject(t);
        t.enterEditing();
        t.selectAll();
        toolsUsed.current.add("text");
        setTool("select");
        return;
      }
      start = { x: p.x, y: p.y };
      restoringRef.current = true; // don't record the in-progress shape
      if (tool === "whiteout") {
        shape = new f.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: "#ffffff", strokeWidth: 0 });
      } else if (tool === "rect") {
        shape = new f.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: "transparent", stroke: color, strokeWidth: stroke, strokeUniform: true });
      } else {
        shape = new f.Line([p.x, p.y, p.x, p.y], { stroke: color, strokeWidth: stroke });
      }
      canvas.add(shape);
      restoringRef.current = false;
    };
    const move = (e: { scenePoint: { x: number; y: number } }) => {
      if (!start || !shape) return;
      const p = e.scenePoint;
      if (shape instanceof f.Line) {
        shape.set({ x2: p.x, y2: p.y });
      } else {
        shape.set({
          left: Math.min(start.x, p.x),
          top: Math.min(start.y, p.y),
          width: Math.abs(p.x - start.x),
          height: Math.abs(p.y - start.y),
        });
      }
      canvas.requestRenderAll();
    };
    const up = () => {
      if (!start || !shape) return;
      const s = shape;
      start = null;
      shape = null;
      restoringRef.current = true;
      canvas.remove(s);
      restoringRef.current = false;
      if (s.width < 3 && s.height < 3 && !(s instanceof f.Line)) return;
      let final: FabricObject = s;
      if (tool === "arrow" && s instanceof f.Line) {
        const { x1, y1, x2, y2 } = s;
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 90;
        const head = new f.Triangle({
          left: x2,
          top: y2,
          originX: "center",
          originY: "center",
          width: stroke * 4,
          height: stroke * 4,
          angle,
          fill: color,
        });
        final = new f.Group([s, head]);
      }
      s.setCoords();
      canvas.add(final);
      toolsUsed.current.add(tool);
    };

    canvas.on("mouse:down", down);
    canvas.on("mouse:move", move);
    canvas.on("mouse:up", up);
    return () => {
      canvas.off("mouse:down", down);
      canvas.off("mouse:move", move);
      canvas.off("mouse:up", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, color, size, fontSize, ready]);

  // Keep the selected text/shape in sync with the colour picker.
  useEffect(() => {
    const active = canvasRef.current?.getActiveObject();
    if (!active || isHelper(active)) return;
    if ("text" in active) active.set({ fill: color });
    else if (active.stroke) active.set({ stroke: color });
    canvasRef.current?.requestRenderAll();
  }, [color]);

  const deleteSelected = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const active = canvas.getActiveObjects().filter((o) => !isHelper(o));
    if ((canvas.getActiveObject() as { isEditing?: boolean } | undefined)?.isEditing) return;
    active.forEach((o) => canvas.remove(o));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected]);

  // -------------------------------------------------------------------------
  // Undo / redo / reset / pages
  // -------------------------------------------------------------------------

  const restore = async (s: Snapshot) => {
    const d = docsRef.current[pageIdxRef.current];
    clearHelpers();
    d.base = s.base;
    d.objects = s.objects;
    setBase(s.base);
    await loadObjects(s.objects);
    syncHistoryLen(d);
  };

  const undo = async () => {
    const d = docsRef.current[pageIdxRef.current];
    if (d.history.length < 2) return;
    d.future.push(d.history.pop()!);
    await restore(d.history[d.history.length - 1]);
  };

  const redo = async () => {
    const d = docsRef.current[pageIdxRef.current];
    const next = d.future.pop();
    if (!next) return;
    d.history.push(next);
    await restore(next);
  };

  const resetPage = async () => {
    const d = docsRef.current[pageIdxRef.current];
    const first = d.history[0];
    d.history = [first];
    d.future = [];
    await restore(first);
  };

  const goTo = async (i: number) => {
    if (i < 0 || i >= pages.length || i === pageIdxRef.current) return;
    setTool("select");
    setStraightenDeg(0);
    saveCurrent();
    await showPage(i);
  };

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  const renderPageDoc = async (d: PageDoc): Promise<HTMLCanvasElement> => {
    if (d.objects.length === 0) return d.base;
    const f = fabricRef.current!;
    const el = document.createElement("canvas");
    const sc = new f.StaticCanvas(el, { width: d.base.width, height: d.base.height, enableRetinaScaling: false, backgroundColor: "#fff" });
    sc.backgroundImage = new f.FabricImage(d.base, { left: 0, top: 0 });
    const live = await f.util.enlivenObjects<FabricObject>(d.objects);
    live.forEach((o) => sc.add(o));
    sc.renderAll();
    const out = sc.toCanvasElement(1);
    void sc.dispose();
    return out;
  };

  const submit = async () => {
    setError("");
    clearHelpers();
    setStraightenDeg(0);
    saveCurrent();
    try {
      const out: EditedPage[] = [];
      for (const d of docsRef.current) {
        const c = await renderPageDoc(d);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.92));
        if (!blob) throw new Error("Couldn't prepare a page.");
        let widthPt = (c.width / d.pxPerMm) * PT_PER_MM;
        let heightPt = (c.height / d.pxPerMm) * PT_PER_MM;
        // The server needs at least an inch on each side.
        const grow = Math.max(1, 72 / Math.min(widthPt, heightPt));
        widthPt = Math.min(14400, widthPt * grow);
        heightPt = Math.min(14400, heightPt * grow);
        out.push({ blob, widthPt, heightPt });
        if (c !== d.base) c.width = 0;
      }
      await onSubmit(out, [...toolsUsed.current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the edit.");
    }
  };

  // -------------------------------------------------------------------------

  const toolBtn = (t: Tool, label: string, title: string) => (
    <button
      type="button"
      className={`tool-btn${tool === t ? " active" : ""}`}
      onClick={() => setTool(tool === t ? "select" : t)}
      title={title}
      aria-pressed={tool === t}
      disabled={!ready || busy}
    >
      {label}
    </button>
  );

  const tonePreview = `brightness(${1 + tone.brightness / 100}) contrast(${1 + tone.contrast / 100})${tone.grayscale ? " grayscale(1)" : ""}`;

  return (
    <div className="image-editor">
      <div className="editor-toolbar" role="toolbar" aria-label="Page editing tools">
        <div className="tool-group">
          <span className="tool-group-label">Fix</span>
          {toolBtn("crop", "Crop", "Drag the box edges, then Apply")}
          <button type="button" className="tool-btn" onClick={() => rotate(-1)} disabled={!ready || busy} title="Rotate left">
            ⟲ 90°
          </button>
          <button type="button" className="tool-btn" onClick={() => rotate(1)} disabled={!ready || busy} title="Rotate right">
            ⟳ 90°
          </button>
          {toolBtn("perspective", "Perspective", "Drag the 4 dots onto the page corners, then Apply")}
        </div>
        <div className="tool-group">
          <span className="tool-group-label">Paint</span>
          {toolBtn("whiteout", "Whiteout", "Drag to cover an area with white")}
          {toolBtn("eraser", "Eraser", "Paint white over marks")}
          {toolBtn("pen", "Pen", "Draw freehand")}
        </div>
        <div className="tool-group">
          <span className="tool-group-label">Add</span>
          {toolBtn("text", "Text", "Click where the text should go")}
          {toolBtn("rect", "Box", "Drag to draw a box")}
          {toolBtn("line", "Line", "Drag to draw a line")}
          {toolBtn("arrow", "Arrow", "Drag to draw an arrow")}
        </div>
        <div className="tool-group">
          <label className="tool-field" title="Colour">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour" />
          </label>
          <label className="tool-field">
            Size
            <input type="range" min={1} max={20} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
          <label className="tool-field">
            Text
            <input type="number" min={8} max={120} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value) || 28)} />
          </label>
        </div>
        <div className="tool-group">
          <button type="button" className="tool-btn" onClick={undo} disabled={!ready || busy || historyLen.undo < 1}>
            Undo
          </button>
          <button type="button" className="tool-btn" onClick={redo} disabled={!ready || busy || historyLen.redo < 1}>
            Redo
          </button>
          <button type="button" className="tool-btn" onClick={deleteSelected} disabled={!hasSelection || busy}>
            Delete
          </button>
          <button type="button" className="tool-btn" onClick={resetPage} disabled={!ready || busy || historyLen.undo < 1}>
            Reset page
          </button>
        </div>
      </div>

      {(tool === "crop" || tool === "perspective") && (
        <div className="tool-panel">
          <span>
            {tool === "crop"
              ? "Drag the box's edges and corners around the part to keep."
              : "Drag the four dots onto the corners of the paper in the photo."}
          </span>
          <button type="button" className="btn inline" onClick={tool === "crop" ? applyCrop : applyPerspective}>
            Apply
          </button>
          <button type="button" className="btn secondary inline" onClick={() => setTool("select")}>
            Cancel
          </button>
        </div>
      )}

      <div className="tool-panel">
        <label className="tool-field">
          Straighten {straightenDeg > 0 ? "+" : ""}
          {straightenDeg}°
          <input type="range" min={-15} max={15} step={0.5} value={straightenDeg} onChange={(e) => setStraightenDeg(Number(e.target.value))} />
        </label>
        <button type="button" className="tool-btn" onClick={applyStraighten} disabled={!straightenDeg || busy}>
          Apply
        </button>
        <span className="tool-sep" />
        <label className="tool-field">
          Brightness
          <input type="range" min={-60} max={60} value={tone.brightness} onChange={(e) => setTone({ ...tone, brightness: Number(e.target.value) })} />
        </label>
        <label className="tool-field">
          Contrast
          <input type="range" min={-60} max={80} value={tone.contrast} onChange={(e) => setTone({ ...tone, contrast: Number(e.target.value) })} />
        </label>
        <label className="tool-check">
          <input type="checkbox" checked={tone.grayscale} onChange={(e) => setTone({ ...tone, grayscale: e.target.checked })} /> B&amp;W
        </label>
        <label className="tool-check" title="Whitens the paper and removes shadows from phone photos">
          <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} /> Scan cleanup
        </label>
        <button
          type="button"
          className="tool-btn"
          onClick={applyTone}
          disabled={busy || (!cleanup && !tone.brightness && !tone.contrast && !tone.grayscale)}
        >
          Apply
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="editor-stage" ref={hostRef} style={{ filter: tonePreview }}>
        <canvas ref={elRef} />
        {!ready && <p className="hint">Loading editor…</p>}
      </div>

      <div className="editor-footer">
        {pages.length > 1 && (
          <div className="pager">
            <button type="button" className="tool-btn" onClick={() => goTo(pageIdx - 1)} disabled={pageIdx === 0 || busy}>
              ‹ Prev
            </button>
            <span>
              Page {pageIdx + 1} of {pages.length}
            </span>
            <button type="button" className="tool-btn" onClick={() => goTo(pageIdx + 1)} disabled={pageIdx === pages.length - 1 || busy}>
              Next ›
            </button>
          </div>
        )}
        <div className="row">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
            Discard edits
          </button>
          <button type="button" className="btn" onClick={submit} disabled={!ready || busy}>
            {busy ? "Sending…" : "Send to customer for approval"}
          </button>
        </div>
      </div>
    </div>
  );
}
