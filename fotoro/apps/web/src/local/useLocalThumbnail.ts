import {useEffect, useState} from "react";
import {type LocalPhoto, LocalResources} from "./resources";

export function useLocalThumbnail(photo: LocalPhoto, resources: LocalResources, onFailure: (id: string, message: string) => void, enabled = true) {
  const [loaded, setLoaded] = useState<{source?: unknown; url: string; error: string}>({url: "", error: ""});
  const source = photo.file ?? photo.preview ?? photo.previewLoader;
  useEffect(() => {
    const controller = new AbortController();
    setLoaded({url: "", error: ""});
    if (!enabled) return;
    void resources.lease(photo, "thumbnail", controller.signal).then(value => {
      if (!controller.signal.aborted) setLoaded({source, url: value.url, error: ""});
    }).catch(error => {
      if (!controller.signal.aborted) {setLoaded({source, url: "", error: error.message}); onFailure(photo.id, error.message);}
    });
    return () => controller.abort();
  }, [photo.id, source, photo.previewAvailable, photo.width, photo.height, resources, enabled]);
  return loaded.source === source ? loaded : {url: "", error: ""};
}
