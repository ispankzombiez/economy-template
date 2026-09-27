import { GameState } from "../adapters/gameTypes";
import {
  isRewardRunAvailableForMinigame,
} from "../poker/session";

export const UNO_RAVEN_COIN_REWARD = 1;

export type UnoMode = "reward" | "practice";

export const isUnoRewardRunAvailable = ({
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
    minigame: "uno",
    isVip,
    now,
  });
};
