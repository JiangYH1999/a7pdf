import assert from "node:assert/strict";
import { test } from "node:test";
import { degrees, PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { stampDrawOptions } from "../src/stampPlacement.ts";

const stamp = {
  id: "overlay", dataUrl: "data:image/png;base64,unused",
  x: 0.23, y: 0.37, width: 0.28, height: 0.16, rotation: 31,
};

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} !== ${expected}`);
}

for (const [name, media, crop] of [
  ["ordinary page", [0, 0, 612, 792], null],
  ["offset CropBox", [35, 55, 612, 792], [120, 155, 400, 500]],
  ["CropBox crossing MediaBox", [35, 55, 612, 792], [0, 100, 200, 300]],
  ["non-intersecting CropBox", [35, 55, 612, 792], [800, 900, 100, 100]],
]) {
  test(`${name}: placement matches PDF.js preview at all page rotations`, async () => {
    const document = await PDFDocument.create();
    for (const angle of [0, 90, 180, 270]) {
      const page = document.addPage([media[2], media[3]]);
      page.setMediaBox(...media);
      if (crop) page.setCropBox(...crop);
      page.setRotation(degrees(angle));
    }
    const task = getDocument({ data: new Uint8Array(await document.save()) });
    const preview = await task.promise;
    try {
      for (let index = 0; index < 4; index++) {
        const page = document.getPage(index);
        const viewport = (await preview.getPage(index + 1)).getViewport({ scale: 1 });
        const options = stampDrawOptions(page, stamp);
        const radians = options.rotate.angle * Math.PI / 180;
        const cosine = Math.cos(radians);
        const sine = Math.sin(radians);
        const centerX = options.x + (options.width * cosine - options.height * sine) / 2;
        const centerY = options.y + (options.width * sine + options.height * cosine) / 2;
        const [x, y] = viewport.convertToViewportPoint(centerX, centerY);
        close(x, (stamp.x + stamp.width / 2) * viewport.width);
        close(y, (stamp.y + stamp.height / 2) * viewport.height);

        // The image's horizontal axis should keep its preview width and rotation.
        const [axisX, axisY] = viewport.convertToViewportPoint(
          centerX + options.width * cosine, centerY + options.width * sine,
        );
        const displayAngle = stamp.rotation * Math.PI / 180;
        close(axisX - x, stamp.width * viewport.width * Math.cos(displayAngle));
        close(axisY - y, stamp.width * viewport.width * Math.sin(displayAngle));
      }
    } finally {
      await task.destroy();
    }
  });
}
