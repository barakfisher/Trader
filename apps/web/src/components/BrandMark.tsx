/**
 * The TikLens mark: a rising line on an accent tile, the same drawing as
 * `public/favicon.svg` and `public/logo.svg` - keep the three in step. The tile
 * is the accent, not the surface, so the mark stands out from the bar it sits
 * in rather than leaving only a line that reads as an icon button (D357).
 * Inline rather than an `<img>`, so the page's only images are ones it chose to
 * show (the Ask page's test that a reply never renders one counts every `<img>`
 * on the page). Decorative: the name beside it is the label.
 */
export function BrandMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden focusable="false">
      <rect width="512" height="512" rx="112" fill="#6d8bff" />
      <polyline
        points="104,360 208,248 288,312 408,168"
        fill="none"
        stroke="#fff"
        strokeWidth="64"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="408" cy="168" r="44" fill="#35d39a" stroke="#fff" strokeWidth="20" />
    </svg>
  );
}
