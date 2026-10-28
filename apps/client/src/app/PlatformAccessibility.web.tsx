/** Scope reduced motion to this application, including third-party setting controls. */
export default function PlatformAccessibility() {
  return (
    <style>{`@media (prefers-reduced-motion: reduce) { #signaldock-root *, #signaldock-root *::before, #signaldock-root *::after { animation-duration: 0s !important; transition-duration: 0s !important; scroll-behavior: auto !important; } }`}</style>
  );
}
