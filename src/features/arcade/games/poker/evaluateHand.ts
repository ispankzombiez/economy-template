/**
 * Poker Hand Evaluation Logic
 * Evaluates 5-card poker hands and determines winners
 */

import { Card, CardRank, EvaluatedHand, HandRanking } from "./types";

// Rank values for comparison
const RANK_VALUES: Record<CardRank, number> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const RANK_NAMES: Record<CardRank, string> = {
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  "10": "10",
  J: "Jack",
  Q: "Queen",
  K: "King",
  A: "Ace",
};

const HAND_RANKING_NAMES: Record<HandRanking, string> = {
  [HandRanking.HighCard]: "High Card",
  [HandRanking.OnePair]: "One Pair",
  [HandRanking.TwoPair]: "Two Pair",
  [HandRanking.ThreeOfAKind]: "Three of a Kind",
  [HandRanking.Straight]: "Straight",
  [HandRanking.Flush]: "Flush",
  [HandRanking.FullHouse]: "Full House",
  [HandRanking.FourOfAKind]: "Four of a Kind",
  [HandRanking.StraightFlush]: "Straight Flush",
  [HandRanking.RoyalFlush]: "Royal Flush",
};

/**
 * Get the best 5-card hand from 7 cards (5 community + 2 hole cards)
 */
export function getBestHand(cards: Card[]): Card[] {
  if (cards.length < 5) {
    return cards;
  }

  // Generate all 5-card combinations from the 7 cards
  const combinations = generateCombinations(cards, 5);

  let bestHand = combinations[0];
  let bestRanking = evaluateHand(bestHand).ranking;

  for (let i = 1; i < combinations.length; i++) {
    const ranking = evaluateHand(combinations[i]).ranking;
    if (ranking > bestRanking) {
      bestHand = combinations[i];
      bestRanking = ranking;
    }
  }

  return bestHand;
}

/**
 * Evaluate a 5-card hand and return its ranking
 */
export function evaluateHand(cards: Card[]): EvaluatedHand {
  if (cards.length !== 5) {
    throw new Error("Hand must contain exactly 5 cards");
  }

  // Check for each hand ranking from highest to lowest
  if (isRoyalFlush(cards)) {
    return {
      ranking: HandRanking.RoyalFlush,
      rankingName: HAND_RANKING_NAMES[HandRanking.RoyalFlush],
      cards,
      kickers: [],
    };
  }

  if (isStraightFlush(cards)) {
    return {
      ranking: HandRanking.StraightFlush,
      rankingName: HAND_RANKING_NAMES[HandRanking.StraightFlush],
      cards,
      kickers: [],
    };
  }

  const fourOfAKind = isFourOfAKind(cards);
  if (fourOfAKind) {
    return {
      ranking: HandRanking.FourOfAKind,
      rankingName: HAND_RANKING_NAMES[HandRanking.FourOfAKind],
      cards: fourOfAKind.quads,
      kickers: fourOfAKind.kicker,
    };
  }

  const fullHouse = isFullHouse(cards);
  if (fullHouse) {
    return {
      ranking: HandRanking.FullHouse,
      rankingName: HAND_RANKING_NAMES[HandRanking.FullHouse],
      cards: [...fullHouse.trips, ...fullHouse.pair],
      kickers: [],
    };
  }

  if (isFlush(cards)) {
    return {
      ranking: HandRanking.Flush,
      rankingName: HAND_RANKING_NAMES[HandRanking.Flush],
      cards,
      kickers: [],
    };
  }

  if (isStraight(cards)) {
    return {
      ranking: HandRanking.Straight,
      rankingName: HAND_RANKING_NAMES[HandRanking.Straight],
      cards,
      kickers: [],
    };
  }

  const threeOfAKind = isThreeOfAKind(cards);
  if (threeOfAKind) {
    return {
      ranking: HandRanking.ThreeOfAKind,
      rankingName: HAND_RANKING_NAMES[HandRanking.ThreeOfAKind],
      cards: threeOfAKind.trips,
      kickers: threeOfAKind.kickers,
    };
  }

  const twoPair = isTwoPair(cards);
  if (twoPair) {
    return {
      ranking: HandRanking.TwoPair,
      rankingName: HAND_RANKING_NAMES[HandRanking.TwoPair],
      cards: [...twoPair.pair1, ...twoPair.pair2],
      kickers: twoPair.kicker,
    };
  }

  const onePair = isOnePair(cards);
  if (onePair) {
    return {
      ranking: HandRanking.OnePair,
      rankingName: HAND_RANKING_NAMES[HandRanking.OnePair],
      cards: onePair.pair,
      kickers: onePair.kickers,
    };
  }

  return {
    ranking: HandRanking.HighCard,
    rankingName: HAND_RANKING_NAMES[HandRanking.HighCard],
    cards,
    kickers: [],
  };
}

// Helper functions for checking hand types
function isRoyalFlush(cards: Card[]): boolean {
  if (!isFlush(cards) || !isStraight(cards)) return false;

  const values = cards.map((c) => RANK_VALUES[c.rank]).sort((a, b) => b - a);
  return values[0] === 14; // Ace high
}

