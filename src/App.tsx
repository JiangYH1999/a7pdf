import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Circle,
  Download,
  FileText,
  FilePlus2,
  Highlighter,
  ImagePlus,
  Menu,
  MessageSquareText,
  Minus,
  MousePointer2,
  PenLine,
  Plus,
  Redo2,
  RotateCw,
  RotateCcw,
  Scan,
  Copy,
  Check,
  Sparkles,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import { degrees, PDFDocument, type PDFImage } from "pdf-lib";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save } from "@tauri-apps/plugin-dialog";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { duplicatePages, pageCopyBatches, type ComposedPage, type PageStamp } from "./duplicatePages";
import { placeStamp } from "./stampPlacement";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

type Tool = "select" | "text" | "highlight" | "draw" | "image" | "comment" | "crop" | "overlay";
type DropTarget = "canvas" | "library" | null;
type PdfSource = {
  id: string;
  name: string;
  document: PDFDocumentProxy;
  data: Uint8Array;
  image?: ImageSource;
};
type ImageLayout = { x: number; y: number; width: number; height: number };
type ImageSource = {
  data: Uint8Array;
  format: "png" | "jpeg";
  pageWidth: number;
  pageHeight: number;
  original: ImageLayout;
  layout: ImageLayout;
};
type PageRegion = { pageId: string; x: number; y: number; width: number; height: number };
type CopiedRegion = { dataUrl: string; width: number; aspectRatio: number };
type CompositionBlock = {
  id: string;
  sourceId: string;
  pages: ComposedPage[];
  startIndex: number;
};

const READING_SCALE = 4;

async function buildImagePdf(image: ImageSource) {
  const pdf = await PDFDocument.create();
  const embedded = image.format === "png"
    ? await pdf.embedPng(image.data)
    : await pdf.embedJpg(image.data);
  const page = pdf.addPage([image.pageWidth, image.pageHeight]);
  page.drawImage(embedded, image.layout);
  return pdf.save();
}

function groupComposition(pages: ComposedPage[]) {
  const blocks: CompositionBlock[] = [];
  pages.forEach((page, index) => {
    const previous = blocks[blocks.length - 1];
    if (previous?.sourceId === page.sourceId) previous.pages.push(page);
    else blocks.push({ id: `${page.sourceId}:${page.id}`, sourceId: page.sourceId, pages: [page], startIndex: index });
  });
  return blocks;
}

function displayRotation(page: PDFPageProxy, rotation: number) {
  return (page.rotate + rotation) % 360;
}

function stampSize(region: CopiedRegion, pageAspectRatio: number) {
  const width = Math.min(region.width, 0.85, 0.85 * region.aspectRatio / pageAspectRatio);
  return { width, height: width * pageAspectRatio / region.aspectRatio };
}

type StampCorner = "nw" | "ne" | "sw" | "se";

function constrainStamp(stamp: PageStamp, pageWidth: number, pageHeight: number): PageStamp {
  const radians = stamp.rotation * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const halfWidth = (stamp.width * pageWidth * cosine + stamp.height * pageHeight * sine) / 2;
  const halfHeight = (stamp.width * pageWidth * sine + stamp.height * pageHeight * cosine) / 2;
  const scale = Math.min(1, pageWidth / (2 * halfWidth), pageHeight / (2 * halfHeight));
  const width = stamp.width * scale;
  const height = stamp.height * scale;
  const boundX = halfWidth * scale;
  const boundY = halfHeight * scale;
  const centerX = Math.max(boundX, Math.min(pageWidth - boundX, (stamp.x + stamp.width / 2) * pageWidth));
  const centerY = Math.max(boundY, Math.min(pageHeight - boundY, (stamp.y + stamp.height / 2) * pageHeight));
  return { ...stamp, width, height,
    x: (centerX - width * pageWidth / 2) / pageWidth,
    y: (centerY - height * pageHeight / 2) / pageHeight };
}

function resizeStamp(stamp: PageStamp, corner: StampCorner, dx: number, dy: number, pageWidth: number, pageHeight: number): PageStamp {
  const sx = corner.includes("e") ? 1 : -1;
  const sy = corner.includes("s") ? 1 : -1;
  const radians = stamp.rotation * Math.PI / 180;
  const vx = sx * stamp.width * pageWidth * Math.cos(radians) - sy * stamp.height * pageHeight * Math.sin(radians);
  const vy = sx * stamp.width * pageWidth * Math.sin(radians) + sy * stamp.height * pageHeight * Math.cos(radians);
  const scale = Math.max(0.08, Math.min(1 / stamp.width, 1 / stamp.height,
    1 + (dx * vx + dy * vy) / (vx * vx + vy * vy)));
  const width = stamp.width * scale;
  const height = stamp.height * scale;
  const centerX = (stamp.x + stamp.width / 2) * pageWidth + vx * (scale - 1) / 2;
  const centerY = (stamp.y + stamp.height / 2) * pageHeight + vy * (scale - 1) / 2;
  return { ...stamp, width, height,
    x: Math.max(0, Math.min(1 - width, (centerX - width * pageWidth / 2) / pageWidth)),
    y: Math.max(0, Math.min(1 - height, (centerY - height * pageHeight / 2) / pageHeight)) };
}

function overlayFromCanvas(canvas: HTMLCanvasElement): CopiedRegion {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width; let top = canvas.height; let right = -1; let bottom = -1;
  let hasTransparency = false;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = data[(y * canvas.width + x) * 4 + 3];
      if (alpha < 254) hasTransparency = true;
      if (alpha < 8) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error("No visible image");
  const trimmed = globalThis.document.createElement("canvas");
  trimmed.width = right - left + 1;
  trimmed.height = bottom - top + 1;
  trimmed.getContext("2d")?.drawImage(canvas, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
  return { dataUrl: trimmed.toDataURL("image/png"), width: hasTransparency ? 0.28 : 0.42,
    aspectRatio: trimmed.width / trimmed.height };
}

const tools: Array<{ id: Tool; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "选择", icon: MousePointer2 },
  { id: "text", label: "文本框", icon: Type },
  { id: "highlight", label: "高亮", icon: Highlighter },
  { id: "draw", label: "画笔", icon: PenLine },
  { id: "image", label: "图片页", icon: FilePlus2 },
  { id: "crop", label: "框选复制", icon: Scan },
  { id: "overlay", label: "添加图片", icon: ImagePlus },
  { id: "comment", label: "批注", icon: MessageSquareText },
];

function positionHits(
  position: { x: number; y: number },
  bounds: DOMRect | undefined,
) {
  if (!bounds) return false;
  const scale = window.devicePixelRatio || 1;
  return [
    position,
    { x: position.x / scale, y: position.y / scale },
  ].some(({ x, y }) => (
    x >= bounds.left
    && x <= bounds.right
    && y >= bounds.top
    && y <= bounds.bottom
  ));
}

function pageDropAt(position: { x: number; y: number }) {
  const scale = window.devicePixelRatio || 1;
  for (const point of [position, { x: position.x / scale, y: position.y / scale }]) {
    const element = globalThis.document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(".continuous-page");
    if (!element?.dataset.pageId) continue;
    const bounds = element.getBoundingClientRect();
    return { pageId: element.dataset.pageId,
      x: Math.max(0, Math.min(1, (point.x - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (point.y - bounds.top) / bounds.height)),
      pageAspectRatio: bounds.width / bounds.height };
  }
  return null;
}

type PageDrop = NonNullable<ReturnType<typeof pageDropAt>>;

function PdfCanvas({
  page,
  scale,
  rotation = 0,
  className = "",
}: {
  page: PDFPageProxy | null;
  scale: number;
  rotation?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!page || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const viewport = page.getViewport({ scale, rotation: displayRotation(page, rotation) });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const renderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    void renderTask.promise.catch((error: { name?: string }) => {
      if (error.name !== "RenderingCancelledException") console.error(error);
    });

    return () => {
      renderTask.cancel();
    };
  }, [page, rotation, scale]);

  return <canvas ref={canvasRef} className={className} />;
}

