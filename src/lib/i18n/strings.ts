/** Minimal English copy for the Chicken Rescue template example. */
export const EN_STRINGS: Record<string, string> = {
  error: "Error",
  "error.wentWrong": "Something went wrong. Please try again.",
  retry: "Retry",
  "session.expired": "Session expired!",
  close: "Close",
  loading: "Loading…",
  continue: "Continue",
  exit: "Exit",
  "last.updated": "Last updated:",
  "base.far.away": "You are too far away",
  "base.iam.far.away": "I am too far away",
  "minigame.chickenRescue": "Minigame - Chicken Rescue",
  "minigame.chickenRescueBumpkinDialogue":
    "If you want to play in my fields.\nYou must pay me coins.\nIt costs one coin to enter and catch my chooks.",
  "minigame.chickenRescue.collectChooksTitle": "Collect chooks",
  "minigame.chickenRescue.welcomeBody":
    "Pssst, are you looking for chooks? Use your worms and chicken feet to attract and catch them. Shops and wormeries are in Sunflower Land.",
  "minigame.chickenRescue.freeWormsTitle": "Daily free worms",
  "minigame.chickenRescue.freeWormsBodyInstant":
    "Grab your daily gift — we’ll add 3 worms to your balance and sync with the server.",
  "minigame.chickenRescue.freeWormsBodyTimed":
    "This starts your daily worm drop. After about {{hours}} hours, collect 3 worms from your Wormery (production).",
  "minigame.chickenRescue.freeWormsClaim": "Claim 3 worms",
  "minigame.chickenRescue.freeWormsSkip": "Continue without claiming",
  "minigame.chickenRescue.gameOver": "Game over",
  "minigame.chickenRescue.resultsFoundChooks":
    "Congratulations, you found some chooks.",
  "minigame.chickenRescue.resultsNoChooks":
    "Bad luck, you didn't catch any chooks.",
  "minigame.chickenRescue.foundChooksLine": "You found {{count}} chooks.",
  "minigame.chickenRescue.foundGoldenChooksLine":
    "You found {{count}} golden chooks.",
  "minigame.swipeToMove": "Swipe to move around",
  "minigame.arrowKeysToMove": "Use WASD or arrow keys to move around",
  "minigame.noCoinsRemaining": "No worms remaining",
  "minigame.coinsRemaining": "worms left",
  "minigame.shopBack": "Back",
  "minigame.shopConfirm": "Confirm",

  buy: "Buy",
  ok: "OK",
  start: "Start",
  collect: "Collect",
  balance: "Balance",
  inventory: "Inventory",
  requires: "Requires",
  "welcome.label": "Welcome",
  "detail.basket.empty": "Your basket is empty.",
  dismiss: "Dismiss",
  "statements.tapCont": "Tap to continue",

  "minigame.uiResources.emptyActions":
    "This session has no economy actions yet. Add rules in the minigame editor or use the offline stub in UiResourcesApp.",

  "minigame.dashboard.shop": "Shop",
  "minigame.dashboard.priceLabel": "Price",
  "minigame.dashboard.shopAlreadyPurchased": "Already purchased the maximum for this item.",
  "minigame.dashboard.actionFailed": "Action failed. Please try again.",
  "minigame.dashboard.welcomeFallback":
    "Use the shop and generators shown here. Your progress syncs through the Minigames API when configured.",

  "minigame.dashboard.production.collectResolving": "Resolving collect…",
  "minigame.dashboard.production.collectYouWon": "You received:",
  "minigame.dashboard.production.collectDone": "Done",
  "minigame.dashboard.production.openRecipesAria": "Open recipes",
  "minigame.dashboard.production.collectFromBuildingAria": "Collect from building",
  "minigame.dashboard.production.startRun": "Start a run at {{building}}.",
  "minigame.dashboard.production.duration": "Duration:",
  "minigame.dashboard.production.dropOddsTitle": "Possible drops",
  "minigame.dashboard.production.dropOddsLine":
    "{{percent}} chance: +{{amount}} {{name}}",
  "minigame.dashboard.production.producesWhenComplete": "When complete you get:",
  "minigame.dashboard.production.uses": "Uses",
  "minigame.dashboard.production.noExtraResources": "No extra resources required.",
  "minigame.dashboard.production.producing":
    "Producing {{output}} at {{building}}.",
  "minigame.dashboard.production.readyCollect": "{{building}} is ready to collect.",
  "minigame.dashboard.production.readyIn": "Ready in {{time}}.",
  "minigame.dashboard.production.noActive": "No active job at {{building}}.",
  "minigame.dashboard.production.collectYour": "You will collect:",
  "minigame.dashboard.production.nothingToCollect": "Nothing to collect.",
  "minigame.dashboard.production.whatToProduce": "What do you want to produce?",
  "minigame.dashboard.production.mysteryDropTitle": "Mystery drop",
  "minigame.dashboard.production.tapToCollect": "Tap to collect",
};

function interpolate(
  template: string,
  args?: Record<string, string | number>,
): string {
  if (!args) return template;
  let out = template;
  for (const [k, v] of Object.entries(args)) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
}

export function formatString(
  key: string,
  args?: Record<string, string | number>,
): string {
  const raw = EN_STRINGS[key] ?? key;
  return interpolate(raw, args);
}
