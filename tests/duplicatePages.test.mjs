import assert from "node:assert/strict";
import { test } from "node:test";
import { duplicatePages, pageCopyBatches } from "../src/duplicatePages.ts";

const image = "data:image/png;base64,shared-image";
const original = {
  id: "page-1", sourceId: "pdf-1", pageNumber: 1, rotation: 90,
  stamps: [
    { id: "stamp-1", dataUrl: image, x: 0.1, y: 0.2, width: 0.3, height: 0.4, rotation: 25 },
    { id: "stamp-2", dataUrl: image, x: 0.5, y: 0.6, width: 0.1, height: 0.2, rotation: 0 },
  ],
};

test("repeated page copies have independent page and stamp identities", () => {
  const first = duplicatePages([original])[0];
  const second = duplicatePages([first])[0];
  const third = duplicatePages([original, first]);
  const all = [original, first, second, ...third];
  assert.equal(new Set(all.map((page) => page.id)).size, all.length);
  assert.equal(new Set(all.flatMap((page) => page.stamps.map((stamp) => stamp.id))).size, all.length * 2);
  for (const copy of all.slice(1)) {
    assert.notStrictEqual(copy.stamps, original.stamps);
    assert.deepEqual(copy.stamps.map((stamp) => stamp.dataUrl), [image, image]);
    assert.deepEqual(copy.stamps.map(({ id, ...layout }) => layout),
      original.stamps.map(({ id, ...layout }) => layout));
  }
});

test("selecting or editing a copied stamp does not affect its source or another copy", () => {
  const [copyA, copyB] = duplicatePages([original, original]);
  const selectedId = copyA.stamps[0].id;
  assert.equal([original, copyA, copyB].filter((page) => page.stamps.some((stamp) => stamp.id === selectedId)).length, 1);

  const composition = [original, copyA, copyB];
  const edited = composition.map((page) => page.id === copyA.id
    ? { ...page, stamps: page.stamps.map((stamp) => stamp.id === selectedId
      ? { ...stamp, x: 0.42, width: 0.22, rotation: 135 } : stamp) }
    : page);
  assert.equal(edited[1].stamps[0].x, 0.42);
  assert.equal(edited[1].stamps[0].width, 0.22);
  assert.equal(edited[1].stamps[0].rotation, 135);
  assert.deepEqual(edited[0], original);
  assert.deepEqual(edited[2], copyB);
  assert.equal(composition[1].stamps[0].x, 0.1); // undo can restore the prior snapshot
  assert.equal(edited[1].stamps[0].dataUrl, image); // export still sees the same image data
});

test("export batches separate repeated source pages without losing composition order", () => {
  const pages = [original, { ...original, id: "page-2", pageNumber: 2 },
    ...duplicatePages([original, original]), { ...original, id: "page-3", pageNumber: 3 }];
  const batches = [...pageCopyBatches(pages, 3)];
  assert.deepEqual(batches.flat(), pages);
  assert.deepEqual(batches.map((batch) => batch.map((page) => page.pageNumber)), [[1, 2], [1], [1, 3]]);
  assert.ok(batches.every((batch) => new Set(batch.map((page) => page.pageNumber)).size === batch.length));
});
