import { degrees, type PDFPage, type PDFImage } from "pdf-lib";
import type { PageStamp } from "./duplicatePages";

function visiblePageBox(page: PDFPage) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  // Match PDF.js: an invalid/non-intersecting CropBox falls back to MediaBox.
  return right > x && top > y ? { x, y, width: right - x, height: top - y } : media;
}

export function stampDrawOptions(page: PDFPage, stamp: PageStamp) {
  const box = visiblePageBox(page);
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const displayWidth = angle % 180 === 0 ? box.width : box.height;
  const displayHeight = angle % 180 === 0 ? box.height : box.width;
  const displayX = (stamp.x + stamp.width / 2) * displayWidth;
  const displayY = (stamp.y + stamp.height / 2) * displayHeight;
  const center = angle === 90 ? { x: box.x + displayY, y: box.y + displayX }
    : angle === 180 ? { x: box.x + box.width - displayX, y: box.y + displayY }
      : angle === 270 ? { x: box.x + box.width - displayY, y: box.y + box.height - displayX }
        : { x: box.x + displayX, y: box.y + box.height - displayY };
  const imageWidth = stamp.width * displayWidth;
  const imageHeight = stamp.height * displayHeight;
  const radians = (angle - stamp.rotation) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: center.x - (imageWidth * cosine - imageHeight * sine) / 2,
    y: center.y - (imageWidth * sine + imageHeight * cosine) / 2,
    width: imageWidth, height: imageHeight,
    rotate: degrees(angle - stamp.rotation),
  };
}

export function placeStamp(page: PDFPage, image: PDFImage, stamp: PageStamp) {
  page.drawImage(image, stampDrawOptions(page, stamp));
}
