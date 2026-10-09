import {useLayoutEffect, useMemo, useRef, useState} from "react";
import type {LocalPhoto} from "./resources";
import type {SearchResult} from "./search";
import {SemanticFindSession, addSemanticMatches, eligibleSemanticPhotos, permitsSemanticMatches, semanticPreviewStatus, subscribeSemanticLifecycle} from "./semantic-find";
export function useSemanticFind(photos: LocalPhoto[], base: SearchResult, active: boolean, source: unknown, committedMeaning?: string) {
  const session = useRef<SemanticFindSession | null>(null);
  const [foreground, setForeground] = useState(0);
  const input = useMemo(() => ({photos, base, active, source, committedMeaning, foreground}), [photos, base, active, source, committedMeaning, foreground]);
  const latest = useRef(input); latest.current = input;
  const invalidated = useRef(false);
  const [result, setResult] = useState<{input: typeof input; scores?: ReadonlyMap<string, number>; pending: boolean; visualStatus?: SearchResult["visualStatus"]} | undefined>();
  const canSearch = active && !invalidated.current && (typeof document === "undefined" || document.visibilityState !== "hidden")
    && permitsSemanticMatches(base, committedMeaning) && eligibleSemanticPhotos(photos, base.query).length > 0;
  useLayoutEffect(() => {
    session.current?.clear(); session.current = null; setResult(undefined);
    invalidated.current = false;
    return () => {session.current?.clear(); session.current = null;};
  }, [active, source]);
  useLayoutEffect(() => {
    const cancel = () => {invalidated.current = true; session.current?.clear(); session.current = null; setResult(undefined);};
    return subscribeSemanticLifecycle(cancel, () => {invalidated.current = false; setForeground(value => value + 1);});
  }, []);
  useLayoutEffect(() => {
    setResult(undefined);
    session.current?.reconcile(photos);
    if (!canSearch) return;
    setResult({input, pending: true});
    let current = true;
    const engine = session.current ??= new SemanticFindSession();
    const timer = setTimeout(() => {
      const valid = () => current && latest.current === input && !invalidated.current && document.visibilityState !== "hidden";
      void engine.search(photos, base.query, valid, scores => {if (valid()) setResult({input, scores, pending: true});})
        .then(visualStatus => {if (valid()) setResult(previous => ({...previous, input, pending: false, visualStatus}));})
        .catch(() => {if (valid()) setResult(previous => ({...previous, input, pending: false, visualStatus: "unavailable"}));});
    }, 250);
    return () => {current = false; clearTimeout(timer); engine.cancel();};
  }, [input]);
  return useMemo(() => {
    const current = result?.input === input;
    const matched = canSearch && current && result.scores ? addSemanticMatches(base, result.scores,
      new Set(photos.filter(photo => photo.current?.() !== false).map(photo => photo.id)), committedMeaning) : base;
    const visualStatus = canSearch && current ? result.visualStatus
      : active && !invalidated.current && permitsSemanticMatches(base, committedMeaning) && (typeof document === "undefined" || document.visibilityState !== "hidden")
        ? semanticPreviewStatus(photos, base.query) : undefined;
    return canSearch && (!current || result.pending) ? {...matched, searching: true}
      : visualStatus ? {...matched, visualStatus} : matched;
  }, [result, input, canSearch, base, photos, committedMeaning]);
}
