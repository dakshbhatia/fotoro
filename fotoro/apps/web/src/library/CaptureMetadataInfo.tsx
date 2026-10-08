import {annotationCaptureMetadata, captureMetadataRows} from "@fotoro/contracts/capture-metadata";
export function CaptureMetadataInfo({facts, originalSha256}: {facts?: readonly string[]; originalSha256: string}) {
  const metadata = annotationCaptureMetadata({facts}, originalSha256);
  if (!metadata) return null;
  return <details><summary>Camera and media</summary><dl>
    {captureMetadataRows(metadata).map((row, index) => <div key={index}>
      <dt>{row.label} · {row.provenance === "photos" ? "Photos" : "Original file"}</dt><dd>{row.value}</dd>
    </div>)}
  </dl></details>;
}