function Thumbnail({
  document,
  sourcePageNumber,
  sequenceNumber,
  rotation,
  stamps,
  selected,
  pageId,
  register,
  onSelect,
  onContextMenu,
  onPointerDragStart,
  compositionIndex,
  isDragging,
  isDropTarget,
}: {
  document: PDFDocumentProxy;
  sourcePageNumber: number;
  sequenceNumber: number;
  rotation: number;
  stamps: PageStamp[];
  selected: boolean;
  pageId: string;
  register: (pageId: string, element: HTMLDivElement | null) => void;
  onSelect: (event: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  onPointerDragStart: (position: { x: number; y: number }) => void;
  compositionIndex: number;
  isDragging: boolean;
  isDropTarget: boolean;
}) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const didDragRef = useRef(false);
  const thumbnailScale = page
    ? Math.min(
        86 / page.getViewport({ scale: 1, rotation: displayRotation(page, rotation) }).width,
        82 / page.getViewport({ scale: 1, rotation: displayRotation(page, rotation) }).height,
      )
    : 0.1;

  useEffect(() => {
    let active = true;
    document.getPage(sourcePageNumber).then((loaded) => active && setPage(loaded));
    return () => {
      active = false;
    };
  }, [document, sourcePageNumber]);

  return (
    <div
      className={`thumbnail ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""} ${isDropTarget ? "drop-target" : ""}`}
      ref={(element) => register(pageId, element)}
      data-composition-index={compositionIndex}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        didDragRef.current = false;
      }}
      onPointerMove={(event) => {
        const start = pointerStartRef.current;
        if (!start || start.pointerId !== event.pointerId || didDragRef.current) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
        didDragRef.current = true;
        onPointerDragStart({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        if (pointerStartRef.current?.pointerId === event.pointerId) pointerStartRef.current = null;
      }}
      onPointerCancel={() => {
        pointerStartRef.current = null;
      }}
      onClick={(event) => {
        if (didDragRef.current) {
          didDragRef.current = false;
          return;
        }
        onSelect(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="thumbnail-select">
      <div className="thumbnail-paper">
        <div className="thumbnail-layer">
          <PdfCanvas page={page} scale={thumbnailScale} rotation={rotation} />
          {stamps.map((stamp) => (
            <img key={stamp.id} className="page-stamp" src={stamp.dataUrl} alt="" draggable={false} style={{
              left: `${stamp.x * 100}%`, top: `${stamp.y * 100}%`, width: `${stamp.width * 100}%`, height: `${stamp.height * 100}%`,
              transform: `rotate(${stamp.rotation}deg)`,
            }} />
          ))}
        </div>
      </div>
      <span>{sequenceNumber}</span>
      </div>
    </div>
  );
}

function PdfBlock({
  block,
  source,
  expanded,
  onToggle,
  onPointerDragStart,
  isDragging,
  isDropTarget,
  dropPosition,
}: {
  block: CompositionBlock;
  source: PdfSource;
  expanded: boolean;
  onToggle: () => void;
  onPointerDragStart: (position: { x: number; y: number }) => void;
  isDragging: boolean;
  isDropTarget: boolean;
  dropPosition: "before" | "after";
}) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const didDragRef = useRef(false);

  useEffect(() => {
    let active = true;
    source.document.getPage(block.pages[0].pageNumber).then((loaded) => active && setPage(loaded));
    return () => { active = false; };
  }, [block.pages[0].pageNumber, source.document]);

  const rotation = block.pages[0].rotation;
  const scale = page
    ? Math.min(52 / page.getViewport({ scale: 1, rotation: displayRotation(page, rotation) }).width, 62 / page.getViewport({ scale: 1, rotation: displayRotation(page, rotation) }).height)
    : 0.1;

  return (
    <div
      className={`pdf-block ${expanded ? "expanded" : ""} ${isDragging ? "dragging" : ""} ${isDropTarget ? `drop-${dropPosition}` : ""}`}
      data-composition-block={block.id}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        didDragRef.current = false;
      }}
      onPointerMove={(event) => {
        const start = pointerStartRef.current;
        if (!start || start.pointerId !== event.pointerId || didDragRef.current) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
        didDragRef.current = true;
        onPointerDragStart({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        if (pointerStartRef.current?.pointerId === event.pointerId) pointerStartRef.current = null;
      }}
      onPointerCancel={() => { pointerStartRef.current = null; }}
      onClick={() => {
        if (didDragRef.current) {
          didDragRef.current = false;
          return;
        }
        onToggle();
      }}
    >
      <div className="pdf-block-summary">
        <div className="pdf-block-paper"><PdfCanvas page={page} scale={scale} rotation={rotation} /></div>
        <span className="pdf-block-copy"><strong>{source.name}</strong><small>{block.pages.length} 页</small></span>
        <ChevronDown className="pdf-block-chevron" size={15} />
      </div>
    </div>
  );
}

function DragPreview({
  document,
  sourcePageNumber,
  sequenceNumber,
  rotation,
  count = 1,
  position,
}: {
  document: PDFDocumentProxy;
  sourcePageNumber: number;
  sequenceNumber: number;
  rotation: number;
  count?: number;
  position: { x: number; y: number };
}) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);

  useEffect(() => {
    let active = true;
    document.getPage(sourcePageNumber).then((loaded) => active && setPage(loaded));
    return () => {
      active = false;
    };
  }, [document, sourcePageNumber]);

  const scale = page
    ? Math.min(92 / page.getViewport({ scale: 1, rotation: displayRotation(page, rotation) }).width, 112 / page.getViewport({ scale: 1, rotation: displayRotation(page, rotation) }).height)
    : 0.1;
  const stackDepth = Math.min(count - 1, 4);

  return (
    <div className={`page-drag-preview ${count > 1 ? "multi" : ""}`} style={{ left: position.x, top: position.y }} aria-hidden="true">
      {count > 1 && (
        <div className="page-drag-preview-stack">
          {Array.from({ length: stackDepth }, (_, index) => (
            <i
              key={index}
              style={{
                transform: `translate(-${(index + 1) * 5}px, -${(index + 1) * 6}px)`,
                zIndex: stackDepth - index,
              }}
            />
          ))}
        </div>
      )}
      <div className="page-drag-preview-paper"><PdfCanvas page={page} scale={scale} rotation={rotation} /></div>
      {count > 1 && <b className="page-drag-current">第{sequenceNumber}页</b>}
      <span>{count > 1 ? `共${count}页` : sequenceNumber}</span>
    </div>
  );
}

