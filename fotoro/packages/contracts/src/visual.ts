import type {PhotoVisualV1} from "./models";

export const VISUAL_PROCESSOR = "vision-image-classification-r1-v1";
// Reader-first rollout: enable only after every installed native reader is qualified.
// This mirrors SearchVisualPolicy.publicationEnabled and is checked by shared vectors.
export const VISUAL_PUBLICATION_ENABLED = false;
export const VISUAL_MINIMUM_CONFIDENCE = 0.65;
export const VISUAL_MAXIMUM_LABELS = 6;
// Mirrored by native SearchVisualPolicy and verified with shared fixture vectors.
// Exact identifiers only: faces, names and substring guesses are never categories.
const categories: Record<string, string> = {
  beach: "beach", dog: "dog", bulldog: "dog", sheepdog: "dog",
  bernese_mountain: "dog", cat: "cat", adult_cat: "cat", bird: "bird",
  hummingbird: "bird", mountain: "mountain", food: "food", seafood: "food",
  cake: "cake", cake_regular: "cake", birthday_cake: "cake", wedding_cake: "cake",
  flower: "flower", flower_arrangement: "flower", sunflower: "flower",
  car: "car", sportscar: "car", boat: "boat", rowboat: "boat", sailboat: "boat",
  houseboat: "boat", speedboat: "boat", snow: "snow", forest: "forest",
  tree: "tree", palm_tree: "tree", oak_tree: "tree", maple_tree: "tree",
  waterfall: "waterfall", lake: "lake", ocean: "ocean", bicycle: "bicycle",
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function validatedVisualLabels(visual?: PhotoVisualV1): PhotoVisualV1["labels"] {
  if (visual?.processor !== VISUAL_PROCESSOR || !Array.isArray(visual.labels)) return [];
  const strongest = new Map<string, PhotoVisualV1["labels"][number]>();
  for (const value of visual.labels) {
    if (!value || !Object.hasOwn(categories, value.identifier) || categories[value.identifier] !== value.label
      || !Number.isFinite(value.confidence) || value.confidence < VISUAL_MINIMUM_CONFIDENCE || value.confidence > 1) continue;
    const previous = strongest.get(value.label);
    if (previous && (previous.confidence > value.confidence || previous.confidence === value.confidence && previous.identifier < value.identifier)) continue;
    strongest.set(value.label, value);
  }
  return [...strongest.values()].sort((a, b) => b.confidence - a.confidence || compare(a.label, b.label)).slice(0, VISUAL_MAXIMUM_LABELS);
}
