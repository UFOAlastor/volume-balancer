// Snap only pointer dragging in a narrow 2-percentage-point neighbourhood.
// Keyboard arrows retain every integer, including values immediately near a mark.
export const VOLUME_MARKS = Object.freeze([0, 30, 70, 100, 150, 200, 300, 400, 500]);
export function magneticVolume(value, pointer = false) {
  const integer = Math.round(Math.max(0, Math.min(500, value)));
  return pointer ? VOLUME_MARKS.find(mark => Math.abs(mark - integer) <= 2) ?? integer : integer;
}
