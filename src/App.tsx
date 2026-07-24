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
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plus,
  Redo2,
  RotateCw,
  Search,
  Shapes,
  Signature,
  Sparkles,
  Type,
  Undo2,
} from "lucide-react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
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
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  selected: boolean;
  onSelect: () => void;
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
    <button className={`thumbnail ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="thumbnail-paper">
        <PdfCanvas page={page} scale={thumbnailScale} />
      </div>
      <span>{pageNumber}</span>
    </button>
  );
}

function ContinuousPage({
  document,
  pageNumber,
  canvasSize,
  zoom,
  register,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
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
      data-page-number={pageNumber}
      ref={(element) => register(pageNumber, element)}
    >
      <PdfCanvas page={page} scale={fitScale * (zoom / 100)} className="main-pdf-page" />
      <span className="page-label">{pageNumber}</span>
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
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
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
          const scale = window.devicePixelRatio || 1;
          const x = event.payload.position.x / scale;
          const y = event.payload.position.y / scale;
          const libraryBounds = libraryRef.current?.getBoundingClientRect();
          const canvasBounds = canvasAreaRef.current?.getBoundingClientRect();
          const overLibrary = Boolean(
            libraryBounds
            && x >= libraryBounds.left
            && x <= libraryBounds.right
            && y >= libraryBounds.top
            && y <= libraryBounds.bottom
          );
          const overCanvas = Boolean(
            canvasBounds
            && x >= canvasBounds.left
            && x <= canvasBounds.right
            && y >= canvasBounds.top
            && y <= canvasBounds.bottom
          );
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

        const scale = window.devicePixelRatio || 1;
        const x = event.payload.position.x / scale;
        const y = event.payload.position.y / scale;
        const libraryBounds = libraryRef.current?.getBoundingClientRect();
        const canvasBounds = canvasAreaRef.current?.getBoundingClientRect();
        const droppedOnLibrary = Boolean(
          libraryBounds
          && x >= libraryBounds.left
          && x <= libraryBounds.right
          && y >= libraryBounds.top
          && y <= libraryBounds.bottom
        );
        const droppedOnCanvas = Boolean(
          canvasBounds
          && x >= canvasBounds.left
          && x <= canvasBounds.right
          && y >= canvasBounds.top
          && y <= canvasBounds.bottom
        );
        const pdfPaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith(".pdf"));
        setDropTarget(null);
        if (!pdfPaths.length) {
          setError("请拖入一个 PDF 文件。");
          return;
        }
        if (!droppedOnLibrary && (!droppedOnCanvas || sourcesRef.current.length > 0)) {
          setError("如需继续添加 PDF，请拖放到右侧的原始 PDF 列表。");
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
    pageElementsRef.current.clear();
    if (canvasScrollRef.current) canvasScrollRef.current.scrollTop = 0;
  }, [document]);

  async function openFile(file?: File) {
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const loadedDocument = await getDocument({ data }).promise;
      addSource(file.name, loadedDocument);
    } catch {
      setError("无法打开此 PDF，请确认文件没有损坏或加密。");
    } finally {
      setLoading(false);
    }
  }

  async function openNativePaths(paths: string[]) {
    setLoading(true);
    setError("");
    try {
      for (const path of paths) {
        const data = await invoke<number[]>("read_pdf_file", { path });
        const loadedDocument = await getDocument({ data: new Uint8Array(data) }).promise;
        addSource(path.split(/[\\/]/).pop() || "未命名文档.pdf", loadedDocument);
      }
    } catch {
      setError("无法打开此 PDF，请确认文件没有损坏或加密。");
    } finally {
      setLoading(false);
    }
  }

  function addSource(name: string, loadedDocument: PDFDocumentProxy) {
    const source: PdfSource = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: name.replace(/\.pdf$/i, ""),
      document: loadedDocument,
    };
    setSources((current) => [...current, source]);
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
      setError("如需继续添加 PDF，请拖放到右侧的原始 PDF 列表。");
      return;
    }
    void Promise.all(pdfFiles.map((file) => openFile(file)));
  }

  function changePage(next: number) {
    if (!document) return;
    const target = Math.min(Math.max(next, 1), document.numPages);
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
            <span>轻量 PDF 编辑器</span>
          </div>
        </div>
        <div className="document-title">
          <strong>{fileName}</strong>
          <span>{document ? "已在本地打开" : "准备就绪"}</span>
        </div>
        <div className="title-actions">
          <button className="icon-button" aria-label="撤销" disabled><Undo2 size={18} /></button>
          <button className="icon-button" aria-label="重做" disabled><Redo2 size={18} /></button>
          <button className="export-button" disabled={!document}>
            <Download size={17} />
            导出
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
          <button onClick={() => setZoom((value) => Math.max(40, value - 10))}><Minus size={16} /></button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((value) => Math.min(180, value + 10))}><Plus size={16} /></button>
        </div>
      </nav>

      <div className="workspace">
        <aside className="sidebar pages-panel">
          <div className="panel-heading">
            <div className="segmented collapsible-content">
              <button className="active">页面</button>
              <button>书签</button>
            </div>
            <button
              className="icon-button quiet panel-toggle"
              aria-label={leftCollapsed ? "展开侧栏" : "收起侧栏"}
              title={leftCollapsed ? "展开侧栏" : "收起侧栏"}
              onClick={() => setLeftCollapsed((value) => !value)}
            >
              {leftCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>
          <div className="search-box collapsible-content"><Search size={15} /><span>搜索页面</span></div>
          <div className="thumbnails collapsible-content">
            {document ? (
              Array.from({ length: document.numPages }, (_, index) => (
                <Thumbnail
                  key={index + 1}
                  document={document}
                  pageNumber={index + 1}
                  selected={pageNumber === index + 1}
                  onSelect={() => changePage(index + 1)}
                />
              ))
            ) : (
              <div className="empty-pages">
                <div className="mini-page" />
                <span>打开文档后显示缩略图</span>
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
            {loading ? (
              <div className="loading-card"><Circle className="spinner" size={28} />正在打开文档…</div>
            ) : document ? (
              <div className="continuous-document">
                {Array.from({ length: document.numPages }, (_, index) => (
                  <ContinuousPage
                    key={index + 1}
                    document={document}
                    pageNumber={index + 1}
                    canvasSize={canvasSize}
                    zoom={zoom}
                    register={registerPage}
                  />
                ))}
              </div>
            ) : (
              <EmptyDocument onOpen={() => inputRef.current?.click()} />
            )}
          </div>
          {document && (
            <div className="page-navigation">
              <button onClick={() => changePage(pageNumber - 1)} disabled={pageNumber === 1}>
                <ChevronLeft size={16} />
              </button>
              <span><strong>{pageNumber}</strong> / {document.numPages}</span>
              <button onClick={() => changePage(pageNumber + 1)} disabled={pageNumber === document.numPages}>
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
              <span>原始 PDF</span>
              <small>{sources.length} 个文件</small>
            </div>
            <button className="icon-button add-pdf-button" onClick={() => libraryInputRef.current?.click()} aria-label="添加 PDF">
              <Plus size={17} />
            </button>
          </div>
          <div className="pdf-source-list">
            {sources.map((source, index) => (
              <button
                key={source.id}
                className={`pdf-source ${source.id === activeSourceId ? "active" : ""}`}
                onClick={() => {
                  setActiveSourceId(source.id);
                  setPageNumber(1);
                }}
              >
                <span className="pdf-source-icon"><FileText size={18} /></span>
                <span className="pdf-source-copy">
                  <strong>{source.name}</strong>
                  <small>{source.document.numPages} 页 · PDF {index + 1}</small>
                </span>
              </button>
            ))}
            {!sources.length && (
              <button className="library-empty" onClick={() => libraryInputRef.current?.click()}>
                <FilePlus2 size={24} />
                <strong>添加原始 PDF</strong>
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
