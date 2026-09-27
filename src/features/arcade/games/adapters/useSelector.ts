import { useCallback, useSyncExternalStore } from "react";

/**
 * Minimal stand-in for `useSelector` from `@xstate/react` (not installed).
 *
 * The original arcade pulled the portal machine's state through
 * `useSelector(portalService, selector)`. Here `portalService` is the plain
 * subscribe/snapshot store defined in `./portal`, so the shim is just
 * `useSyncExternalStore` over `service.getSnapshot()`.
 *
 * `selector` must return a reference-stable value (the games select
 * `state.context.state`, which the store only replaces when it mutates).
 */
export type SubscribableService<T> = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
};

export function useSelector<T, R>(
  service: SubscribableService<T>,
  selector: (state: T) => R,
): R {
  const getSnapshot = useCallback(
    () => selector(service.getSnapshot()),
    [service, selector],
  );

  return useSyncExternalStore(service.subscribe, getSnapshot, getSnapshot);
}
