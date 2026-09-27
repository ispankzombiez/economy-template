import { Card, CardSuit } from "../poker/types";

export interface TableauPile {
  faceDown: Card[];
  faceUp: Card[];
}

export type FoundationPiles = Record<CardSuit, Card[]>;

export type SelectedCard =
  | { source: "waste" }
  | { source: "tableau"; pileIndex: number; cardIndex: number };

export interface SolitaireState {
  tableau: TableauPile[];
  foundations: FoundationPiles;
  stock: Card[];
  waste: Card[];
  passesRemaining: number;
  moves: number;
  selected: SelectedCard | null;
}
