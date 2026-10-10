import React from "react";
import type { ChestTallyEntry } from "../lib/chestApi";

/**
 * The chest leaderboard, shown once the global supply is spent.
 *
 * Ranked highest first, with the viewer's own row always visible even when they
 * are nowhere near the top — being told "you got 3, they got 400" is the joke,
 * and a list that silently omits the reader makes them wonder whether they are
 * even on it.
 *
 * This is the payoff of a feature nobody is supposed to know about, so it is
 * styled like a scoreboard rather than a settings list: monospaced numerals,
 * rank down the left, the reader's own row picked out at the bottom.
 */

type Props = {
  entries: ChestTallyEntry[];
  /** The caller's row, or `null` if they never won one. */
  you: ChestTallyEntry | null;
};

export const ArcadeChestLeaderboard: React.FC<Props> = ({ entries, you }) => {
  const rows = entries.slice(0, 10);
  const viewerIsListed = rows.some((row) => row.farmId === you?.farmId);

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[#8f74ad]">
          Found them first
        </span>
        <span className="text-[10px] text-[#8f74ad]">
          {entries.length === 0 ? "nobody yet" : `${entries.length} on the board`}
        </span>
      </div>

      {rows.length > 0 ? (
        <ol className="mt-1.5 space-y-px">
          {rows.map((row, index) => (
            <li
              key={row.farmId}
              className="flex items-baseline gap-2 bg-[#150d1f] px-2 py-1 text-xs"
            >
              <span className="w-4 shrink-0 text-right font-mono text-[10px] text-[#6d5588]">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#dfc7f1]">
                {row.username || `#${row.farmId}`}
              </span>
              <span className="shrink-0 font-mono text-[#f5c86b]">
                {row.tickets}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-1.5 text-xs text-[#8f74ad]">
          Nobody has claimed one of these yet. Which means the first one is
          yours, if you are willing to keep clicking.
        </p>
      )}

      {you && !viewerIsListed ? (
        <div className="mt-2 border-t border-[#2e2140] pt-2">
          <div className="flex items-baseline gap-2 bg-[#221634] px-2 py-1 text-xs">
            <span className="w-4 shrink-0 text-right font-mono text-[10px] text-[#8f74ad]">
              —
            </span>
            <span className="min-w-0 flex-1 truncate text-[#dfc7f1]">
              {you.username || `#${you.farmId}`} (you)
            </span>
            <span className="shrink-0 font-mono text-[#f5c86b]">
              {you.tickets}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-[#6d5588]">
            Everyone above you clicked harder than you did.
          </p>
        </div>
      ) : null}
    </div>
  );
};