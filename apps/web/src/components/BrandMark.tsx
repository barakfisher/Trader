/**
 * The TikLens mark: a lens over a rising line, the small-size variant that
 * `public/favicon.svg` also draws - keep the two in step. Inline rather than an
 * `<img>`, so the page's only images are ones it chose to show (the Ask page's
 * test that a reply never renders one counts every `<img>` on the page).
 * Decorative: the name beside it is the label.
 */
export function BrandMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden focusable="false">
      <rect width="512" height="512" rx="112" fill="#0b1020" />
      <circle cx="220" cy="220" r="118" fill="none" stroke="#6d8bff" strokeWidth="56" />
      <polyline
        points="160,250 220,190 280,190"
        fill="none"
        stroke="#35d39a"
        strokeWidth="44"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="320" y1="320" x2="404" y2="404" stroke="#6d8bff" strokeWidth="64" strokeLinecap="round" />
    </svg>
  );
}
