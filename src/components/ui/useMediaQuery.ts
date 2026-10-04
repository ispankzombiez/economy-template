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
 * the two will disagree at the boundary and you get a flash of the wrong layout.
 *
 * Starts `false` so the first render matches the server-less assumption of a
 * narrow screen and then corrects itself, which is the safe direction: the
 * collapsed layout is the one that fits anywhere.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
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
