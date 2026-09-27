/**
 * Blackjack Deck
 * Thin wrapper that re-exports the poker deck — same 52-card deck, same suits.
 */
export {
  PokerDeck as BlackjackDeck,
  createDeck as createBlackjackDeck,
} from "../poker/deck";
