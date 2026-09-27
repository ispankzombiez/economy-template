/**
 * House AI for Poker
 * Implements simple decision-making for the house opponent
 */

import { Card } from "./types";
import { evaluateHand } from "./evaluateHand";

export class HouseAI {
  /**
   * Decide whether the house should call or fold
   * House mostly calls to let player control action
   * Only folds with very weak hands
   */
  decideBetAction(
    houseHand: Card[],
    communityCards: Card[],
    potAmount: number,
    playerBet: number,
    houseChips: number,
    streetIndex: number // 0 = preflop, 1 = post-flop, 2 = post-river
  ): "fold" | "call" {
    // If no bet to call, check
    if (playerBet === 0) {
      return "call";
    }

    // Calculate hand strength
    const allCards = [...houseHand, ...communityCards];
    const handStrength = this.evaluateHandStrength(allCards);

    // House only folds with extremely weak hands (10% strength)
    const foldThreshold = 0.1;

    if (handStrength < foldThreshold) {
      return "fold";
    }

    // Otherwise call - let player decide the action
    return "call";
  }

  /**
   * Evaluate hand strength on a scale of 0-1
   * 0 = very weak, 1 = very strong
   */
  private evaluateHandStrength(cards: Card[]): number {
    if (cards.length < 5) {
      // Pre-flop: evaluate hole cards only
      return this.evaluateHoleCardStrength(cards);
    }

    const evaluation = evaluateHand(cards.slice(0, 5));
    // Convert ranking (0-9) to strength (0-1)
    return evaluation.ranking / 9;
  }

  /**
   * Evaluate just hole cards (pre-flop)
   */
  private evaluateHoleCardStrength(cards: Card[]): number {
    if (cards.length !== 2) return 0.5;

    const [card1, card2] = cards;
    const rankValues: Record<string, number> = {
      A: 14,
      K: 13,
      Q: 12,
      J: 11,
      "10": 10,
      "9": 9,
      "8": 8,
      "7": 7,
      "6": 6,
      "5": 5,
      "4": 4,
      "3": 3,
      "2": 2,
    };

    const v1 = rankValues[card1.rank];
    const v2 = rankValues[card2.rank];
    const averageValue = (v1 + v2) / 2;
    let strength = averageValue / 14;

    // Boost for pairs
    if (card1.rank === card2.rank) {
      strength *= 1.3;
    }

    // Boost for suited cards
    if (card1.suit === card2.suit) {
      strength *= 1.1;
    }

    // Cap at 1.0
    return Math.min(strength, 1.0);
  }

  /**
   * Decide initial bet amount
   */
  decideInitialBet(houseChips: number): number {
    // House starts with a small bet (25% of available chips, capped at bet amounts)
    const maxBet = Math.floor(houseChips * 0.25);
    const availableBets = [1, 5, 10, 25, 50, 100];
    
    for (let i = availableBets.length - 1; i >= 0; i--) {
      if (availableBets[i] <= maxBet) {
        return availableBets[i];
      }
    }
    
    return 1;
  }
}
