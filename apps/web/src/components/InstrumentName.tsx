/**
 * An instrument's name on one line, cut at the end of its own reading direction.
 *
 * `truncate` on a block of the page's direction cuts by that direction: on a
 * right-to-left page a Latin name lost its beginning ("...t SPDR S&P 500 ETF
 * Trust"), and a name's beginning is the part that says what it is. The name
 * takes its own direction here, and the flex parent keeps it at the page's start.
 */
export function InstrumentName({ children }: { children: string }) {
  return (
    <p className="flex text-xs text-text-muted">
      <bdi dir="auto" className="min-w-0 truncate">
        {children}
      </bdi>
    </p>
  );
}
