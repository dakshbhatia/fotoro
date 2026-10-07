import type {PhotoMetadataV1} from "@fotoro/contracts";

export function albumMemberLabel(id: string, own: string, names: ReadonlyMap<string, string>, members: readonly string[]) {
  if (id === own) return "You";
  const name = names.get(id); if (name) return name;
  const index = members.indexOf(id);
  return index < 0 ? "Member" : `Member ${index + 1}`;
}
export function albumDateTag(metadata: Pick<PhotoMetadataV1, "sourceDate" | "dateSource">, locale?: string) {
  const date = new Date(metadata.sourceDate);
  if (!Number.isFinite(date.getTime())) return undefined;
  return {text: (metadata.dateSource === "import" ? "Imported " : "") + date.toLocaleDateString(locale, {month: "short", day: "numeric", year: "numeric"}),
    label: metadata.dateSource === "import" ? "Imported date" : "Capture date"};
}
