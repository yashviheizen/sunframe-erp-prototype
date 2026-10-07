export function Logo({ size = 30 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <rect width="32" height="32" rx="8" fill="#1F3352" />
    <circle cx="16" cy="11" r="4.5" fill="#D99722" />
    <path d="M7 24 L10 18 H22 L25 24 M6 24 H26" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 18 L13 24 M18 18 L19 24" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
  </svg>;
}
