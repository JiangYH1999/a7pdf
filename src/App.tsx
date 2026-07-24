import { useEffect, useRef, useState } from "react";
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
  Shapes,
  Signature,
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
import { PDFDocument } from "pdf-lib";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

type Tool = "select" | "text" | "highlight" | "draw" | "shape" | "image" | "sign" | "comment";
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
};

const tools: Array<{ id: Tool; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "选择", icon: MousePointer2 },
  { id: "text", label: "文本框", icon: Type },
  { id: "highlight", label: "高亮", icon: Highlighter },
  { id: "draw", label: "画笔", icon: PenLine },
  { id: "shape", label: "形状", icon: Shapes },
  { id: "image", label: "图片", icon: ImagePlus },
  { id: "sign", label: "签名", icon: Signature },
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
  className = "",
}: {
  page: PDFPageProxy | null;
  scale: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!page || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const viewport = page.getViewport({ scale });
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
  }, [page, scale]);

  return <canvas ref={canvasRef} className={className} />;
}

function Thumbnail({
  document,
  pageNumber,
  selected,
  onSelect,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  isDragging,
  isDropTarget,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  isDragging: boolean;
  isDropTarget: boolean;
}) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const thumbnailScale = page
    ? Math.min(
        118 / page.getViewport({ scale: 1 }).width,
        142 / page.getViewport({ scale: 1 }).height,
      )
    : 0.1;

  useEffect(() => {
    let active = true;
    document.getPage(pageNumber).then((loaded) => active && setPage(loaded));
    return () => {
      active = false;
    };
  }, [document, pageNumber]);

  return (
    <div
      className={`thumbnail ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""} ${isDropTarget ? "drop-target" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <button className="thumbnail-select" onClick={onSelect}>
      <div className="thumbnail-paper">
        <PdfCanvas page={page} scale={thumbnailScale} />
      </div>
      <span>{pageNumber}</span>
      </button>
      <button className="page-remove" onClick={onRemove} aria-label={`删除第 ${pageNumber} 页`} title="从编排中删除">
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function ContinuousPage({
  document,
  pageNumber,
  sequenceNumber,
  canvasSize,
  zoom,
  register,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  sequenceNumber: number;
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

  const viewport = page?.getViewport({ scale: 1 });
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
      <PdfCanvas page={page} scale={fitScale * (zoom / 100)} className="main-pdf-page" />
      <span className="page-label">{sequenceNumber}</span>
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
      <p className="empty-copy">
        在本地打开 PDF，完成批注、签名与页面整理。文件不会离开你的设备。
      </p>
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
  const canvasAreaRef = useRef<HTMLElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<HTMLElement>(null);
  const sourcesRef = useRef<PdfSource[]>([]);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const scrollFrameRef = useRef<number | null>(null);
  const [sources, setSources] = useState<PdfSource[]>([]);
  const [composition, setComposition] = useState<ComposedPage[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [draggedPageIndex, setDraggedPageIndex] = useState<number | null>(null);
  const activeSource = sources.find((source) => source.id === activeSourceId) ?? null;
  const document = activeSource?.document ?? null;
  const fileName = activeSource?.name ?? "未命名文档";

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

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
      if (!event.metaKey && !event.ctrlKey) return;
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
  }, []);

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

  function addSource(name: string, loadedDocument: PDFDocumentProxy, data: Uint8Array) {
    const source: PdfSource = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: name.replace(/\.pdf$/i, ""),
      document: loadedDocument,
      data,
    };
    setSources((current) => [...current, source]);
    setComposition((current) => [
      ...current,
      ...Array.from({ length: loadedDocument.numPages }, (_, index) => ({
        id: `${source.id}-${index + 1}`,
        sourceId: source.id,
        pageNumber: index + 1,
      })),
    ]);
    setActiveSourceId(source.id);
    setPageNumber(1);
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

  function removePage(pageId: string) {
    setComposition((current) => current.filter((page) => page.id !== pageId));
    setPageNumber((current) => Math.max(1, Math.min(current, composition.length - 1)));
  }

  function movePage(from: number, to: number) {
    if (from === to) return;
    setComposition((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(from < to ? to - 1 : to, 0, moved);
      return next;
    });
    setPageNumber((from < to ? to - 1 : to) + 1);
  }

  function removeSource(sourceId: string) {
    const remaining = sources.filter((source) => source.id !== sourceId);
    setSources(remaining);
    setComposition((current) => current.filter((page) => page.sourceId !== sourceId));
    if (activeSourceId === sourceId) setActiveSourceId(remaining[0]?.id ?? null);
  }

  function clearSources() {
    setSources([]);
    setComposition([]);
    setActiveSourceId(null);
    setPageNumber(1);
  }

  async function exportComposition() {
    if (!composition.length) return;
    setExporting(true);
    setError("");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const output = await PDFDocument.create();
      const sourceDocuments = new Map<string, PDFDocument>();
      for (const source of sources) sourceDocuments.set(source.id, await PDFDocument.load(source.data));
      for (const page of composition) {
        const source = sourceDocuments.get(page.sourceId);
        if (!source) continue;
        const [copiedPage] = await output.copyPages(source, [page.pageNumber - 1]);
        output.addPage(copiedPage);
      }
      const bytes = await output.save();
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const link = Object.assign(globalThis.document.createElement("a"), { href: url, download: "A7PDF-合并文档.pdf" });
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("导出失败，请检查导入的 PDF 是否受密码保护。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <main
      className={`app-shell ${leftCollapsed ? "left-collapsed" : ""}`}
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
          <button className="icon-button" aria-label="撤销" disabled><Undo2 size={18} /></button>
          <button className="icon-button" aria-label="重做" disabled><Redo2 size={18} /></button>
          <button className="export-button" disabled={!composition.length || exporting} onClick={exportComposition}>
            <Download size={17} />
            {exporting ? "正在导出" : "导出"}
          </button>
        </div>
      </header>

      <nav className="toolbar" aria-label="编辑工具">
        <div className="tool-group">
          {tools.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`tool-button ${activeTool === id ? "active" : ""}`}
              onClick={() => setActiveTool(id)}
              title={label}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-divider" />
        <button className="tool-button" title="旋转页面"><RotateCw size={19} /><span>旋转</span></button>
        <div className="toolbar-spacer" />
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
            <button
              className="panel-toggle"
              aria-label={leftCollapsed ? "展开侧栏" : "收起侧栏"}
              title={leftCollapsed ? "展开侧栏" : "收起侧栏"}
              onClick={() => setLeftCollapsed((value) => !value)}
            />
          </div>
          <div className="thumbnails collapsible-content">
            {composition.length ? (
              composition.map((page, index) => {
                const source = sources.find((item) => item.id === page.sourceId);
                if (!source) return null;
                return (
                <Thumbnail
                  key={page.id}
                  document={source.document}
                  pageNumber={page.pageNumber}
                  selected={pageNumber === index + 1}
                  onSelect={() => changePage(index + 1)}
                  onRemove={() => removePage(page.id)}
                  onDragStart={() => setDraggedPageIndex(index)}
                  onDragOver={() => undefined}
                  onDrop={() => {
                    if (draggedPageIndex !== null) movePage(draggedPageIndex, index);
                    setDraggedPageIndex(null);
                  }}
                  isDragging={draggedPageIndex === index}
                  isDropTarget={draggedPageIndex !== null && draggedPageIndex !== index}
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
          {composition.length > 0 && (
            <div className="page-navigation">
              <button onClick={() => changePage(pageNumber - 1)} disabled={pageNumber === 1}>
                <ChevronLeft size={16} />
              </button>
              <span><strong>{pageNumber}</strong> / {composition.length}</span>
              <button onClick={() => changePage(pageNumber + 1)} disabled={pageNumber === composition.length}>
                <ChevronRight size={16} />
              </button>
            </div>
          )}
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
        </aside>
      </div>
    </main>
  );
}

export default App;
