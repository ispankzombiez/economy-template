import { useEffect, useState } from "react";

/**
 * Track a CSS media query from React.
 *
 * ## Why this exists
 *
 * The alternative to a query hook is two class strings — `sm:hidden` and
 * `hidden sm:block` — around two copies of the same markup. That is fine until
 * the duplicated subtree carries **state**, which is exactly what happened to the
 * Sunflower Brawler's champion select: the phone layout wanted the cards moved
 * into a sheet with Confirm/Cancel, and CSS cannot move a subtree or give it a
 * second life. So the branch is decided in JS and the card grid is rendered once.
 *
 * Read the breakpoint from the same place the Tailwind `sm:` classes come from, or
 * the two will disagree at the boundary.
 *
 * ## The initial value is read synchronously, not defaulted
 *
 * It is tempting to start at `false` and correct in an effect. That is wrong here,
 * and wrong in the direction that shows: on a phone the first paint would render
 * the **wide** branch (four champion cards, no CHANGE button) and then swap to the
 * narrow one a frame later — a visible flash of a layout the player will never
 * use, on the screen they open most often. The query is readable during render in
 * a client-only app, so there is no reason to guess and then correct.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);

    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/**
 * Is this the narrow layout?
 *
 * **639px**, i.e. Tailwind's `sm` breakpoint minus one. Named so the intent
 * survives copy-paste: this is the breakpoint every `sm:` class in these lobbies
 * turns on, and asking for the *narrow* case is far less error-prone than asking
 * for the wide one and getting the boundary wrong.
 */
export const NARROW_LAYOUT_QUERY = "(max-width: 639px)";

export function useIsNarrowLayout(): boolean {
  return useMediaQuery(NARROW_LAYOUT_QUERY);
}
