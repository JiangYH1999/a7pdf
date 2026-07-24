import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  FilePlus2,
  Highlighter,
  ImagePlus,
  Menu,
  MessageSquareText,
  Minus,
  MousePointer2,
  PanelLeftClose,
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
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const scrollFrameRef = useRef<number | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [fileName, setFileName] = useState("未命名文档");
  const [zoom, setZoom] = useState(100);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isNativeDragging, setIsNativeDragging] = useState(false);

  useEffect(() => {
    const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
    if (!tauriWindow.__TAURI_INTERNALS__) return;

    let disposed = false;
    let removeListener: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type === "over") {
          setIsNativeDragging(true);
          return;
        }

        setIsNativeDragging(false);
        if (event.payload.type !== "drop") return;

        const pdfPath = event.payload.paths.find((path) => path.toLowerCase().endsWith(".pdf"));
        if (!pdfPath) {
          setError("请拖入一个 PDF 文件。");
          return;
        }

        setLoading(true);
        setError("");
        try {
          const data = await invoke<number[]>("read_pdf_file", { path: pdfPath });
          const loadedDocument = await getDocument({ data: new Uint8Array(data) }).promise;
          setDocument(loadedDocument);
          setFileName(pdfPath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "未命名文档");
          setPageNumber(1);
        } catch {
          setError("无法打开此 PDF，请确认文件没有损坏或加密。");
        } finally {
          setLoading(false);
        }
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
      setDocument(loadedDocument);
      setFileName(file.name.replace(/\.pdf$/i, ""));
      setPageNumber(1);
    } catch {
      setError("无法打开此 PDF，请确认文件没有损坏或加密。");
    } finally {
      setLoading(false);
    }
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
      className="app-shell"
      onDragOver={(event) => {
        const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
        if (!tauriWindow.__TAURI_INTERNALS__) event.preventDefault();
      }}
      onDrop={(event) => {
        const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
        if (!tauriWindow.__TAURI_INTERNALS__) {
          event.preventDefault();
          openFile(event.dataTransfer.files[0]);
        }
      }}
    >
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => openFile(event.target.files?.[0])}
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
            <div className="segmented">
              <button className="active">页面</button>
              <button>书签</button>
            </div>
            <button className="icon-button quiet" aria-label="收起侧栏"><PanelLeftClose size={17} /></button>
          </div>
          <div className="search-box"><Search size={15} /><span>搜索页面</span></div>
          <div className="thumbnails">
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

        <section className="canvas-area">
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
          {isNativeDragging && (
            <div className="native-drop-overlay">
              <FilePlus2 size={34} />
              <strong>松开以打开 PDF</strong>
              <span>文件只会在本地处理</span>
            </div>
          )}
        </section>

        <aside className="sidebar properties-panel">
          <div className="properties-header">
            <span>属性</span>
            <small>{tools.find((tool) => tool.id === activeTool)?.label}</small>
          </div>
          <section className="property-section">
            <label>样式</label>
            <div className="color-row">
              <button className="color-swatch selected" style={{ background: "#99EAFA" }} />
              <button className="color-swatch" style={{ background: "#FAA999" }} />
              <button className="color-swatch" style={{ background: "#ef6a7a" }} />
              <button className="color-swatch" style={{ background: "#42b59d" }} />
              <button className="add-color"><Plus size={15} /></button>
            </div>
          </section>
          <section className="property-section">
            <div className="property-line"><label>不透明度</label><span>100%</span></div>
            <input type="range" defaultValue="100" />
          </section>
          <section className="property-section muted-section">
            <Sparkles size={18} />
            <strong>专注编辑</strong>
            <p>选择页面中的批注或对象后，可在这里调整详细属性。</p>
          </section>
          <div className="roadmap-note">
            <span>ROADMAP</span>
            <strong>原文编辑将在后续版本加入</strong>
            <p>当前优先完成批注、签名与页面整理。</p>
          </div>
        </aside>
      </div>
    </main>
  );
}

export default App;
