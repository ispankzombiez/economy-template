import { GameState } from "../adapters/gameTypes";
import {
  isRewardRunAvailableForMinigame,
} from "../poker/session";

export const GO_FISH_RAVEN_COIN_REWARD = 1;

export type GoFishMode = "reward" | "practice";

export const isGoFishRewardRunAvailable = ({
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
    minigame: "gofish",
    isVip,
    now,
  });
};
