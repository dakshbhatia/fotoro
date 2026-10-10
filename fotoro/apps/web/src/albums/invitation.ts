export async function copyAlbumInvitation(link: string, current: () => boolean,
  clipboard?: Pick<Clipboard, "writeText">): Promise<"copied" | "manual" | undefined> {
  if (!current()) return;
  try {
    if (!clipboard) return "manual";
    await clipboard.writeText(link);
    return current() ? "copied" : undefined;
  } catch {
    return current() ? "manual" : undefined;
  }
}