function isStraightFlush(cards: Card[]): boolean {
  return isFlush(cards) && isStraight(cards);
}

function isFourOfAKind(
  cards: Card[],
): { quads: Card[]; kicker: Card[] } | null {
  const grouped = groupByRank(cards);
  for (const group of Object.values(grouped)) {
    if (group.length === 4) {
      const kicker = cards.find((c) => !group.includes(c));
      return { quads: group, kicker: kicker ? [kicker] : [] };
    }
  }
  return null;
}

function isFullHouse(cards: Card[]): { trips: Card[]; pair: Card[] } | null {
  const grouped = groupByRank(cards);
  let trips: Card[] = [];
  let pair: Card[] = [];

  for (const group of Object.values(grouped)) {
    if (group.length === 3) trips = group;
    if (group.length === 2) pair = group;
  }

  return trips.length > 0 && pair.length > 0 ? { trips, pair } : null;
}

function isFlush(cards: Card[]): boolean {
  const suits = cards.map((c) => c.suit);
  return new Set(suits).size === 1;
}

function isStraight(cards: Card[]): boolean {
  const values = cards.map((c) => RANK_VALUES[c.rank]).sort((a, b) => a - b);

  // Check for regular straight
  if (values[4] - values[0] === 4 && new Set(values).size === 5) {
    return true;
  }

  // Check for Ace-low straight (A-2-3-4-5)
  if (
    values[0] === 2 &&
    values[1] === 3 &&
    values[2] === 4 &&
    values[3] === 5 &&
    values[4] === 14
  ) {
    return true;
  }

  return false;
}

function isThreeOfAKind(
  cards: Card[],
): { trips: Card[]; kickers: Card[] } | null {
  const grouped = groupByRank(cards);
  for (const group of Object.values(grouped)) {
    if (group.length === 3) {
      const kickers = cards.filter((c) => !group.includes(c));
      return { trips: group, kickers };
    }
  }
  return null;
}

function isTwoPair(
  cards: Card[],
): { pair1: Card[]; pair2: Card[]; kicker: Card[] } | null {
  const grouped = groupByRank(cards);
  const pairs: Card[][] = [];

  for (const group of Object.values(grouped)) {
    if (group.length === 2) pairs.push(group);
  }

  if (pairs.length === 2) {
    const kicker = cards.find(
      (c) => !pairs[0].includes(c) && !pairs[1].includes(c),
    );
    const kickerArray: Card[] = kicker ? [kicker] : [];
    return {
      pair1: pairs[0],
      pair2: pairs[1],
      kicker: kickerArray,
    };
  }

  return null;
}

function isOnePair(cards: Card[]): { pair: Card[]; kickers: Card[] } | null {
  const grouped = groupByRank(cards);
  for (const group of Object.values(grouped)) {
    if (group.length === 2) {
      const kickers = cards.filter((c) => !group.includes(c));
      return { pair: group, kickers };
    }
  }
  return null;
}

function groupByRank(cards: Card[]): Record<CardRank, Card[]> {
  const grouped: Record<CardRank, Card[]> = {} as Record<CardRank, Card[]>;

  for (const card of cards) {
    if (!grouped[card.rank]) {
      grouped[card.rank] = [];
    }
    grouped[card.rank].push(card);
  }

  return grouped;
}

function generateCombinations(arr: Card[], size: number): Card[][] {
  const result: Card[][] = [];

  function backtrack(start: number, current: Card[]) {
    if (current.length === size) {
      result.push([...current]);
      return;
    }

    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      backtrack(i + 1, current);
      current.pop();
    }
  }

  backtrack(0, []);
  return result;
}

/**
 * Get highest card value from cards
 */
function getHighestCard(cards: Card[]): number {
  return Math.max(...cards.map((c) => RANK_VALUES[c.rank]));
}

/**
 * Get straight high card (accounting for ace-low straight)
 */
function getStraightHighCard(cards: Card[]): number {
  const values = cards.map((c) => RANK_VALUES[c.rank]).sort((a, b) => a - b);

  // Check for Ace-low straight (2-3-4-5-A)
  if (
    values[0] === 2 &&
    values[1] === 3 &&
    values[2] === 4 &&
    values[3] === 5 &&
    values[4] === 14
  ) {
    return 5; // In ace-low straight, 5 is the high card
  }

  return values[4]; // Regular straight, ace is high
}

/**
 * Compare two hands and return winner
 * Returns: 1 if hand1 wins, -1 if hand2 wins, 0 if tie
 */
