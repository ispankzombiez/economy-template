# Nightshade Arcade — reward worker

A tiny Cloudflare Worker that holds the list of rewards the arcade owner owes
players, and answers one question: **is this request actually for the person
asking?**

It never touches token balances. It cannot give anyone anything. Tokens only
move when a player presses a button you published in the Economy Editor and the
Sunflower Land server accepts it. This worker just decides which button they are
allowed to press.

---

## Setup (click-by-click)

### 1. Install the Cloudflare CLI

Open a terminal in this folder (`worker/`) and run:

```bash
npm install
npx wrangler login
```

`wrangler login` opens a browser and asks you to authorise. You already have a
Cloudflare account, so this just links them together.

### 2. Create the storage

```bash
npx wrangler kv namespace create REWARDS
```

It prints something like:

```
[[kv_namespaces]]
binding = "REWARDS"
id = "a1b2c3d4e5f6..."
```

Copy that `id`.

### 3. Paste it in

Open `wrangler.toml` and replace `PASTE_YOUR_KV_NAMESPACE_ID_HERE` with the id
you just copied. Save.

### 4. Deploy

```bash
npx wrangler deploy
```

It prints a URL like `https://nightshade-rewards.<you>.workers.dev`. **That is
the address the game will call.**

### 5. Prove it is alive

```bash
curl https://nightshade-rewards.<you>.workers.dev/whoami
```

You should get:

```json
{ "error": "Missing session token. Open the arcade from Sunflower Land." }
```

That is the correct answer. It means the worker is live and is refusing to
identify anyone who has not come from the game. The real test is from inside the
arcade, once the game side is wired up.

---

## The routes

Every route needs the player's own portal JWT:

```
Authorization: Bearer <the ?jwt= value from the arcade URL>
```

| Route | Who | What it does |
| --- | --- | --- |
| `GET /whoami` | anyone | Returns the caller's farm id, username, and whether they are the dev |
| `POST /requests` | **dev only** | Queue a reward for a farm number |
| `GET /requests` | **dev only** | List everything, for the dev menu |
| `GET /requests/mine` | anyone | The caller's own rewards, newest first |
| `POST /requests/claim` | anyone | Tick a request off, but only the caller's own |
| `DELETE /requests/:id` | **dev only** | Cancel a queued request |

### Two examples

The `Origin` header is required — the worker only answers browsers coming from
the arcade, so a bare `curl` without it gets a 403.

Queue a reward (dev only):

```bash
curl -X POST https://nightshade-rewards.<you>.workers.dev/requests \
  -H "origin: https://nightshade-arcade.economies.sunflower-land.com" \
  -H "authorization: Bearer $JWT" \
  -H "content-type: application/json" \
  -d '{"farmId": 1128976301583508, "actionId": "Payout-25", "note": "for the stream"}'
```

What a player sees:

```bash
curl https://nightshade-rewards.<you>.workers.dev/requests/mine \
  -H "origin: https://nightshade-arcade.economies.sunflower-land.com" \
  -H "authorization: Bearer $JWT"
```

---

## Why there are no secrets

The player sends their game login token. The worker then asks Sunflower Land two
questions with that token:

1. `GET {main}/portal/Nightshade-Arcade/player` — *which farm is this?*
2. `GET {economies}/data?type=session` — *does this player hold the Dev Key?*

Both answers come from Sunflower Land and are keyed on a token the player cannot
forge. The browser is never asked who it is.

So there is no API key to store, no password to rotate, and nothing worth
stealing. That is also why this works without any repository or CI setup.

### The one trap this closes

It is tempting to let the client say "here is the API host to use". Don't. Anyone
could point this worker at a server they control, get told they are any farm they
like, and claim rewards meant for other people.

The host comes from the worker's own `API_ENV` setting and nowhere else. A
request cannot influence it. If you ever add a "which environment" parameter,
you have reintroduced the hole.

---

## What you still have to do in the Economy Editor

The worker only hands out permission to press a button. Those buttons are yours
to publish.

Publish one per reward size, named `Payout-<amount>`. Each one mints the reward
**and** a marker token of its own:

```
Payout-1
  requireAbsent  [ Payout-Marker-1 ]
  mint           { Raven Coin: 1,  Payout-Marker-1: 1 }

Payout-5
  requireAbsent  [ Payout-Marker-2 ]
  mint           { Raven Coin: 5,  Payout-Marker-2: 1 }

Payout-25
  requireAbsent  [ Payout-Marker-3 ]
  mint           { Raven Coin: 25, Payout-Marker-3: 1 }
```

#### Why the marker has to be minted too

This is the part that is easy to get wrong, and getting it wrong turns a reward
into an infinite faucet.

`requireAbsent: ["Payout-Marker-1"]` means only *"you may run this if you hold
zero Payout-Marker-1"*. On its own that is **not** a one-time gate. Nothing ever
sets the marker, so it sits at 0 permanently and the button can be pressed
forever.

Minting the marker in the same action is what closes it:

```
First press   marker is 0   -> requireAbsent passes -> 25 coins + marker = 1
Second press  marker is 1   -> requireAbsent fails   -> refused
```

So the marker is a receipt, not a ticket. Each button needs its own, and no
other action may mint them.

Rules the worker enforces on the name:

- Must start with `Payout-`
- Must be a published action, or `POST /requests` refuses it
- Length and characters are restricted

The `Payout-` prefix is a fence, not decoration. `Dev-Mint-Play-Ticket` is an
uncapped ranged mint — a request pointing at it would be a payout with no
ceiling. The worker refuses to queue anything that is not a `Payout-`.

### `POST /requests` also warns you

The response comes back with a `warnings` array. Nothing is refused, but you get
told at the moment you queue the reward:

- **no `requireAbsent`** — not one-use, anyone can claim it repeatedly
- **`requireAbsent` names a token this action never mints** — the dangerous one.
  The marker never gets set, so the gate never trips and it is an infinite mint
- **`showInShop` is not `false`** — the button is visible in the dashboard

### ⚠️ Test `requireAbsent` before you rely on it

You have never verified that `requireAbsent` is enforced by the live server. You
have only used `require` ("must already own X"), which is a different setting and
is known to work.

If `requireAbsent` turns out to be ignored, these buttons become open mints. Do
this before publishing any real denominations:

1. Publish a throwaway `Payout-Test` with `requireAbsent: ["Payout-Test-Marker"]`
   **and** `mint: { "Payout-Test-Marker": 1 }` — mint the marker too, or the test
   proves nothing
2. Claim it once with your own account — it should succeed
3. Claim it a second time — it should be **refused**

If step 3 succeeds, stop and redesign the buttons before queueing anything real.
The worker is fine either way; it is the buttons that would need rethinking.

Delete the `Payout-Test` button and its marker item afterwards.

---

## Not yet built

This is the worker half only. The game still needs:

- a request form in the dev mint panel (`NightshadeArcadeDevMint`)
- a "My Rewards" screen for players
- the `Payout-*` buttons themselves

Until those exist the worker has nothing to talk to.

---

## Naming heads-up

The reward token is **Nightshade Arcade Beta Key**.

Worth keeping the two "key" items straight in the editor, because they do
completely different jobs:

| Item | Job |
| --- | --- |
| **Dev Key** | Gates the developer's own tools. Holding it is what lets someone queue a reward. Never awarded to players. |
| **Nightshade Arcade Beta Key** | The thing you hand out as a reward. |

They are separate items in a separate store, and the worker never confuses them —
it matches the Dev Key by the exact name `dev key` and nothing containing
"Nightshade Arcade" can match it. Just be careful when you are picking items in
the dropdown.
