/* Small outline symbols for the photo control layer. */
export function PhotoSymbol({
    name,
}: {
    name: "search" | "add" | "close" | "previous" | "next" | "share" | "up";
}) {
    const paths = {
        search: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm5.3-2.2L22 22",
        add: "M12 4v16M4 12h16",
        close: "m5 5 14 14M19 5 5 19",
        previous: "m15 4-8 8 8 8",
        next: "m9 4 8 8-8 8",
        share: "M12 15V2m-4 4 4-4 4 4M7 10H4v12h16V10h-3",
        up: "m5 15 7-7 7 7",
    };
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d={paths[name]} />
        </svg>
    );
}
