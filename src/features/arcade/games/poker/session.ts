import { GameState } from "../adapters/gameTypes";
import { MinigameName } from "../adapters/gameTypes";

export const NIGHTSHADE_ARCADE_MINIGAMES: MinigameName[] = [
  "poker",
  "blackjack",
  "gofish",
  "roulette",
  "slots",
  "barley-breaker" as MinigameName,
  "uno",
  "solitaire" as MinigameName,
  "goblin-invaders" as MinigameName,
  "tetris" as MinigameName,
  "pac-man" as MinigameName,
  "frogger" as MinigameName,
  "raven-bubbles" as MinigameName,
  "sunflower-brawler" as MinigameName,
];

export const POKER_STARTING_CHIPS = 100;
export const POKER_MAX_HANDS = 5;
export const POKER_RAVEN_COIN_REWARD = 1;
/**
 * FLOWER price of the legacy "+1 reward attempt" button.
 *
 * Superseded: extra reward runs are now paid for with a **Play Ticket**
 * (`Mint-Play-Ticket` burns one), bought from the economy's `purchases`
 * (`ticket_1`…`ticket_4`). Kept only so old saves/imports that reference the
 * constant still compile.
 */
export const EXTRA_REWARD_ATTEMPT_FLOWER_COST = 5;
export const MAX_PAID_REWARD_ATTEMPTS_PER_DAY = 2;
/** Free reward runs per day: one for everyone (arcade-wide), VIP per machine. */
export const FREE_REWARD_RUNS_PER_DAY = 1;

export type PokerMode = "reward" | "practice";
export type PokerDifficultyName = "easy" | "medium" | "hard" | "expert";

export type PokerDifficulty = {
  name: PokerDifficultyName;
  label: string;
  targetChips: number;
  weight: number;
};

export const POKER_DIFFICULTIES: PokerDifficulty[] = [
  { name: "easy", label: "Easy", targetChips: 200, weight: 2 },
  { name: "medium", label: "Medium", targetChips: 500, weight: 3 },
  { name: "hard", label: "Hard", targetChips: 750, weight: 3 },
  { name: "expert", label: "Expert", targetChips: 1000, weight: 2 },
];

export const getTodayKey = (now: Date | number = Date.now()) =>
  new Date(now).toISOString().slice(0, 10);

export const getPokerDifficultyFromSeed = (seed: number): PokerDifficulty => {
  const totalWeight = POKER_DIFFICULTIES.reduce(
    (total, difficulty) => total + difficulty.weight,
    0,
  );
  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;

  for (const difficulty of POKER_DIFFICULTIES) {
    threshold += difficulty.weight;

    if (normalizedSeed < threshold) {
      return difficulty;
    }
  }

  return POKER_DIFFICULTIES[POKER_DIFFICULTIES.length - 1];
};

export const getPokerDifficulty = (
  now: Date | number = Date.now(),
): PokerDifficulty => {
  const todayKey = getTodayKey(now);
  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 7);

  return getPokerDifficultyFromSeed(seed >>> 0);
};

export const getArcadeAttemptsUsedToday = (
  game: GameState,
  now: Date | number = Date.now(),
) => {
  const todayKey = getTodayKey(now);

  return NIGHTSHADE_ARCADE_MINIGAMES.reduce((total, minigame) => {
    return (
      total +
      (game.minigames.games[minigame]?.history?.[todayKey]?.attempts ?? 0)
    );
  }, 0);
};

export const getMinigameAttemptsUsedToday = (
  game: GameState,
  minigame: MinigameName,
  now: Date | number = Date.now(),
) => {
  const todayKey = getTodayKey(now);

  return game.minigames.games[minigame]?.history?.[todayKey]?.attempts ?? 0;
};

export const getMinigamePurchasesUsedToday = (
  game: GameState,
  minigame: MinigameName,
  now: Date | number = Date.now(),
) => {
  const todayKey = getTodayKey(now);

  const purchases = game.minigames.games[minigame]?.purchases ?? [];

  return purchases.reduce((total, purchase) => {
    const purchaseDay = new Date(purchase.purchasedAt)
      .toISOString()
      .slice(0, 10);
    return total + (purchaseDay === todayKey ? 1 : 0);
  }, 0);
};

export const getRemainingPaidAttemptsForMinigame = (
  game: GameState,
  minigame: MinigameName,
  now: Date | number = Date.now(),
) => {
  const purchasesUsed = getMinigamePurchasesUsedToday(game, minigame, now);
  return Math.max(0, MAX_PAID_REWARD_ATTEMPTS_PER_DAY - purchasesUsed);
};

/**
 * Is today's **free** reward run still available?
 *
 * Free runs are counted separately from paid ones because they are what the
 * server's `dailyCap` on `Mint-Raven-Coin` enforces:
 *
 *  - **non-VIP** — one for the whole arcade, so the tally is the arcade-wide
 *    sum (`getArcadeAttemptsUsedToday`, written to the `roulette` slot);
 *  - **VIP** — one per machine, so only this cabinet's own history counts.
 */
export const isFreeRewardRunAvailableForMinigame = ({
  game,
  minigame,
  isVip,
  now = Date.now(),
}: {
  game: GameState;
  minigame: MinigameName;
  isVip: boolean;
  now?: Date | number;
}): boolean => {
  if (isVip) {
    return (
      getMinigameAttemptsUsedToday(game, minigame, now) <
      FREE_REWARD_RUNS_PER_DAY
    );
  }

  return getArcadeAttemptsUsedToday(game, now) < FREE_REWARD_RUNS_PER_DAY;
};

/**
 * Can the player start a reward run on this machine right now?
 *
 * Either today's free run is still going, or they are holding a Play Ticket —
 * which is exactly the rule: free first, then 1 burned ticket per attempt.
 */
export const isRewardRunAvailableForMinigame = ({
  game,
  minigame,
  isVip,
  now = Date.now(),
}: {
  game: GameState;
  minigame: MinigameName;
  isVip: boolean;
  now?: Date | number;
}): boolean => {
  if (isFreeRewardRunAvailableForMinigame({ game, minigame, isVip, now })) {
    return true;
  }

  return (game.playTickets ?? 0) > 0;
};

export const getPokerMode = ({
  game,
  isVip,
  now = Date.now(),
}: {
  game: GameState;
  isVip: boolean;
  now?: Date | number;
}): PokerMode => {
  if (isVip) {
    return getMinigameAttemptsUsedToday(game, "poker", now) === 0
      ? "reward"
      : "practice";
  }

  return getArcadeAttemptsUsedToday(game, now) === 0 ? "reward" : "practice";
};

export const isRewardRunAvailable = ({
  game,
  isVip,
  now = Date.now(),
}: {
  game: GameState;
  isVip: boolean;
  now?: Date | number;
}): boolean => {
  return isRewardRunAvailableForMinigame({
    game,
    minigame: "poker",
    isVip,
    now,
  });
};
