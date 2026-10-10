# Setting up the write worker

The economy has **Require secret API key** turned on, so the browser can no longer
write to it — every write is refused with `401 MISSING_PRIVATE_KEY`. This worker is
now the only writer, which means **the arcade is non-functional until you finish
step 3.** Nothing here is optional.

You need your Cloudflare account for all of it. `wrangler` will prompt you to log
in the first time.

---

## 1. Install and authenticate

```bash
cd worker
npm install
npx wrangler login
```

`wrangler login` opens a browser to authorise. This links your machine to the
Cloudflare account that owns the worker.

---

## 2. Create the ledger database

The reward queue and chest tally live in KV, which is fine because a stale read
there only costs a leaderboard row. The **ledger is different** — it gates money,
so it needs atomicity. D1 is SQLite, which gives you a primary key that *is* the
lock:

```bash
npx wrangler d1 create nightshade-economy
```

It prints:

```
[[d1_databases]]
binding = "LEDGER"
database_name = "nightshade-economy"
database_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

**Copy the `database_id` into `wrangler.toml`**, replacing
`PASTE_YOUR_D1_DATABASE_ID_HERE`. The binding name must stay `LEDGER` — the code
refers to `env.LEDGER`.

### Apply the schema

```bash
npx wrangler d1 migrations apply LEDGER --local     # safe, no live data
npx wrangler d1 migrations apply LEDGER --remote    # the real one
```

Both are safe to re-run. The migration is `CREATE TABLE IF NOT EXISTS`, so it will
not wipe anything if applied twice.

---

## 3. Add the private key

```bash
npx wrangler secret put ECONOMY_PRIVATE_KEY
```

Paste the key when prompted. **Do not put it in `wrangler.toml`** — a secret in a
committed file is a leaked secret. Cloudflare stores it encrypted and it cannot be
read back out of the config.

For local development instead, put it in `worker/.dev.vars` (already gitignored,
already created):

```
ECONOMY_PRIVATE_KEY=sk_economy_...
```

---

## 4. Deploy

```bash
npx wrangler deploy
```

Prints the URL. It should match `VITE_REWARDS_WORKER_URL` in your `.env`.

**Add the arcade's origin if you use a custom domain** — it is allow-listed, not
open:

```toml
# wrangler.toml
ALLOWED_ORIGINS = "https://your-arcade.example.com"
```

---

## 5. Check it is alive

```bash
curl https://<worker>/whoami
```

Expect:

```json
{ "error": "Missing session token. Open the arcade from Sunflower Land." }
```

**That is the correct answer.** It means the worker is live and refusing to
identify anyone who did not come from the game. A 403 `Origin not allowed` means
your origin is not on the list — add it to `ALLOWED_ORIGINS`.

---

## 6. Prove the lock is real

This is the test that matters, and it does not need the game.

**A raw write should be refused.** With any player's JWT:

```bash
curl -X POST https://economies-api.sunflower-land.com/action \
  -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"type":"minigame.action","action":"Mint-Raven-Coin-Poker"}'
```

Expect `401` and `errorCode: MISSING_PRIVATE_KEY`. If that ever succeeds, the
toggle is off and nothing below is enforcing anything.

**Your worker should succeed on the same action** — as an intent, not as a raw
action id:

```bash
curl -X POST https://<worker>/economy/write \
  -H "origin: https://nightshade-arcade.economies.sunflower-land.com" \
  -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"intent":"claim-result","nonce":"test-nonce-0001"}'
```

A `claim-result` with no Reward Attempt in hand is refused by the economy's own
rule (`400`) — which is the *right* answer and proves the chain works end to end:
worker → key → economy → refusal.

### And the two attacks

**Name an action directly.** The worker should refuse; it accepts intents, not
action ids:

```bash
-d '{"intent":"mint-raven-coin","actionId":"Mint-Raven-Coin-Poker","nonce":"test-nonce-0002"}'
# -> 400 "Unknown intent. This worker only runs a fixed list."
```

**Claim a per-cabinet free run as a non-VIP.** Should be `403`:

```bash
-d '{"intent":"grant-free-run","actionId":"Grant-Free-Run-Poker","nonce":"test-nonce-0003"}'
# -> 403 "A free run on an individual machine is a VIP perk..."
```

---

## 7. In-game

1. Open a cabinet → free run granted → play → win → coin credited.
2. Replay the same cabinet → "already used today's free run".
3. Buy a Play Ticket → spend it → ticket run → win → coin.
4. Lose a run → the voucher is burned, no coin.
5. Chest → a ticket, once a day.

---

## If something is wrong

| Symptom | Cause |
| --- | --- |
| `503 ... economy private key is not set` | `wrangler secret put` was not run, or the name is misspelled |
| `503 ... Sunflower Land rejected the economy key` | Wrong key, or it was rotated without updating the worker |
| `503 ... Cannot perform I/O on closed` from D1 | `database_id` is still the placeholder — create the database |
| `403 Origin not allowed` | Add your origin to `ALLOWED_ORIGINS` and redeploy |
| Every action 401s in game | Worker not deployed, or `VITE_REWARDS_WORKER_URL` is wrong |
| `400 Missing request id` | A client call went out without a nonce |

**Watch the logs while you test:**

```bash
npx wrangler tail
```

---

## Rotating the key

From the economy editor, **Basics → Rotate key**. The old key stops working
*immediately*, so update the worker straight away:

```bash
npx wrangler secret put ECONOMY_PRIVATE_KEY
```

Between those two steps, writes fail closed with the 503 above. That is the
correct behaviour — a leaked key should not be able to mint while you fix it.