/**
 * The undo window, as the approvals inbox shows it.
 *
 * The server decides when the window closes and says so in `undoableUntil`;
 * this only turns that instant into whole seconds for a countdown. It never
 * extends the window: the state machine refuses a late Undo whatever this says,
 * so rounding here is always down.
 */

/** Whole seconds of undo left, or null once there are none. */
export function undoSecondsLeft(
  undoableUntil: string | null,
  now: number = Date.now(),
): number | null {
  if (undoableUntil === null) return null;
  const until = Date.parse(undoableUntil);
  if (Number.isNaN(until)) return null;
  const seconds = Math.floor((until - now) / 1000);
  return seconds > 0 ? seconds : null;
}
