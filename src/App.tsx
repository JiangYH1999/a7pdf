import { type MouseEvent as ReactMouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
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
import { degrees, PDFDocument } from "pdf-lib";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save } from "@tauri-apps/plugin-dialog";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

type Tool = "select" | "text" | "highlight" | "draw" | "image" | "comment";
type DropTarget = "canvas" | "library" | null;
type PdfSource = {
  id: string;
  name: string;
  document: PDFDocumentProxy;
  data: Uint8Array;
};
type ComposedPage = {
  id: string;
  sourceId: string;
  pageNumber: number;
  rotation: number;
};

const READING_SCALE = 4;

const tools: Array<{ id: Tool; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "选择", icon: MousePointer2 },
  { id: "text", label: "文本框", icon: Type },
  { id: "highlight", label: "高亮", icon: Highlighter },
  { id: "draw", label: "画笔", icon: PenLine },
  { id: "image", label: "图片", icon: ImagePlus },
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
    const viewport = page.getViewport({ scale, rotation });
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
        86 / page.getViewport({ scale: 1, rotation }).width,
        82 / page.getViewport({ scale: 1, rotation }).height,
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
        <PdfCanvas page={page} scale={thumbnailScale} rotation={rotation} />
      </div>
      <span>{sequenceNumber}</span>
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
    ? Math.min(92 / page.getViewport({ scale: 1, rotation }).width, 112 / page.getViewport({ scale: 1, rotation }).height)
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
  pageNumber,
  sequenceNumber,
  rotation,
  canvasSize,
  zoom,
  register,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  sequenceNumber: number;
  rotation: number;
  canvasSize: { width: number; height: number };
  zoom: number;
  register: (pageNumber: number, element: HTMLDivElement | null) => void;
}) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);

  useEffect(() => {
    let active = true;
    document.getPage(pageNumber).then((loaded) => active && setPage(loaded));
    return () => {
      active = false;
    };
  }, [document, pageNumber]);

  const viewport = page?.getViewport({ scale: 1, rotation });
  const fitScale = viewport
    ? Math.min(
        Math.max(canvasSize.width - 120, 240) / viewport.width,
        Math.max(canvasSize.height - 120, 240) / viewport.height,
      )
    : 1;

  return (
    <div
      className="continuous-page"
      data-page-number={sequenceNumber}
      ref={(element) => register(sequenceNumber, element)}
    >
      <PdfCanvas page={page} scale={fitScale * READING_SCALE * (zoom / 100)} rotation={rotation} className="main-pdf-page" />
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
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ value: 0, stage: "" });
  const [error, setError] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [draggedPageIndex, setDraggedPageIndex] = useState<number | null>(null);
  const [draggedPageIds, setDraggedPageIds] = useState<Set<string>>(new Set());
  const [dropPageIndex, setDropPageIndex] = useState<number | null>(null);
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number } | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState<number | null>(null);
  const [selectionFocusIndex, setSelectionFocusIndex] = useState<number | null>(null);
  const [pageContextMenu, setPageContextMenu] = useState<{ x: number; y: number; pageId: string } | null>(null);
  const activeSource = sources.find((source) => source.id === activeSourceId) ?? null;
  const document = activeSource?.document ?? null;
  const fileName = activeSource?.name ?? "未命名文档";

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
          setDropTarget(
            overLibrary ? "library" : overCanvas && sourcesRef.current.length === 0 ? "canvas" : null,
          );
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
        const pdfPaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith(".pdf"));
        setDropTarget(null);
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
    const copies = selected.map((page) => ({ ...page, id: `${page.id}-copy-${crypto.randomUUID()}` }));
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
  }, [composition, pageNumber, selectedPageIds, selectionAnchorIndex, selectionFocusIndex]);

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
      const imagePage = imagePdf.addPage([width, height]);
      imagePage.drawImage(embeddedImage, { x: 0, y: 0, width, height });
      const pdfData = await imagePdf.save();
      const loadedDocument = await getDocument({ data: pdfData.slice() }).promise;
      addSource(file.name, loadedDocument, pdfData, pageNumber - 1);
    } catch {
      setError("无法导入这张图片，请检查文件是否损坏。");
    } finally {
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

  function addSource(name: string, loadedDocument: PDFDocumentProxy, data: Uint8Array, insertAfter?: number) {
    const source: PdfSource = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: name.replace(/\.[^.]+$/, ""),
      document: loadedDocument,
      data,
    };
    setSources((current) => [...current, source]);
    const newPages = Array.from({ length: loadedDocument.numPages }, (_, index) => ({
        id: `${source.id}-${index + 1}`,
        sourceId: source.id,
        pageNumber: index + 1,
        rotation: 0,
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

  function handleWebFiles(files: FileList | null, target: "canvas" | "library") {
    const pdfFiles = Array.from(files ?? []).filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    setDropTarget(null);
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

  function rotateSelectedPages() {
    const pageIds = selectedPageIds.size
      ? selectedPageIds
      : new Set(composition[pageNumber - 1] ? [composition[pageNumber - 1].id] : []);
    if (!pageIds.size) return;
    commitComposition(compositionRef.current.map((page) => (
      pageIds.has(page.id) ? { ...page, rotation: ((page.rotation ?? 0) + 90) % 360 } : page
    )));
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
        for (let offset = 0; offset < pages.length; offset += batchSize) {
          const batch = pages.slice(offset, offset + batchSize);
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
      for (const page of composition) {
        const copiedPage = copiedPages.get(page.id);
        if (copiedPage) output.addPage(copiedPage);
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
              onClick={() => {
                setActiveTool(id);
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
              composition.map((page, index) => {
                const source = sources.find((item) => item.id === page.sourceId);
                if (!source) return null;
                return (
                <Thumbnail
                  key={page.id}
                  document={source.document}
                  sourcePageNumber={page.pageNumber}
                  sequenceNumber={index + 1}
                  rotation={page.rotation}
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
            if (sources.length === 0) {
              event.preventDefault();
              setDropTarget("canvas");
            }
          }}
          onDragOver={(event) => {
            if (sources.length === 0) event.preventDefault();
          }}
          onDragLeave={() => dropTarget === "canvas" && setDropTarget(null)}
          onDrop={(event) => {
            event.preventDefault();
            handleWebFiles(event.dataTransfer.files, "canvas");
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
          {dropTarget === "canvas" && (
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
