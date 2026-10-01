export function Icon({
  kind,
}: {
  kind: "close" | "previous" | "next" | "info";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "close" ? (
        <path d="m5 5 14 14M19 5 5 19" />
      ) : kind === "previous" ? (
        <path d="m15 4-8 8 8 8" />
      ) : kind === "next" ? (
        <path d="m9 4 8 8-8 8" />
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7v.2" />
        </>
      )}
    </svg>
  );
}
