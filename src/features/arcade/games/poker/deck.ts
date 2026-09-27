/**
 * Poker Deck Management
 * Handles creating, shuffling, and dealing cards
 */

import { Card, CardRank, CardSuit } from "./types";

const SUITS: CardSuit[] = ["Kale", "Barley", "Wheat", "Radish"];
const RANKS: CardRank[] = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

export class PokerDeck {
  private cards: Card[] = [];

  constructor() {
    this.reset();
  }

  /**
   * Create a fresh deck of 52 cards
   */
  reset(): void {
    this.cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push({ suit, rank });
      }
    }
    this.shuffle();
  }

  /**
   * Fisher-Yates shuffle algorithm
   */
  shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  /**
   * Deal a single card from the top of the deck
   */
  deal(): Card {
    const card = this.cards.pop();
    if (!card) {
      throw new Error("No cards left in deck");
    }
    return card;
  }

  /**
   * Deal multiple cards
   */
  dealMultiple(count: number): Card[] {
    const dealt: Card[] = [];
    for (let i = 0; i < count; i++) {
      dealt.push(this.deal());
    }
    return dealt;
  }

  /**
   * Get remaining cards in deck
   */
  getRemaining(): number {
    return this.cards.length;
  }

  /**
   * Get the full deck (for testing)
   */
  getDeck(): Card[] {
    return [...this.cards];
  }
}

/**
 * Create a standard poker deck
 */
export function createDeck(): PokerDeck {
  return new PokerDeck();
}
