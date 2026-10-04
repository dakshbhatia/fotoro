import {useLayoutEffect, useMemo, useRef, useState} from "react";
import {ConsumerPreviewResources} from "../library/consumer-search";
import {PickAnalyzer, type PhotoRecommendations} from "./auto-picks";
import {readPickSignals} from "./usePhotoPicks";
import type {LocalPhoto} from "./resources";
import {runCurrentFindReview} from "./find-best-shots";

export function useFindBestShots(photos: LocalPhoto[], scope: string, source: unknown, current: () => boolean, enabled = true) {
  const [chosenScope, setChosenScope] = useState<string>();
  const [analyzer] = useState(() => new PickAnalyzer()), [resources] = useState(() => new ConsumerPreviewResources());
  const input = useMemo(() => ({photos, scope, source}), [photos, scope, source]);
  const latest = useRef({input, current, enabled});
  latest.current = {input, current, enabled};
  const [state, setState] = useState<{input: typeof input; done: number; recommendations?: PhotoRecommendations}>();
  const active = enabled && !!scope && chosenScope === scope;
  const recommendations = active && state?.input === input && current() ? state.recommendations : undefined;
  const done = active && state?.input === input ? state.done : 0;
  useLayoutEffect(() => {
    analyzer.clear(); resources.clear();
    return () => {analyzer.clear(); resources.clear();};
  }, [source, enabled, analyzer, resources]);
  useLayoutEffect(() => {
    if (!active) return;
    let alive = true;
    const check = () => {
      if (!alive || latest.current.input !== input || !latest.current.enabled || !latest.current.current())
        throw new DOMException("Review cancelled", "AbortError");
    };
    setState({input, done: 0});
    const current = () => {try {check(); return true;} catch {return false;}};
    void runCurrentFindReview(analyzer, photos, photo => readPickSignals(photo, resources), current,
      completed => {setState({input, done: completed});}).then(result => {
      try {check(); if (result) setState({input, done: photos.length, recommendations: result});} catch {}
    });
    return () => {alive = false; analyzer.cancel();};
  }, [active, input, analyzer, resources, photos]);
  useLayoutEffect(() => {
    const cancel = () => {analyzer.clear(); resources.clear(); setChosenScope(undefined); setState(undefined);};
    window.addEventListener("fotoro-lock", cancel);
    return () => {window.removeEventListener("fotoro-lock", cancel); analyzer.clear(); resources.clear();};
  }, [analyzer, resources]);
  return {active, busy: active && !recommendations, done, recommendations,
    toggle: () => setChosenScope(active ? undefined : scope)};
}
