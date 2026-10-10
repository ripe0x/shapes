// ShapePackRenderer positions cards on a 3840-square canvas. Keep the draft fan
// in these same slots so an unchanged live pack has the same layout as its token image.
export const PACK_PREVIEW_CANVAS = 3840;
export const PACK_PREVIEW_MAX_CARDS = 12;

export type PackPreviewSlot = {x: number; y: number; width: number; height: number; angle: number};

const floor = Math.floor;

export function packPreviewSlot(rank: number, n: number): PackPreviewSlot {
  if (!Number.isInteger(n) || n < 1 || n > PACK_PREVIEW_MAX_CARDS || !Number.isInteger(rank) || rank < 0 || rank >= n) {
    throw new RangeError("Invalid pack preview rank or card count");
  }
  const canvas = PACK_PREVIEW_CANVAS;
  const center = canvas / 2;
  const pairs = floor(n / 2);

  if (n % 2 === 1) {
    const stepPercent = n > 7 ? 50 : 65 - pairs * 5;
    let frontWidth = pairs === 0 ? 1600 : floor((canvas - 240) * 100 / (pairs * stepPercent * 2 + 58));
    frontWidth = Math.min(frontWidth, 1600);
    if (n > 7) frontWidth = 1005;
    const frontHeight = floor(frontWidth * 7 / 5);
    const baseline = floor((canvas + frontHeight) / 2);
    if (rank === 0) return {x: center - floor(frontWidth / 2), y: baseline - frontHeight,
      width: frontWidth, height: frontHeight, angle: -1};

    const pair = floor((rank + 1) / 2);
    const width = floor(frontWidth * (pair === 1 ? 75 : 58) / 100);
    const height = floor(width * 7 / 5);
    let offset = floor(frontWidth * stepPercent * (pairs === 1 ? 4 : 3) / 400);
    if (pair > 1) offset += 170;
    if (pair > 2) offset += (pair - 2) * 180;
    const right = rank % 2 === 1;
    return {x: center + (right ? offset : -offset) - floor(width / 2), y: baseline - height,
      width, height, angle: right ? 11 - pair * 2 : -(13 - pair * 2)};
  }

  let frontWidth = n === 2 ? 1450 : floor((canvas - 400) * 100 /
    (2 * (39 + (pairs - 1) * 55) + (pairs === 2 ? 75 : 58)));
  if (n > 6) frontWidth = 966;
  const pair = floor(rank / 2);
  const right = rank % 2 === 1;
  const width = pair === 0 ? frontWidth : floor(frontWidth * (pair === 1 ? 75 : 58) / 100);
  const height = floor(width * 7 / 5);
  let offset = floor(frontWidth * 570 / 1450);
  if (pair !== 0) {
    offset += floor(frontWidth * 165 / 400);
    if (pair > 1) offset += 170;
    if (pair > 2) offset += (pair - 2) * 180;
  }
  return {x: center + (right ? offset : -offset) - floor(width / 2),
    y: floor((canvas + floor(frontWidth * 7 / 5)) / 2) - height,
    width, height, angle: pair === 0 ? right ? 5 : -5 : right ? 11 - pair * 2 : -(13 - pair * 2)};
}
