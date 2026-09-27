/**
 * Uno Deck
 *
 * 108-card standard Uno deck:
 *  - 4 colours × (one 0, two each of 1-9, Skip, Reverse, DrawTwo) = 4 × 25 = 100
 *  - 4 × Wild + 4 × WildDrawFour = 8
 *  Total = 108
 */
import { UnoCard, UnoColor, UnoFace } from "./types";

const COLORS: Exclude<UnoColor, "Wild">[] = [
  "Kale",
  "Barley",
  "Wheat",
  "Radish",
];

let _idCounter = 0;
const nextId = () => String(++_idCounter);

export class UnoDeck {
  private cards: UnoCard[];

  constructor() {
    this.cards = UnoDeck.buildDeck();
    this.shuffle();
  }

  private static buildDeck(): UnoCard[] {
    const deck: UnoCard[] = [];

    for (const color of COLORS) {
      // One 0
      deck.push({ color, face: "0", id: nextId() });

      // Two of each 1-9 + action cards
      const repeated: UnoFace[] = [
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "Skip",
        "Reverse",
        "DrawTwo",
      ];

      for (const face of repeated) {
        deck.push({ color, face, id: nextId() });
        deck.push({ color, face, id: nextId() });
      }
    }

    // Wilds
    for (let i = 0; i < 4; i++) {
      deck.push({ color: "Wild", face: "Wild", id: nextId() });
      deck.push({ color: "Wild", face: "WildDrawFour", id: nextId() });
    }

    return deck;
  }

  private shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  deal(): UnoCard | null {
    return this.cards.pop() ?? null;
  }

  dealMultiple(n: number): UnoCard[] {
    const result: UnoCard[] = [];

    for (let i = 0; i < n; i++) {
      const card = this.deal();

      if (card) {
        result.push(card);
      }
    }

    return result;
  }

  remaining(): number {
    return this.cards.length;
  }

  /** Reshuffle the discard pile back into the deck when it runs out */
  refill(discardPile: UnoCard[]): UnoCard[] {
    if (discardPile.length <= 1) {
      return discardPile;
    }

    // Keep the top card; shuffle the rest back
    const topCard = discardPile[discardPile.length - 1];
    const toShuffle = discardPile.slice(0, discardPile.length - 1);

    this.cards = [...toShuffle];
    this.shuffle();

    return [topCard];
  }
}