export function compareHands(hand1: Card[], hand2: Card[]): number {
  const eval1 = evaluateHand(hand1);
  const eval2 = evaluateHand(hand2);

  // Different rankings
  if (eval1.ranking > eval2.ranking) return 1;
  if (eval1.ranking < eval2.ranking) return -1;

  // Same ranking - compare by hand type with proper tiebreakers
  const ranking = eval1.ranking;

  switch (ranking) {
    case HandRanking.RoyalFlush:
      // All royal flushes are equal
      return 0;

    case HandRanking.StraightFlush:
    case HandRanking.Straight: {
      const high1 = getStraightHighCard(eval1.cards);
      const high2 = getStraightHighCard(eval2.cards);
      return high1 > high2 ? 1 : high1 < high2 ? -1 : 0;
    }

    case HandRanking.FourOfAKind: {
      // Compare the rank of the four cards
      const quad1 = RANK_VALUES[eval1.cards[0].rank];
      const quad2 = RANK_VALUES[eval2.cards[0].rank];
      if (quad1 !== quad2) return quad1 > quad2 ? 1 : -1;

      // Same quad, compare kicker
      if (eval1.kickers.length > 0 && eval2.kickers.length > 0) {
        const kick1 = RANK_VALUES[eval1.kickers[0].rank];
        const kick2 = RANK_VALUES[eval2.kickers[0].rank];
        return kick1 > kick2 ? 1 : kick1 < kick2 ? -1 : 0;
      }
      return 0;
    }

    case HandRanking.FullHouse: {
      // Compare the rank of the three of a kind
      const trips1 = RANK_VALUES[eval1.cards[0].rank];
      const trips2 = RANK_VALUES[eval2.cards[0].rank];
      if (trips1 !== trips2) return trips1 > trips2 ? 1 : -1;

      // Same trips, compare the pair
      const pair1 = RANK_VALUES[eval1.cards[3].rank];
      const pair2 = RANK_VALUES[eval2.cards[3].rank];
      return pair1 > pair2 ? 1 : pair1 < pair2 ? -1 : 0;
    }

    case HandRanking.Flush:
    case HandRanking.HighCard: {
      // Compare cards from highest to lowest
      const values1 = eval1.cards
        .map((c) => RANK_VALUES[c.rank])
        .sort((a, b) => b - a);
      const values2 = eval2.cards
        .map((c) => RANK_VALUES[c.rank])
        .sort((a, b) => b - a);

      for (let i = 0; i < 5; i++) {
        if (values1[i] !== values2[i]) {
          return values1[i] > values2[i] ? 1 : -1;
        }
      }
      return 0;
    }

    case HandRanking.ThreeOfAKind: {
      // Compare the rank of the three cards
      const trips1 = RANK_VALUES[eval1.cards[0].rank];
      const trips2 = RANK_VALUES[eval2.cards[0].rank];
      if (trips1 !== trips2) return trips1 > trips2 ? 1 : -1;

      // Same trips, compare kickers from highest to lowest
      const kick1 = eval1.kickers
        .map((c) => RANK_VALUES[c.rank])
        .sort((a, b) => b - a);
      const kick2 = eval2.kickers
        .map((c) => RANK_VALUES[c.rank])
        .sort((a, b) => b - a);

      for (let i = 0; i < kick1.length; i++) {
        if (kick1[i] !== kick2[i]) {
          return kick1[i] > kick2[i] ? 1 : -1;
        }
      }
      return 0;
    }

    case HandRanking.TwoPair: {
      // Get the two pairs
      const grouped1 = groupByRank(eval1.cards);
      const grouped2 = groupByRank(eval2.cards);

      const pairs1 = Object.values(grouped1)
        .filter((g) => g.length === 2)
        .map((g) => RANK_VALUES[g[0].rank])
        .sort((a, b) => b - a);
      const pairs2 = Object.values(grouped2)
        .filter((g) => g.length === 2)
        .map((g) => RANK_VALUES[g[0].rank])
        .sort((a, b) => b - a);

      // Compare high pair
      if (pairs1[0] !== pairs2[0]) {
        return pairs1[0] > pairs2[0] ? 1 : -1;
      }

      // Compare low pair
      if (pairs1[1] !== pairs2[1]) {
        return pairs1[1] > pairs2[1] ? 1 : -1;
      }

      // Compare kicker
      if (eval1.kickers.length > 0 && eval2.kickers.length > 0) {
        const kick1 = RANK_VALUES[eval1.kickers[0].rank];
        const kick2 = RANK_VALUES[eval2.kickers[0].rank];
        return kick1 > kick2 ? 1 : kick1 < kick2 ? -1 : 0;
      }
      return 0;
    }

    case HandRanking.OnePair: {
      // Compare the rank of the pair
      const pair1 = RANK_VALUES[eval1.cards[0].rank];
      const pair2 = RANK_VALUES[eval2.cards[0].rank];
      if (pair1 !== pair2) return pair1 > pair2 ? 1 : -1;

      // Same pair, compare kickers from highest to lowest
      const kick1 = eval1.kickers
        .map((c) => RANK_VALUES[c.rank])
        .sort((a, b) => b - a);
      const kick2 = eval2.kickers
        .map((c) => RANK_VALUES[c.rank])
        .sort((a, b) => b - a);

      for (let i = 0; i < kick1.length; i++) {
        if (kick1[i] !== kick2[i]) {
          return kick1[i] > kick2[i] ? 1 : -1;
        }
      }
      return 0;
    }

    default:
      return 0;
  }
}