function ContinuousPage({
  document,
  pageId,
  pageNumber,
  sequenceNumber,
  rotation,
  canvasSize,
  zoom,
  register,
  cropActive,
  stampEditingActive,
  pasteActive,
  clipboardPreview,
  selection,
  stamps,
  selectedStampId,
  onSelectRegion,
  onPaste,
  onCopy,
  onSelectStamp,
  onUpdateStamp,
}: {
  document: PDFDocumentProxy;
  pageId: string;
  pageNumber: number;
  sequenceNumber: number;
  rotation: number;
  canvasSize: { width: number; height: number };
  zoom: number;
  register: (pageNumber: number, element: HTMLDivElement | null) => void;
  cropActive: boolean;
  stampEditingActive: boolean;
  pasteActive: boolean;
  clipboardPreview: CopiedRegion | null;
  selection: PageRegion | null;
  stamps: PageStamp[];
  selectedStampId: string | null;
  onSelectRegion: (region: PageRegion | null) => void;
  onPaste: (pageId: string, x: number, y: number, pageAspectRatio: number) => void;
  onCopy: () => void;
  onSelectStamp: (id: string | null) => void;
  onUpdateStamp: (pageId: string, stampId: string, layout: Pick<PageStamp, "x" | "y" | "width" | "height" | "rotation">) => void;
}) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const pageContainerRef = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const selectionStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [pastePoint, setPastePoint] = useState<{ x: number; y: number } | null>(null);
  const [stampDraft, setStampDraft] = useState<PageStamp | null>(null);
  const stampDraftRef = useRef<PageStamp | null>(null);
  const stampDrag = useRef<{ pointerId: number; startX: number; startY: number; stamp: PageStamp;
    mode: "move" | "resize" | "rotate"; corner?: StampCorner } | null>(null);

  const pointOnPage = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  useEffect(() => {
    let active = true;
    document.getPage(pageNumber).then((loaded) => active && setPage(loaded));
    return () => {
      active = false;
    };
  }, [document, pageNumber]);

  useEffect(() => {
    const element = pageContainerRef.current;
    if (!element) return;
    const root = element.closest<HTMLDivElement>(".canvas-scroll");
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { root, rootMargin: "900px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewport = page?.getViewport({ scale: 1, rotation: displayRotation(page, rotation) });
  const previewSize = clipboardPreview ? stampSize(clipboardPreview, viewport ? viewport.width / viewport.height : 1) : null;
  const fitScale = viewport
    ? Math.min(
        Math.max(canvasSize.width - 120, 240) / viewport.width,
        Math.max(canvasSize.height - 120, 240) / viewport.height,
      )
    : 1;

  return (
    <div
      className={`continuous-page ${cropActive ? "crop-active" : ""} ${pasteActive ? "paste-active" : ""}`}
      data-page-number={sequenceNumber}
      data-page-id={pageId}
      ref={(element) => {
        pageContainerRef.current = element;
        register(sequenceNumber, element);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        if (!cropActive) {
          if (stampEditingActive) onSelectStamp(null);
          return;
        }
        const point = pointOnPage(event);
        if (pasteActive) {
          const bounds = event.currentTarget.getBoundingClientRect();
          onPaste(pageId, point.x, point.y, bounds.width / bounds.height);
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        selectionStart.current = { ...point, pointerId: event.pointerId };
        onSelectRegion({ pageId, ...point, width: 0, height: 0 });
      }}
      onPointerMove={(event) => {
        if (cropActive && pasteActive) setPastePoint(pointOnPage(event));
        const start = selectionStart.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const point = pointOnPage(event);
        onSelectRegion({
          pageId,
          x: Math.min(start.x, point.x),
          y: Math.min(start.y, point.y),
          width: Math.abs(point.x - start.x),
          height: Math.abs(point.y - start.y),
        });
      }}
      onPointerUp={(event) => {
        if (selectionStart.current?.pointerId === event.pointerId) selectionStart.current = null;
      }}
      onPointerCancel={() => { selectionStart.current = null; }}
      onPointerLeave={() => setPastePoint(null)}
    >
      {nearViewport ? (
        <PdfCanvas page={page} scale={fitScale * READING_SCALE * (zoom / 100)} rotation={rotation} className="main-pdf-page" />
      ) : (
        <div className="main-pdf-placeholder" style={{
          width: viewport ? viewport.width * fitScale * READING_SCALE * (zoom / 100) : 600,
          height: viewport ? viewport.height * fitScale * READING_SCALE * (zoom / 100) : 800,
        }} />
      )}
      {stamps.map((stamp) => {
        const layout = stampDraft?.id === stamp.id ? stampDraft : stamp;
        return stampEditingActive ? (
          <div key={stamp.id} className={`page-stamp-editor ${selectedStampId === stamp.id ? "selected" : ""}`}
            style={{ left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${layout.width * 100}%`, height: `${layout.height * 100}%`,
              transform: `rotate(${layout.rotation}deg)` }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelectStamp(stamp.id);
              stampDraftRef.current = null;
              const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-stamp-handle]");
              stampDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
                stamp: layout, mode: handle?.dataset.stampHandle === "rotate" ? "rotate" : handle ? "resize" : "move",
                corner: handle?.dataset.stampHandle as StampCorner | undefined };
            }}
            onPointerMove={(event) => {
              const drag = stampDrag.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const bounds = pageContainerRef.current?.getBoundingClientRect();
              if (!bounds) return;
              const dx = event.clientX - drag.startX;
              const dy = event.clientY - drag.startY;
              let next: PageStamp;
              if (drag.mode === "resize" && drag.corner) {
                next = resizeStamp(drag.stamp, drag.corner, dx, dy, bounds.width, bounds.height);
              } else if (drag.mode === "rotate") {
                const centerX = bounds.left + (drag.stamp.x + drag.stamp.width / 2) * bounds.width;
                const centerY = bounds.top + (drag.stamp.y + drag.stamp.height / 2) * bounds.height;
                const startAngle = Math.atan2(drag.startY - centerY, drag.startX - centerX);
                const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
                next = { ...drag.stamp, rotation: (drag.stamp.rotation + (angle - startAngle) * 180 / Math.PI + 360) % 360 };
              } else {
                next = { ...drag.stamp,
                  x: Math.max(0, Math.min(1 - drag.stamp.width, drag.stamp.x + dx / bounds.width)),
                  y: Math.max(0, Math.min(1 - drag.stamp.height, drag.stamp.y + dy / bounds.height)) };
              }
              const constrained = constrainStamp(next, bounds.width, bounds.height);
              stampDraftRef.current = constrained;
              setStampDraft(constrained);
            }}
            onPointerUp={(event) => {
              if (stampDrag.current?.pointerId !== event.pointerId) return;
              if (stampDraftRef.current?.id === stamp.id) onUpdateStamp(pageId, stamp.id, stampDraftRef.current);
              stampDrag.current = null;
              stampDraftRef.current = null;
              setStampDraft(null);
            }}
            onPointerCancel={() => { stampDrag.current = null; stampDraftRef.current = null; setStampDraft(null); }}
          >
            <img src={stamp.dataUrl} alt="页面图片" draggable={false} />
            {selectedStampId === stamp.id && (
              <>
                {(["nw", "ne", "sw", "se"] as StampCorner[]).map((corner) => (
                  <span key={corner} className={`page-stamp-handle corner-${corner}`} data-stamp-handle={corner}
                    aria-label={`从${corner}角调整大小`} />
                ))}
                <span className="page-stamp-rotate" data-stamp-handle="rotate" aria-label="旋转图片"><RotateCw size={14} /></span>
                <button className="page-stamp-confirm" title="完成编辑" style={{ transform: `rotate(${-layout.rotation}deg)` }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); onSelectStamp(null); }}><Check size={14} />完成</button>
              </>
            )}
          </div>
        ) : (
          <img key={stamp.id} className="page-stamp" src={stamp.dataUrl} alt="" draggable={false} style={{
            left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${layout.width * 100}%`, height: `${layout.height * 100}%`,
            transform: `rotate(${layout.rotation}deg)`,
          }} />
        );
      })}
      {cropActive && pasteActive && pastePoint && clipboardPreview && previewSize && (
        <img className="page-paste-preview" src={clipboardPreview.dataUrl} alt="" draggable={false} style={{
          left: `${Math.max(0, Math.min(1 - previewSize.width, pastePoint.x - previewSize.width / 2)) * 100}%`,
          top: `${Math.max(0, Math.min(1 - previewSize.height, pastePoint.y - previewSize.height / 2)) * 100}%`,
          width: `${previewSize.width * 100}%`, height: `${previewSize.height * 100}%`,
        }} />
      )}
      {cropActive && selection?.pageId === pageId && selection.width > 0 && selection.height > 0 && (
        <>
          <div className="page-region" style={{
            left: `${selection.x * 100}%`, top: `${selection.y * 100}%`,
            width: `${selection.width * 100}%`, height: `${selection.height * 100}%`,
          }} />
          {!pasteActive && (
            <button className="page-region-copy" style={{
              left: `${selection.x * 100}%`, top: `${Math.min(1, selection.y + selection.height) * 100}%`,
            }} onClick={onCopy}><Copy size={14} />复制选区</button>
          )}
        </>
      )}
    </div>
  );
}

function EmptyDocument({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="empty-document">
      <div className="empty-art">
        <div className="paper-back" />
        <div className="paper-front">
          <span className="paper-badge">PDF</span>
          <i />
          <i />
          <i className="short" />
        </div>
        <div className="sparkle"><Sparkles size={21} /></div>
      </div>
      <button className="primary-button" onClick={onOpen}>
        <FilePlus2 size={18} />
        打开 PDF
      </button>
      <p className="shortcut">也可以将文件拖放到此处</p>
    </section>
  );
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const overlayInputRef = useRef<HTMLInputElement>(null);
  const canvasAreaRef = useRef<HTMLElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const thumbnailsRef = useRef<HTMLDivElement>(null);
  const thumbnailElementsRef = useRef(new Map<string, HTMLDivElement>());
  const thumbnailPositionsRef = useRef(new Map<string, DOMRect>());
  const pageContextMenuRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<HTMLElement>(null);
  const sourcesRef = useRef<PdfSource[]>([]);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const scrollFrameRef = useRef<number | null>(null);
  const [sources, setSources] = useState<PdfSource[]>([]);
  const [composition, setComposition] = useState<ComposedPage[]>([]);
  const compositionRef = useRef<ComposedPage[]>([]);
  const historyRef = useRef<ComposedPage[][]>([[]]);
  const historyIndexRef = useRef(0);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historyLength, setHistoryLength] = useState(1);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [imageAdjusting, setImageAdjusting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ value: 0, stage: "" });
  const [error, setError] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [draggedPageIndex, setDraggedPageIndex] = useState<number | null>(null);
  const [draggedPageIds, setDraggedPageIds] = useState<Set<string>>(new Set());
  const [dropPageIndex, setDropPageIndex] = useState<number | null>(null);
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);
  const [dropBlockId, setDropBlockId] = useState<string | null>(null);
  const [dropBlockPosition, setDropBlockPosition] = useState<"before" | "after">("before");
  const [expandedBlockIds, setExpandedBlockIds] = useState<Set<string>>(new Set());
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number } | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState<number | null>(null);
  const [selectionFocusIndex, setSelectionFocusIndex] = useState<number | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<PageRegion | null>(null);
  const [copiedRegion, setCopiedRegion] = useState<CopiedRegion | null>(null);
  const [selectedStampId, setSelectedStampId] = useState<string | null>(null);
  const [pasteActive, setPasteActive] = useState(false);
  const [pageContextMenu, setPageContextMenu] = useState<{ x: number; y: number; pageId: string } | null>(null);
  const activeSource = sources.find((source) => source.id === activeSourceId) ?? null;
  const document = activeSource?.document ?? null;
  const fileName = activeSource?.name ?? "未命名文档";
  const currentComposedPage = composition[pageNumber - 1];
  const currentImageSource = currentComposedPage
    ? sources.find((source) => source.id === currentComposedPage.sourceId && source.image)?.image
    : undefined;
  const compositionBlocks = groupComposition(composition);

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useLayoutEffect(() => {
    const previousPositions = thumbnailPositionsRef.current;
    const nextPositions = new Map<string, DOMRect>();
    thumbnailElementsRef.current.forEach((element, pageId) => {
      const next = element.getBoundingClientRect();
      const previous = previousPositions.get(pageId);
      if (previous) {
        const deltaY = previous.top - next.top;
        if (Math.abs(deltaY) > 1) {
          element.getAnimations().forEach((animation) => animation.cancel());
          element.animate(
            [
              { transform: `translateY(${deltaY}px)` },
              { transform: "translateY(0)" },
            ],
            { duration: 360, easing: "cubic-bezier(.16, 1, .3, 1)" },
          );
        }
      }
      nextPositions.set(pageId, next);
    });
    thumbnailPositionsRef.current = nextPositions;
  }, [composition]);

  useEffect(() => {
    if (!pageContextMenu) return;
    const closeMenu = (event: PointerEvent) => {
      if (!pageContextMenuRef.current?.contains(event.target as Node)) setPageContextMenu(null);
    };
    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [pageContextMenu]);

  useEffect(() => {
    const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
    if (!tauriWindow.__TAURI_INTERNALS__) return;

    let disposed = false;
    let removeListener: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type === "over") {
          const libraryBounds = libraryRef.current?.getBoundingClientRect();
          const canvasBounds = canvasAreaRef.current?.getBoundingClientRect();
          const overLibrary = positionHits(event.payload.position, libraryBounds);
          const overCanvas = positionHits(event.payload.position, canvasBounds);
          setDropTarget(overLibrary ? "library" : overCanvas ? "canvas" : null);
          return;
        }

        if (event.payload.type === "leave") {
          setDropTarget(null);
          return;
        }
        if (event.payload.type !== "drop") return;

        const libraryBounds = libraryRef.current?.getBoundingClientRect();
        const canvasBounds = canvasAreaRef.current?.getBoundingClientRect();
        const droppedOnLibrary = positionHits(event.payload.position, libraryBounds);
        const droppedOnCanvas = positionHits(event.payload.position, canvasBounds);
        const imagePaths = event.payload.paths.filter((path) => /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(path));
        const pdfPaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith(".pdf"));
        setDropTarget(null);
        if (droppedOnCanvas && imagePaths.length && compositionRef.current.length) {
          const target = pageDropAt(event.payload.position);
          if (!target) { setError("请将图片放在具体的 PDF 页面上。"); return; }
          try {
            for (const path of imagePaths) {
              const bytes = await invoke<number[]>("read_image_file", { path });
              const name = path.split(/[\\/]/).pop() || "image.png";
              await openOverlayFile(new File([new Uint8Array(bytes)], name), target);
            }
          } catch { setError("无法读取拖入的图片，请检查文件格式或访问权限。"); }
          return;
        }
        if (!pdfPaths.length) {
          setError("请拖入一个 PDF 文件。");
          return;
        }
        if (!droppedOnLibrary && (!droppedOnCanvas || sourcesRef.current.length > 0)) {
          setError("如需继续添加 PDF，请拖放到右侧的资源管理区域。");
          return;
        }
        await openNativePaths(pdfPaths);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else removeListener = unlisten;
      })
      .catch(() => setError("无法启用系统拖放，请使用“打开 PDF”按钮。"));

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);

  function commitComposition(next: ComposedPage[], resetHistory = false) {
    compositionRef.current = next;
    setComposition(next);
    if (resetHistory) {
      historyRef.current = [next];
      historyIndexRef.current = 0;
    } else {
      const nextHistory = [...historyRef.current.slice(0, historyIndexRef.current + 1), next];
      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length - 1;
    }
    setHistoryIndex(historyIndexRef.current);
    setHistoryLength(historyRef.current.length);
  }

  function undoComposition() {
    if (historyIndexRef.current === 0) return;
    historyIndexRef.current -= 1;
    const previous = historyRef.current[historyIndexRef.current];
    compositionRef.current = previous;
    setComposition(previous);
    setHistoryIndex(historyIndexRef.current);
    setPageNumber((current) => Math.min(Math.max(current, 1), Math.max(previous.length, 1)));
  }

  function redoComposition() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    const next = historyRef.current[historyIndexRef.current];
    compositionRef.current = next;
    setComposition(next);
    setHistoryIndex(historyIndexRef.current);
    setPageNumber((current) => Math.min(Math.max(current, 1), Math.max(next.length, 1)));
  }

  function selectPagesThrough(index: number, anchor = selectionAnchorIndex ?? index) {
    const [start, end] = [Math.min(anchor, index), Math.max(anchor, index)];
    setSelectedPageIds(new Set(composition.slice(start, end + 1).map((page) => page.id)));
    setSelectionAnchorIndex(anchor);
    setSelectionFocusIndex(index);
  }

  function selectCompositionPage(index: number, event: ReactMouseEvent<HTMLElement>) {
    const page = composition[index];
    if (!page) return;
    if (event.shiftKey) {
      selectPagesThrough(index);
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedPageIds((current) => {
        const next = new Set(current);
        if (next.has(page.id)) next.delete(page.id);
        else next.add(page.id);
        return next;
      });
      setSelectionAnchorIndex(index);
      setSelectionFocusIndex(index);
    } else {
      setSelectedPageIds(new Set([page.id]));
      setSelectionAnchorIndex(index);
      setSelectionFocusIndex(index);
      changePage(index + 1);
    }
  }

  function openPageContextMenu(index: number, position: { x: number; y: number }) {
    const page = composition[index];
    if (!page) return;
    if (!selectedPageIds.has(page.id)) {
      setSelectedPageIds(new Set([page.id]));
      setSelectionAnchorIndex(index);
      setSelectionFocusIndex(index);
    }
    setPageContextMenu({ ...position, pageId: page.id });
  }

  function copySelectedPages(fallbackPageId?: string) {
    const ids = selectedPageIds.size ? selectedPageIds : new Set(fallbackPageId ? [fallbackPageId] : []);
    const selected = composition.filter((page) => ids.has(page.id));
    if (!selected.length) return;
    const copies = duplicatePages(selected);
    const lastSelectedIndex = composition.reduce((last, page, index) => ids.has(page.id) ? index : last, -1);
    const next = [...composition];
    next.splice(lastSelectedIndex + 1, 0, ...copies);
    commitComposition(next);
    // Keep the originals selected so the inserted copies are visibly placed after them.
    setSelectedPageIds(new Set(selected.map((page) => page.id)));
  }

  function deleteSelectedPages(fallbackPageId?: string) {
    const ids = selectedPageIds.size ? selectedPageIds : new Set(fallbackPageId ? [fallbackPageId] : []);
    if (!ids.size) return;
    const next = composition.filter((page) => !ids.has(page.id));
    commitComposition(next);
    setSelectedPageIds(new Set());
    setSelectionAnchorIndex(null);
    setSelectionFocusIndex(null);
    setPageNumber((current) => Math.max(1, Math.min(current, next.length)));
  }

  async function copySelectedRegion() {
    const region = selectedRegion;
    if (!region || region.width < 0.003 || region.height < 0.003) return;
    const index = compositionRef.current.findIndex((page) => page.id === region.pageId);
    if (index < 0) return;
    const stamps = compositionRef.current[index].stamps;
    const canvas = pageElementsRef.current.get(index + 1)?.querySelector<HTMLCanvasElement>(".main-pdf-page");
    if (!canvas?.width || !canvas.height) return;
    const x = Math.floor(region.x * canvas.width);
    const y = Math.floor(region.y * canvas.height);
    const width = Math.min(canvas.width - x, Math.max(1, Math.ceil(region.width * canvas.width)));
    const height = Math.min(canvas.height - y, Math.max(1, Math.ceil(region.height * canvas.height)));
    const clipped = globalThis.document.createElement("canvas");
    clipped.width = width;
    clipped.height = height;
    const context = clipped.getContext("2d");
    if (!context) return;
    context.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    try {
      // Stamps are separate DOM images above the PDF canvas. Composite them in
      // display order so a second selection captures what the user actually sees.
      const images = await Promise.all(stamps.map(async (stamp) => {
        const image = new Image();
        image.src = stamp.dataUrl;
        await image.decode();
        return image;
      }));
      stamps.forEach((stamp, stampIndex) => {
        context.save();
        context.translate((stamp.x + stamp.width / 2) * canvas.width - x,
          (stamp.y + stamp.height / 2) * canvas.height - y);
        context.rotate(stamp.rotation * Math.PI / 180);
        context.drawImage(images[stampIndex], -stamp.width * canvas.width / 2,
          -stamp.height * canvas.height / 2, stamp.width * canvas.width, stamp.height * canvas.height);
        context.restore();
      });
      setCopiedRegion({ dataUrl: clipped.toDataURL("image/png"), width: region.width,
        aspectRatio: clipped.width / clipped.height });
      setSelectedRegion(null);
      setPasteActive(true);
    } catch {
      setError("无法读取页面贴片，请稍后重试复制。");
    }
  }

  function pasteCopiedRegion(pageId: string, centerX: number, centerY: number, pageAspectRatio: number) {
    if (!copiedRegion) return;
    placeRegion(copiedRegion, { pageId, x: centerX, y: centerY, pageAspectRatio });
  }

  function placeRegion(region: CopiedRegion, target: PageDrop) {
    const { width, height } = stampSize(region, target.pageAspectRatio);
    const stamp: PageStamp = {
      id: crypto.randomUUID(), dataUrl: region.dataUrl,
      width, height,
      x: Math.max(0, Math.min(1 - width, target.x - width / 2)),
      y: Math.max(0, Math.min(1 - height, target.y - height / 2)),
      rotation: 0,
    };
    commitComposition(compositionRef.current.map((page) => (
      page.id === target.pageId ? { ...page, stamps: [...page.stamps, stamp] } : page
    )));
    setPasteActive(false);
    setActiveTool("select");
    setSelectedStampId(stamp.id);
  }

  function updateStamp(pageId: string, stampId: string, layout: Pick<PageStamp, "x" | "y" | "width" | "height" | "rotation">) {
    const page = compositionRef.current.find((item) => item.id === pageId);
    const stamp = page?.stamps.find((item) => item.id === stampId);
    if (!stamp || (stamp.x === layout.x && stamp.y === layout.y && stamp.width === layout.width
      && stamp.height === layout.height && stamp.rotation === layout.rotation)) return;
    commitComposition(compositionRef.current.map((item) => item.id === pageId
      ? { ...item, stamps: item.stamps.map((entry) => entry.id === stampId ? { ...entry, ...layout } : entry) }
      : item));
  }

  function registerThumbnail(pageId: string, element: HTMLDivElement | null) {
    if (element) thumbnailElementsRef.current.set(pageId, element);
    else thumbnailElementsRef.current.delete(pageId);
  }

  function captureThumbnailPositions() {
    const positions = new Map<string, DOMRect>();
    thumbnailElementsRef.current.forEach((element, pageId) => positions.set(pageId, element.getBoundingClientRect()));
    thumbnailPositionsRef.current = positions;
  }

  function beginPageDrag(index: number, position: { x: number; y: number }) {
    const page = composition[index];
    if (!page) return;
    const ids = selectedPageIds.has(page.id) ? selectedPageIds : new Set([page.id]);
    if (!selectedPageIds.has(page.id)) {
      setSelectedPageIds(ids);
      setSelectionAnchorIndex(index);
      setSelectionFocusIndex(index);
    }
    setDragPointer(position);
    setDraggedPageIds(ids);
    setDraggedPageIndex(index);
  }

  function toggleBlock(blockId: string) {
    setExpandedBlockIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }

  function moveBlock(blockId: string, targetBlockId: string, position: "before" | "after") {
    if (blockId === targetBlockId) return;
    const blocks = groupComposition(compositionRef.current);
    const moving = blocks.find((block) => block.id === blockId);
    const target = blocks.find((block) => block.id === targetBlockId);
    if (!moving || !target) return;
    const movingIds = new Set(moving.pages.map((page) => page.id));
    const remaining = compositionRef.current.filter((page) => !movingIds.has(page.id));
    const targetIndex = remaining.findIndex((page) => page.id === target.pages[0].id);
    if (targetIndex < 0) return;
    const insertAt = targetIndex + (position === "after" ? target.pages.length : 0);
    remaining.splice(insertAt, 0, ...moving.pages);
    if (remaining.every((page, index) => page.id === compositionRef.current[index]?.id)) return;
    commitComposition(remaining);
  }

  function beginBlockDrag(blockId: string, position: { x: number; y: number }) {
    setDragPointer(position);
    setDraggedBlockId(blockId);
  }

  useEffect(() => {
    if (draggedPageIndex === null) return;

    let lastPointer: { x: number; y: number } | null = null;
    let scrollFrame: number | null = null;

    const findDropTarget = (clientX: number, clientY: number) => {
      const target = globalThis.document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-composition-index]");
      const index = Number(target?.dataset.compositionIndex);
      setDropPageIndex(Number.isInteger(index) ? index : null);
    };
    const finishDrag = () => {
      if (dropPageIndex !== null && !draggedPageIds.has(compositionRef.current[dropPageIndex]?.id)) {
        movePages(draggedPageIds, dropPageIndex);
      }
      setDraggedPageIndex(null);
      setDraggedPageIds(new Set());
      setDropPageIndex(null);
      setDragPointer(null);
    };
    const handlePointerMove = (event: PointerEvent) => {
      lastPointer = { x: event.clientX, y: event.clientY };
      setDragPointer({ x: event.clientX, y: event.clientY });
      findDropTarget(event.clientX, event.clientY);
      if (scrollFrame === null) scrollFrame = requestAnimationFrame(autoScroll);
    };
    const autoScroll = () => {
      scrollFrame = null;
      const list = thumbnailsRef.current;
      if (!list || !lastPointer) return;
      const bounds = list.getBoundingClientRect();
      if (lastPointer.x < bounds.left || lastPointer.x > bounds.right) return;
      const edgeSize = 54;
      const fromTop = lastPointer.y - bounds.top;
      const fromBottom = bounds.bottom - lastPointer.y;
      const direction = fromTop < edgeSize ? -1 : fromBottom < edgeSize ? 1 : 0;
      if (!direction) return;

      const intensity = direction < 0
        ? Math.max(0.25, 1 - fromTop / edgeSize)
        : Math.max(0.25, 1 - fromBottom / edgeSize);
      list.scrollTop += direction * (4 + intensity * 12);
      findDropTarget(lastPointer.x, lastPointer.y);
      scrollFrame = requestAnimationFrame(autoScroll);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag, { once: true });
    window.addEventListener("pointercancel", finishDrag, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    };
  }, [draggedPageIndex, draggedPageIds, dropPageIndex]);

  useEffect(() => {
    if (!draggedBlockId) return;
    let lastPointer: { x: number; y: number } | null = null;
    let scrollFrame: number | null = null;
    const findTarget = (x: number, y: number) => {
      const target = globalThis.document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-composition-block]");
      setDropBlockId(target?.dataset.compositionBlock ?? null);
      if (target) setDropBlockPosition(y < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 ? "before" : "after");
    };
    const autoScroll = () => {
      scrollFrame = null;
      const list = thumbnailsRef.current;
      if (!list || !lastPointer) return;
      const bounds = list.getBoundingClientRect();
      if (lastPointer.x < bounds.left || lastPointer.x > bounds.right) return;
      const edge = 54;
      const direction = lastPointer.y - bounds.top < edge ? -1 : bounds.bottom - lastPointer.y < edge ? 1 : 0;
      if (!direction) return;
      list.scrollTop += direction * 12;
      findTarget(lastPointer.x, lastPointer.y);
      scrollFrame = requestAnimationFrame(autoScroll);
    };
    const move = (event: PointerEvent) => {
      lastPointer = { x: event.clientX, y: event.clientY };
      setDragPointer(lastPointer);
      findTarget(event.clientX, event.clientY);
      if (scrollFrame === null) scrollFrame = requestAnimationFrame(autoScroll);
    };
    const finish = () => {
      if (dropBlockId && dropBlockId !== draggedBlockId) moveBlock(draggedBlockId, dropBlockId, dropBlockPosition);
      setDraggedBlockId(null);
      setDropBlockId(null);
      setDragPointer(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    };
  }, [draggedBlockId, dropBlockId, dropBlockPosition]);

  useEffect(() => {
    const element = canvasScrollRef.current;
    if (!element) return;

    const updateSize = () => {
      setCanvasSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeTool === "crop") {
        setPasteActive(false);
        setSelectedRegion(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && activeTool === "crop") {
        if (event.key.toLowerCase() === "c" && selectedRegion) {
          event.preventDefault();
          copySelectedRegion();
          return;
        }
        if (event.key.toLowerCase() === "v" && copiedRegion) {
          event.preventDefault();
          setPasteActive(true);
          return;
        }
      }
      if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && composition.length) {
        event.preventDefault();
        const direction = event.key === "ArrowUp" ? -1 : 1;
        const focus = selectionFocusIndex ?? pageNumber - 1;
        const nextIndex = Math.max(0, Math.min(composition.length - 1, focus + direction));
        selectPagesThrough(nextIndex, selectionAnchorIndex ?? focus);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedPageIds(new Set(composition.map((page) => page.id)));
        setSelectionAnchorIndex(0);
        setSelectionFocusIndex(composition.length - 1);
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedPageIds.size) {
        event.preventDefault();
        deleteSelectedPages();
        return;
      }
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoComposition();
        else undoComposition();
        return;
      }
      if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoComposition();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((value) => Math.min(400, value + 10));
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom((value) => Math.max(10, value - 10));
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom(100);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composition, pageNumber, selectedPageIds, selectionAnchorIndex, selectionFocusIndex, activeTool, selectedRegion, copiedRegion]);

  async function openFile(file?: File) {
    if (!file) return;
    setLoading(true);
    setError("");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const loadedDocument = await getDocument({ data: data.slice() }).promise;
      addSource(file.name, loadedDocument, data);
    } catch {
      setError("无法打开此 PDF，请确认文件没有损坏或加密。");
    } finally {
      setLoading(false);
    }
  }

  async function openImageFile(file?: File) {
    if (!file) return;
    const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
    const isJpeg = file.type === "image/jpeg" || file.name.toLowerCase().match(/\.jpe?g$/);
    if (!isPng && !isJpeg) {
      setError("请选择 JPG 或 PNG 图片。");
      return;
    }
    setLoading(true);
    setError("");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    try {
      const imageData = new Uint8Array(await file.arrayBuffer());
      const imagePdf = await PDFDocument.create();
      const embeddedImage = isPng
        ? await imagePdf.embedPng(imageData)
        : await imagePdf.embedJpg(imageData);
      const scale = Math.min(0.75, 1440 / Math.max(embeddedImage.width, embeddedImage.height));
      const { width, height } = embeddedImage.scale(scale);
      const initialLayout = { x: 0, y: 0, width, height };
      const imageSource: ImageSource = {
        data: imageData,
        format: isPng ? "png" : "jpeg",
        pageWidth: width,
        pageHeight: height,
        original: initialLayout,
        layout: initialLayout,
      };
      const pdfData = await buildImagePdf(imageSource);
      const loadedDocument = await getDocument({ data: pdfData.slice() }).promise;
      addSource(file.name, loadedDocument, pdfData, pageNumber - 1, imageSource);
    } catch {
      setError("无法导入这张图片，请检查文件是否损坏。");
    } finally {
      setLoading(false);
    }
  }

  async function openOverlayFile(file?: File, target?: PageDrop) {
    if (!file) return;
    setLoading(true);
    setError("");
    let overlayTask: ReturnType<typeof getDocument> | null = null;
    try {
      const canvas = globalThis.document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)) {
        const url = URL.createObjectURL(file);
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
        } finally {
          URL.revokeObjectURL(url);
        }
      } else if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        overlayTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
        const overlayDocument = await overlayTask.promise;
        const page = await overlayDocument.getPage(1);
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(3, 2400 / Math.max(natural.width, natural.height)) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, canvasContext: context, viewport, background: "rgba(0, 0, 0, 0)" }).promise;
      } else {
        throw new Error("Unsupported image format");
      }
      const region = overlayFromCanvas(canvas);
      setCopiedRegion(region);
      setSelectedRegion(null);
      setSelectedStampId(null);
      if (target) placeRegion(region, target);
      else {
        setActiveTool("crop");
        setPasteActive(true);
      }
    } catch {
      setError("无法读取图片，请选择受系统支持的图片，或包含可见内容的未加密 PDF。");
    } finally {
      await overlayTask?.destroy();
      setLoading(false);
    }
  }

  async function openNativePaths(paths: string[]) {
    setLoading(true);
    setError("");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    try {
      for (const path of paths) {
        const data = new Uint8Array(await invoke<number[]>("read_pdf_file", { path }));
        const loadedDocument = await getDocument({ data: data.slice() }).promise;
        addSource(path.split(/[\\/]/).pop() || "未命名文档.pdf", loadedDocument, data);
      }
    } catch {
      setError("无法打开此 PDF，请确认文件没有损坏或加密。");
    } finally {
      setLoading(false);
    }
  }

  function addSource(
    name: string,
    loadedDocument: PDFDocumentProxy,
    data: Uint8Array,
    insertAfter?: number,
    image?: ImageSource,
  ) {
    const source: PdfSource = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: name.replace(/\.[^.]+$/, ""),
      document: loadedDocument,
      data,
      image,
    };
    setSources((current) => [...current, source]);
    const newPages = Array.from({ length: loadedDocument.numPages }, (_, index) => ({
        id: `${source.id}-${index + 1}`,
        sourceId: source.id,
        pageNumber: index + 1,
        rotation: 0,
        stamps: [],
      }));
    const insertionIndex = insertAfter === undefined
      ? compositionRef.current.length
      : Math.max(0, Math.min(insertAfter + 1, compositionRef.current.length));
    commitComposition([
      ...compositionRef.current.slice(0, insertionIndex),
      ...newPages,
      ...compositionRef.current.slice(insertionIndex),
    ]);
    setActiveSourceId(source.id);
    setPageNumber(insertAfter === undefined ? 1 : insertionIndex + 1);
  }

  function handleWebFiles(files: FileList | null, target: "canvas" | "library", position?: { x: number; y: number }) {
    const imageFiles = Array.from(files ?? []).filter((file) => file.type.startsWith("image/")
      || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name));
    const pdfFiles = Array.from(files ?? []).filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    setDropTarget(null);
    if (target === "canvas" && imageFiles.length && compositionRef.current.length && position) {
      const placement = pageDropAt(position);
      if (!placement) { setError("请将图片放在具体的 PDF 页面上。"); return; }
      void (async () => { for (const file of imageFiles) await openOverlayFile(file, placement); })();
      return;
    }
    if (!pdfFiles.length) {
      setError("请拖入一个 PDF 文件。");
      return;
    }
    if (target === "canvas" && sources.length > 0) {
      setError("如需继续添加 PDF，请拖放到右侧的资源管理区域。");
      return;
    }
    void Promise.all(pdfFiles.map((file) => openFile(file)));
  }

  function changePage(next: number) {
    if (!composition.length) return;
    const target = Math.min(Math.max(next, 1), composition.length);
    setPageNumber(target);
    pageElementsRef.current.get(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function registerPage(pageIndex: number, element: HTMLDivElement | null) {
    if (element) pageElementsRef.current.set(pageIndex, element);
    else pageElementsRef.current.delete(pageIndex);
  }

  function updateVisiblePage() {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      const scroller = canvasScrollRef.current;
      if (!scroller) return;
      const center = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
      let closestPage = 1;
      let closestDistance = Number.POSITIVE_INFINITY;

      pageElementsRef.current.forEach((element, index) => {
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - center);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = index;
        }
      });
      setPageNumber(closestPage);
      scrollFrameRef.current = null;
    });
  }

  function movePages(pageIds: Set<string>, targetIndex: number) {
    const current = compositionRef.current;
    const moving = current.filter((page) => pageIds.has(page.id));
    if (!moving.length) return;
    const target = current[targetIndex];
    if (!target || pageIds.has(target.id)) return;
    const insertionIndex = current
      .slice(0, targetIndex)
      .filter((page) => !pageIds.has(page.id)).length;
    const next = current.filter((page) => !pageIds.has(page.id));
    next.splice(insertionIndex, 0, ...moving);
    commitComposition(next);
  }

  async function rotateSelectedPages() {
    const pageIds = selectedPageIds.size
      ? selectedPageIds
      : new Set(composition[pageNumber - 1] ? [composition[pageNumber - 1].id] : []);
    if (!pageIds.size) return;
    try {
      const dimensions = new Map<string, { width: number; height: number }>();
      await Promise.all(compositionRef.current.filter((page) => pageIds.has(page.id) && page.stamps.length).map(async (item) => {
        const source = sourcesRef.current.find((entry) => entry.id === item.sourceId);
        if (!source) return;
        const page = await source.document.getPage(item.pageNumber);
        const viewport = page.getViewport({ scale: 1, rotation: displayRotation(page, item.rotation) });
        dimensions.set(item.id, { width: viewport.width, height: viewport.height });
      }));
      commitComposition(compositionRef.current.map((page) => {
        if (!pageIds.has(page.id)) return page;
        const size = dimensions.get(page.id);
        return { ...page, rotation: (page.rotation + 90) % 360,
          stamps: size ? page.stamps.map((stamp) => {
            const width = stamp.width * size.width / size.height;
            const height = stamp.height * size.height / size.width;
            const centerX = 1 - stamp.y - stamp.height / 2;
            const centerY = stamp.x + stamp.width / 2;
            return constrainStamp({ ...stamp, width, height, x: centerX - width / 2, y: centerY - height / 2,
              rotation: (stamp.rotation + 90) % 360 }, size.height, size.width);
          }) : page.stamps };
      }));
    } catch {
      setError("无法旋转页面，请稍后重试。");
    }
  }

  async function adjustCurrentImage(action: "smaller" | "larger" | "left" | "right" | "up" | "down" | "reset") {
    if (!currentComposedPage || !currentImageSource || imageAdjusting) return;
    const sourceId = currentComposedPage.sourceId;
    const { pageWidth, pageHeight, layout, original } = currentImageSource;
    let nextLayout = { ...layout };
    const ratio = layout.width / layout.height;
    if (action === "reset") {
      nextLayout = { ...original };
    } else if (action === "smaller" || action === "larger") {
      const factor = action === "smaller" ? 0.9 : 1.1;
      const maxWidth = pageWidth;
      const width = Math.max(pageWidth * 0.12, Math.min(maxWidth, layout.width * factor));
      const height = width / ratio;
      nextLayout = {
        width,
        height,
        x: Math.max(0, Math.min(pageWidth - width, layout.x - (width - layout.width) / 2)),
        y: Math.max(0, Math.min(pageHeight - height, layout.y - (height - layout.height) / 2)),
      };
    } else {
      const stepX = pageWidth * 0.06;
      const stepY = pageHeight * 0.06;
      const x = action === "left" ? layout.x - stepX : action === "right" ? layout.x + stepX : layout.x;
      const y = action === "down" ? layout.y - stepY : action === "up" ? layout.y + stepY : layout.y;
      nextLayout = {
        ...layout,
        x: Math.max(0, Math.min(pageWidth - layout.width, x)),
        y: Math.max(0, Math.min(pageHeight - layout.height, y)),
      };
    }

    setImageAdjusting(true);
    try {
      const nextImage = { ...currentImageSource, layout: nextLayout };
      const data = await buildImagePdf(nextImage);
      const document = await getDocument({ data: data.slice() }).promise;
      setSources((current) => current.map((source) => (
        source.id === sourceId ? { ...source, data, document, image: nextImage } : source
      )));
    } catch {
      setError("无法调整图片，请稍后重试。");
    } finally {
      setImageAdjusting(false);
    }
  }

  function removeSource(sourceId: string) {
    const remaining = sources.filter((source) => source.id !== sourceId);
    setSources(remaining);
    commitComposition(compositionRef.current.filter((page) => page.sourceId !== sourceId), true);
    if (activeSourceId === sourceId) setActiveSourceId(remaining[0]?.id ?? null);
  }

  function clearSources() {
    setSources([]);
    commitComposition([], true);
    setActiveSourceId(null);
    setPageNumber(1);
  }

  async function exportComposition() {
    if (!composition.length) return;
    const suggestedName = `${fileName || "A7PDF"}-已编排.pdf`;
    const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
    let outputPath: string | null = null;
    try {
      if (tauriWindow.__TAURI_INTERNALS__) {
        outputPath = await save({
          defaultPath: suggestedName,
          filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
        });
        if (!outputPath) return;
      }
    } catch {
      setError("无法打开保存位置，请稍后重试。");
      return;
    }

    setExporting(true);
    setExportProgress({ value: 3, stage: "正在准备导出" });
    setError("");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    try {
      const output = await PDFDocument.create();
      const pagesBySource = new Map<string, ComposedPage[]>();
      for (const page of composition) {
        const pages = pagesBySource.get(page.sourceId) ?? [];
        pages.push(page);
        pagesBySource.set(page.sourceId, pages);
      }
      const sourceDocuments = new Map<string, PDFDocument>();
      const exportSources = sources.filter((source) => pagesBySource.has(source.id));
      let loadedSources = 0;
      setExportProgress({ value: 6, stage: `正在读取 ${exportSources.length} 个文件` });
      await Promise.all(exportSources.map(async (source) => {
        const sourceDocument = await PDFDocument.load(source.data);
        sourceDocuments.set(source.id, sourceDocument);
        loadedSources += 1;
        setExportProgress({
          value: 8 + Math.round((loadedSources / exportSources.length) * 12),
          stage: `正在读取文件 ${loadedSources}/${exportSources.length}`,
        });
      }));

      const copiedPages = new Map<string, Awaited<ReturnType<PDFDocument["copyPages"]>>[number]>();
      let copiedCount = 0;
      const batchSize = 12;
      for (const [sourceId, pages] of pagesBySource) {
        const source = sourceDocuments.get(sourceId);
        if (!source) continue;
        for (const batch of pageCopyBatches(pages, batchSize)) {
          // pdf-lib shares a copied content stream when the same source page
          // appears twice in one copyPages call; edits would then bleed across pages.
          const copiedBatch = await output.copyPages(source, batch.map((page) => page.pageNumber - 1));
          batch.forEach((page, index) => {
            const copiedPage = copiedBatch[index];
            copiedPage.setRotation(degrees((copiedPage.getRotation().angle + page.rotation) % 360));
            copiedPages.set(page.id, copiedPage);
          });
          copiedCount += batch.length;
          setExportProgress({
            value: 20 + Math.round((copiedCount / composition.length) * 70),
            stage: `正在重新编排页面 ${copiedCount}/${composition.length}`,
          });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
      const stampImages = new Map<string, PDFImage>();
      for (const page of composition) {
        const copiedPage = copiedPages.get(page.id);
        if (!copiedPage) continue;
        for (const stamp of page.stamps) {
          let image = stampImages.get(stamp.dataUrl);
          if (!image) {
            image = await output.embedPng(stamp.dataUrl);
            stampImages.set(stamp.dataUrl, image);
          }
          placeStamp(copiedPage, image, stamp);
        }
        output.addPage(copiedPage);
      }
      setExportProgress({ value: 92, stage: "正在生成 PDF 文件" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bytes = await output.save({ useObjectStreams: true, objectsPerTick: 500 });
      setExportProgress({ value: 98, stage: "正在保存文件" });
      if (outputPath) {
        await invoke("save_pdf_file", { path: outputPath, data: Array.from(bytes) });
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const link = Object.assign(globalThis.document.createElement("a"), { href: url, download: suggestedName });
        link.click();
        URL.revokeObjectURL(url);
      }
      setExportProgress({ value: 100, stage: "导出完成" });
    } catch {
      setError("导出失败，请检查导入的 PDF 是否受密码保护。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <main
      className={`app-shell ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`}
      onContextMenu={(event) => event.preventDefault()}
    >
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => openFile(event.target.files?.[0])}
      />
      <input
        ref={libraryInputRef}
        className="file-input"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        onChange={(event) => handleWebFiles(event.target.files, "library")}
      />
      <input
        ref={imageInputRef}
        className="file-input"
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        onChange={(event) => {
          void openImageFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={overlayInputRef}
        className="file-input"
        type="file"
        accept="image/*,application/pdf,.pdf"
        onChange={(event) => {
          void openOverlayFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />

      <header className="titlebar">
        <div className="brand">
          <button className="icon-button quiet" aria-label="菜单"><Menu size={19} /></button>
          <div className="brand-mark">A7</div>
          <div>
            <strong>A7PDF</strong>
            <span>PDF 编辑器</span>
          </div>
        </div>
        <div className="document-title">
          <strong>{fileName}</strong>
          <span>{document ? "已在本地打开" : "准备就绪"}</span>
        </div>
        <div className="title-actions">
          <button className="icon-button" aria-label="撤销" title="撤销（⌘/Ctrl Z）" disabled={historyIndex === 0} onClick={undoComposition}><Undo2 size={18} /></button>
          <button className="icon-button" aria-label="重做" title="重做（⌘/Ctrl Shift Z）" disabled={historyIndex >= historyLength - 1} onClick={redoComposition}><Redo2 size={18} /></button>
          <button className={`export-button ${exporting ? "is-exporting" : ""}`} disabled={!composition.length || exporting} onClick={exportComposition} title={exporting ? exportProgress.stage : "导出当前编排"}>
            {exporting && <i className="export-button-progress" style={{ width: `${exportProgress.value}%` }} />}
            <span className="export-button-content"><Download size={17} />{exporting ? `正在导出 ${exportProgress.value}%` : "导出"}</span>
          </button>
        </div>
      </header>

      <nav className="toolbar" aria-label="编辑工具">
        <div className="tool-group">
          {tools.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`tool-button ${activeTool === id ? "active" : ""}`}
              disabled={id === "overlay" && !composition.length}
              onClick={() => {
                if (id === "overlay") {
                  overlayInputRef.current?.click();
                  return;
                }
                setActiveTool(id);
                if (id !== "crop") {
                  setSelectedRegion(null);
                  setPasteActive(false);
                }
                if (id === "image") imageInputRef.current?.click();
              }}
              title={label}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-divider" />
        <button className="tool-button" title="顺时针旋转 90°" disabled={!composition.length} onClick={rotateSelectedPages}><RotateCw size={19} /><span>旋转</span></button>
        {activeTool === "crop" && (
          <div className="crop-actions">
            <span>{pasteActive ? "单击目标页面放置 · Esc 退出" : "在页面上拖动框选"}</span>
            <button disabled={!selectedRegion || selectedRegion.width < 0.003 || selectedRegion.height < 0.003} onClick={copySelectedRegion}><Copy size={14} />复制</button>
            <button disabled={!copiedRegion} className={pasteActive ? "active" : ""} onClick={() => setPasteActive(true)}>粘贴</button>
          </div>
        )}
        {currentImageSource && (
          <div className="image-adjustments" aria-label="图片调整">
            <span>图片调整</span>
            <div className="image-adjustment-buttons">
              <button title="缩小图片" disabled={imageAdjusting} onClick={() => void adjustCurrentImage("smaller")}><Minus size={14} /></button>
              <button title="放大图片" disabled={imageAdjusting} onClick={() => void adjustCurrentImage("larger")}><Plus size={14} /></button>
              <button title="向左移动" disabled={imageAdjusting} onClick={() => void adjustCurrentImage("left")}><ArrowLeft size={14} /></button>
              <button title="向上移动" disabled={imageAdjusting} onClick={() => void adjustCurrentImage("up")}><ArrowUp size={14} /></button>
              <button title="向下移动" disabled={imageAdjusting} onClick={() => void adjustCurrentImage("down")}><ArrowDown size={14} /></button>
              <button title="向右移动" disabled={imageAdjusting} onClick={() => void adjustCurrentImage("right")}><ArrowRight size={14} /></button>
              <button title="恢复图片原始位置和尺寸" disabled={imageAdjusting} onClick={() => void adjustCurrentImage("reset")}><RotateCcw size={14} /></button>
            </div>
          </div>
        )}
        <div className="toolbar-spacer" />
        {composition.length > 0 && (
          <div className="toolbar-page-navigation">
            <button onClick={() => changePage(pageNumber - 1)} disabled={pageNumber === 1} aria-label="上一页">
              <ChevronLeft size={16} />
            </button>
            <span><strong>{pageNumber}</strong> / {composition.length}</span>
            <button onClick={() => changePage(pageNumber + 1)} disabled={pageNumber === composition.length} aria-label="下一页">
              <ChevronRight size={16} />
            </button>
          </div>
        )}
        <div className="zoom-control">
          <button onClick={() => setZoom((value) => Math.max(10, value - 10))} title="缩小（⌘/Ctrl -）"><Minus size={16} /></button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((value) => Math.min(400, value + 10))} title="放大（⌘/Ctrl +）"><Plus size={16} /></button>
        </div>
      </nav>
      {loading && (
        <div className="import-progress" role="status" aria-live="polite">
          <span />
          <strong>正在读取 PDF 文件…</strong>
        </div>
      )}
      <div className="workspace">
        <aside className="sidebar pages-panel">
          <div className="panel-heading">
            <div className="composition-heading collapsible-content">
              <strong>页面编排</strong>
              <span>{composition.length} 页</span>
            </div>
          </div>
          <button
            className="panel-toggle"
            aria-label={leftCollapsed ? "展开侧栏" : "收起侧栏"}
            title={leftCollapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() => setLeftCollapsed((value) => !value)}
          />
          <div className="thumbnails collapsible-content" ref={thumbnailsRef} onScroll={captureThumbnailPositions}>
            {composition.length ? (
              compositionBlocks.map((block) => {
                const source = sources.find((item) => item.id === block.sourceId);
                if (!source) return null;
                const expanded = expandedBlockIds.has(block.id);
                return (
                  <div className="pdf-block-group" key={block.id}>
                    <PdfBlock
                      block={block}
                      source={source}
                      expanded={expanded}
                      onToggle={() => toggleBlock(block.id)}
                      onPointerDragStart={(position) => beginBlockDrag(block.id, position)}
                      isDragging={draggedBlockId === block.id}
                      isDropTarget={dropBlockId === block.id && draggedBlockId !== block.id}
                      dropPosition={dropBlockPosition}
                    />
                    {expanded && (
                      <div className="pdf-block-pages">
                        {block.pages.map((page, offset) => {
                          const index = block.startIndex + offset;
                          return (
                            <Thumbnail
                              key={page.id}
                              document={source.document}
                              sourcePageNumber={page.pageNumber}
                              sequenceNumber={index + 1}
                              rotation={page.rotation}
                              stamps={page.stamps}
                              selected={selectedPageIds.has(page.id)}
                              pageId={page.id}
                              register={registerThumbnail}
                              onSelect={(event) => selectCompositionPage(index, event)}
                              onContextMenu={(position) => openPageContextMenu(index, position)}
                              onPointerDragStart={(position) => beginPageDrag(index, position)}
                              compositionIndex={index}
                              isDragging={draggedPageIds.has(page.id)}
                              isDropTarget={dropPageIndex === index && !draggedPageIds.has(page.id)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="empty-pages">
                <div className="mini-page" />
                <span>添加 PDF 后，在这里编排页面</span>
              </div>
            )}
          </div>
        </aside>

        <section
          className="canvas-area"
          ref={canvasAreaRef}
          onDragEnter={(event) => {
            event.preventDefault();
            setDropTarget("canvas");
          }}
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDragLeave={() => dropTarget === "canvas" && setDropTarget(null)}
          onDrop={(event) => {
            event.preventDefault();
            handleWebFiles(event.dataTransfer.files, "canvas", { x: event.clientX, y: event.clientY });
          }}
        >
          <div className="canvas-scroll" ref={canvasScrollRef} onScroll={updateVisiblePage}>
            {loading && !document ? (
              <div className="loading-card"><Circle className="spinner" size={28} />正在打开文档…</div>
            ) : composition.length ? (
              <div className="continuous-document">
                {composition.map((page, index) => {
                  const source = sources.find((item) => item.id === page.sourceId);
                  return source ? (
                    <ContinuousPage
                      key={page.id}
                      document={source.document}
                      pageNumber={page.pageNumber}
                      sequenceNumber={index + 1}
                      rotation={page.rotation}
                      pageId={page.id}
                      cropActive={activeTool === "crop"}
                      stampEditingActive={activeTool === "select"}
                      pasteActive={pasteActive}
                      clipboardPreview={copiedRegion}
                      selection={selectedRegion}
                      stamps={page.stamps}
                      selectedStampId={selectedStampId}
                      onSelectRegion={setSelectedRegion}
                      onPaste={pasteCopiedRegion}
                      onCopy={copySelectedRegion}
                      onSelectStamp={setSelectedStampId}
                      onUpdateStamp={updateStamp}
                      canvasSize={canvasSize}
                      zoom={zoom}
                      register={registerPage}
                    />
                  ) : null;
                })}
              </div>
            ) : (
              <EmptyDocument onOpen={() => inputRef.current?.click()} />
            )}
          </div>
          {error && <div className="error-toast">{error}</div>}
          {dropTarget === "canvas" && composition.length > 0 ? (
            <div className="image-drop-hint">将图片放到 PDF 页面上以叠加</div>
          ) : dropTarget === "canvas" && (
            <div className="native-drop-overlay">
              <FilePlus2 size={34} />
              <strong>松开以打开 PDF</strong>
              <span>中央工作区用于打开第一份文档</span>
            </div>
          )}
        </section>

        <aside
          className={`sidebar pdf-library ${dropTarget === "library" ? "is-dragging" : ""}`}
          ref={libraryRef}
          onDragEnter={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDropTarget("library");
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDragLeave={() => dropTarget === "library" && setDropTarget(null)}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleWebFiles(event.dataTransfer.files, "library");
          }}
        >
          <button
            className="library-toggle"
            aria-label={rightCollapsed ? "展开资源管理" : "收起资源管理"}
            title={rightCollapsed ? "展开资源管理" : "收起资源管理"}
            onClick={() => setRightCollapsed((value) => !value)}
          />
          <div className="library-content">
          <div className="library-header">
            <div>
              <span>资源管理</span>
              <small>{sources.length} 个文件</small>
            </div>
            <div className="library-actions">
              {sources.length > 0 && <button className="clear-all-button" onClick={clearSources}>全部清空</button>}
              <button className="icon-button add-pdf-button" onClick={() => libraryInputRef.current?.click()} aria-label="添加 PDF"><Plus size={17} /></button>
            </div>
          </div>
          <div className="pdf-source-list">
            {sources.map((source, index) => (
              <div
                key={source.id}
                className={`pdf-source ${source.id === activeSourceId ? "active" : ""}`}
                onClick={() => {
                  setActiveSourceId(source.id);
                  const firstPage = composition.findIndex((page) => page.sourceId === source.id);
                  if (firstPage >= 0) changePage(firstPage + 1);
                }}
              >
                <span className="pdf-source-icon"><FileText size={18} /></span>
                <span className="pdf-source-copy">
                  <strong>{source.name}</strong>
                  <small>{source.document.numPages} 页 · PDF {index + 1}</small>
                </span>
                <button
                  className="source-remove"
                  aria-label={`清空 ${source.name}`}
                  title="从资源管理与页面编排中移除"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeSource(source.id);
                  }}
                ><Trash2 size={14} /></button>
              </div>
            ))}
            {!sources.length && (
              <button className="library-empty" onClick={() => libraryInputRef.current?.click()}>
                <FilePlus2 size={24} />
                <strong>添加 PDF 文件</strong>
                <span>拖放到这里，可继续加入文件</span>
              </button>
            )}
          </div>
          <div className="library-drop-hint">
            <FilePlus2 size={27} />
            <strong>松开以添加 PDF</strong>
            <span>新文件会加入列表</span>
          </div>
          </div>
        </aside>
      </div>
      {draggedPageIndex !== null && dragPointer && (() => {
        const draggedPage = composition[draggedPageIndex];
        const source = draggedPage && sources.find((item) => item.id === draggedPage.sourceId);
        return source && (
          <DragPreview
            document={source.document}
            sourcePageNumber={draggedPage.pageNumber}
            sequenceNumber={draggedPageIndex + 1}
            rotation={draggedPage.rotation}
            count={draggedPageIds.size}
            position={dragPointer}
          />
        );
      })()}
      {draggedBlockId && dragPointer && (() => {
        const block = groupComposition(composition).find((item) => item.id === draggedBlockId);
        const source = block && sources.find((item) => item.id === block.sourceId);
        const firstPage = block?.pages[0];
        return source && firstPage && (
          <DragPreview
            document={source.document}
            sourcePageNumber={firstPage.pageNumber}
            sequenceNumber={block.startIndex + 1}
            rotation={firstPage.rotation}
            count={block.pages.length}
            position={dragPointer}
          />
        );
      })()}
      {pageContextMenu && (
        <div
          className="page-context-menu"
          ref={pageContextMenuRef}
          style={{ left: pageContextMenu.x, top: pageContextMenu.y }}
          role="menu"
        >
          <button role="menuitem" onClick={() => {
            copySelectedPages(pageContextMenu.pageId);
            setPageContextMenu(null);
          }}>复制</button>
          <button className="danger" role="menuitem" onClick={() => {
            deleteSelectedPages(pageContextMenu.pageId);
            setPageContextMenu(null);
          }}>删除</button>
        </div>
      )}
    </main>
  );
}

export default App;
