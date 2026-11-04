export type PageStamp = {
  id: string;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

export type ComposedPage = {
  id: string;
  sourceId: string;
  pageNumber: number;
  rotation: number;
  stamps: PageStamp[];
};

export function duplicatePages(pages: ComposedPage[]): ComposedPage[] {
  return pages.map((page) => ({
    ...page,
    id: `${page.id}-copy-${crypto.randomUUID()}`,
    stamps: page.stamps.map((stamp) => ({ ...stamp, id: crypto.randomUUID() })),
  }));
}

export function* pageCopyBatches(pages: ComposedPage[], batchSize: number): Generator<ComposedPage[]> {
  for (let offset = 0; offset < pages.length;) {
    const batch: ComposedPage[] = [];
    const pageNumbers = new Set<number>();
    while (offset < pages.length && batch.length < batchSize && !pageNumbers.has(pages[offset].pageNumber)) {
      const page = pages[offset++];
      batch.push(page);
      pageNumbers.add(page.pageNumber);
    }
    yield batch;
  }
}
