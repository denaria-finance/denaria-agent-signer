---
name: denaria-trading
description: Trade GMX perpetuals on Denaria for the user. Use when the user asks to open, close or manage a Denaria position (BTC or ETH long or short, leverage, collateral, margin, take profit, stop loss, limit orders, funding fees), mentions Denaria or denaria.finance, or wants their agent to trade on Denaria, one strategy or several. With the Denaria Agent Signer the agent executes within the limits the user approved with their Passkey; without it, it prepares a QR the user signs in the Denaria app.
---

# Trading on Denaria

Denaria is a non-custodial trading app on GMX (Arbitrum). The user's account is a smart
account secured by a Passkey on their phone. An agent trades on it in one of two ways:

1. **With the Denaria Agent Signer** (a local MCP server): the agent executes, within a
   **Grant** the user approved with their Passkey (markets, largest order, leverage, pace,
   expiry). The Signer keeps the agent's key on this computer.
2. **Without it**: the agent prepares the trade through Denaria's remote MCP and the user
   signs it in the Denaria app by scanning a QR.

## Which way

- **Signer tools present** (`connect`, `denaria_create_position`, `denaria_get_grant`…;
  on the test network they are named `denaria_testnet_…`): execute through them.
- **Only the remote MCP** (`denaria_prepare_create_position`, `denaria_quote_trade`…): prepare
  QR handoffs. If the user wants their agent to trade on its own, offer to set up the Signer.
- **Neither**: offer to add the remote MCP, `https://mcp.denaria.finance/mcp`, or to set up the
  Signer. Never ask for a private key, a seed phrase or a Passkey: Denaria never needs one.

### Setting up the Signer

Use the command the user's Denaria app shows under **Settings → Access & security → Agents →
Connect an agent**: it pins the Signer's version. It has this shape:

```bash
claude mcp add --scope user denaria-agent-signer -- npx -y @denaria/agent-signer@<version> --env mainnet
codex mcp add denaria-agent-signer -- npx -y @denaria/agent-signer@<version> --env mainnet
```

Run it only after the user agrees. `--env testnet` is the test network (test funds), and
`--env mainnet` is real funds; never switch one for the other. On a server, a container or a
cloud sandbox (no system keyring), add `--store file` and an environment variable
`DENARIA_SIGNER_PASSPHRASE` (12+ characters) to the server entry, and tell the user to keep
that passphrase. One install serves every agent of this client on this computer: a new
strategy is one more agent made with `connect` (below), never a second install. The agent may
need a restart to see the new tools.

If the install fails, or the Signer's tools do not appear or do not answer, do not guess: send
the user to the guide in their Denaria app, Settings → Access & security → Connect an agent, on
their client's tab (`https://denaria.app/portfolio?settings=connect-agent&client=claude-code`,
`&client=codex` or `&client=other`, once they are logged in; on the test network the app's
address is the one the Connect an agent screen shows).

Then call `connect`. The first time, it answers `choose_agent`: every agent on this computer
has its own key, so **ask the user** the name of this agent in Denaria, proposing the one
`connect` gives (`proposedName`, the client's own: "Claude Code", "Codex"), or which key
already listed to reuse (name, fingerprint, Grant state). Call `connect` again with
`{"name": "…"}` or `{"reuse": "<key id>"}`. Reusing a key shares that agent's Grant once the
user approves it in the Denaria app with their Passkey: `connect` gives the link, and until
then this agent reads and trades nothing ("the approval is pending"). Never choose for the user. The name is the user's: they
rename an agent in the app, never through you. Then `connect` answers with
a link, a QR code and a short connection code, new with every link: always give the link and
the connection code. The QR
comes as an image and as text: if your client shows tool images to the user, say the QR code
is above; in a terminal, show the text QR in a code block, unchanged; otherwise, or when the
user cannot see it, call `connect` again with `{"qr": "window"}`, which opens it on this
computer. The user opens the link on their phone, checks that the connection code is the same,
chooses the limits and confirms with their Passkey. Call `connect` again: once the Grant is
live it restates it ("Connected. I can trade BTC and ETH, up to $50 per operation, max 3x,
until 11 Nov"). The size is per operation: all the orders of one operation together. Tell the
user those limits in your own words.

If the user's app has no **Connect an agent**, or Denaria answers that agent trading is not
open for this account or network, the Signer cannot trade there yet: prepare QR handoffs
instead.

### Several strategies

A user who tests several trading strategies gives each one its own Denaria agent on its own
**Account**: its own key, Grant, limits, capital, positions and results, so they can see which
one makes money. ("Strategy" is the user's word; for Denaria it is an agent on an Account.)

- **A new strategy.** When the user starts one ("make a folder in my finance area, we start
  trading with part of my gamble money"), write its notes and propose a dedicated agent and a
  new Account: "I'll give it its own agent and account. Shall I call it Gamble?". Then call
  `connect` with `{"name": "Gamble"}`: one more key next to this client's other agents, with no
  change to the MCP configuration. Give the link, the QR and the connection code as usual, and
  tell the user to choose **New account** on the phone (titled after the agent, it may be
  already selected) and, if they want, an initial capital. If a live agent of this client
  already has that name, `connect` makes nothing and answers about that agent: for a new
  strategy, ask the user for another name.
- **The notes.** Write the Agent name and the key id (`keyId` in the answer of `connect`) in
  the strategy's notes. The key id is the stable reference: the user may rename the agent in
  the app.
- **Picking a strategy up.** When the user names a strategy in a later session ("let's pick up
  the gamble strategy"), read its notes and pass `agent`, preferably the key id, on every call.
  Once this client has two or more agents, every Denaria tool needs `agent`, reads included;
  `denaria_list_agents` lists them (Agent name, key id, fingerprint, Account, Grant state and
  expiry). Every answer says which agent and which Account it is about: check it is the
  strategy's.
- **Refused with the list.** A call with no `agent`, an unknown one, or a name two agents
  share is refused before anything is sent, with the list of agents. Ask the user which one;
  never pick one.
- **Another client.** A second client on the same computer (a Codex thread on the same
  project, say) uses an existing strategy with `connect` `{"reuse": "<key id>"}`, the key id
  from the notes: the same key, Grant and Account, once the user approves it in the Denaria app
  with their Passkey. Until then that agent reads and trades nothing; the client's other
  agents go on.
- **Strict isolation.** A Signer started with `--name` acts for that one agent only and refuses
  any other. The user sets it up by hand, as the Signer's README explains; suggest it only when
  they ask for strict isolation (unattended runs, large Grants).

## Trading with the Signer

- **Know the Grant first.** Before the first trade of a conversation, read the Grant
  (`denaria_get_grant`), the balances and the positions. Explain the limits to the user in
  plain words: which markets, the largest order, the leverage, how many operations per
  window, when it expires.
- **Start small.** Make the first trade well below the Grant's largest order, unless the user
  asks for a size.
- **Confirm intent.** Restate market, side, collateral and leverage before an order, unless the
  user has explicitly delegated a strategy to you and its rules cover the order.
- **Positions you did not open.** In the Grant's markets GMX merges the user's own position
  with yours, and you can manage every position there. Do not close, resize or change the
  take profit or stop loss of a position you did not open without asking the user first, and
  do not cancel an order you did not place. If the user wants agent trading kept apart,
  suggest markets where they hold no positions of their own.
- **Report every operation.** Each execution tool answers with a summary and a `dop_…`
  reference. Tell the user the summary, then follow the reference with
  `denaria_get_operation_status` until it is `executed`, `cancelled` or `failed`, and say what
  happened. A market order is not a position until it is executed; a limit, take profit or
  stop loss waits for its price.
- **Limit and stop orders.** `denaria_place_limit_order` opens or adds to a position only
  when the price reaches a trigger: `limit` for a better entry than now (a long below the
  price, a short above it), `stop` to follow a breakout (a long above the price, a short
  below it). Use a market order (`denaria_create_position`) to trade now. It needs the
  Grant setting **Pending limit and stop orders**: without it the tool refuses before
  anything is signed, and the user turns it on by renewing you in the app (Renew). Before
  placing one, tell the user that it waits for its price and may execute after this
  conversation, after the Grant expires, or after a revoke unless the revoke cancels it (a
  revoke in the app cancels your pending limit and stop orders that Denaria finds; tell the
  user to check Orders afterwards). To move one, send its `orderKey` as `replacesOrderKey`:
  it is cancelled and the new one placed in one operation, within the same limits. To remove one, `denaria_cancel_order`. Its operation
  stays `submitted` ("waiting for its price") until GMX executes it (`executed`) or it is
  cancelled (`cancelled`); `denaria_get_open_orders` lists it with its trigger.
- **Refusals are information.** Read the message and the next step it gives, and tell the
  user. Never split or reshape an order to get past a limit. Outside the Grant: the user
  renews it with new limits in the app. Not enough USDC: the user moves funds. An operation
  in flight: wait for it. Agent trading paused or close-only: the user chose it in the app;
  only closing is allowed, or nothing.
- **Expiry.** Every answer carries the Grant's expiry. Warn the user a day before. After it,
  open positions keep their GMX take profit and stop loss, and you cannot touch them until the
  user renews (one tap on the phone, same key). Your pending limit and stop orders also stay on
  GMX after the expiry and can still open or grow a position: say so, and that the renewal
  screen offers to cancel them.
- **What you can never do.** Withdraw, send funds, or touch the account's security: the
  Grant does not allow it. The user can revoke you at any time in **Settings → Access &
  security → Agents**. A revoke ends your key once it lands on-chain and, in the same
  confirmation, cancels the pending limit and stop orders of yours that Denaria finds; tell the
  user to check Orders afterwards. The take profit and stop loss you placed stay on the
  positions unless the user chooses to cancel them too.

## Trading through the QR (no Signer)

Call `denaria_prepare_create_position` with the market, side, USDC collateral and leverage
(for example `{ "assetTicker": "BTC", "side": "long", "collateralUsd": "50", "leverage": 3 }`).
Show the QR image it returns (the image block, or `qrMarkdown`); if the client cannot show
it, give `qrPageUrl` and the link. The user scans it with the Denaria app, reviews and signs
with their Passkey. Nothing is executed until they do: never say a position was opened.
Follow it with `denaria_get_operation_status`.

Before preparing, `denaria_quote_trade` and `denaria_simulate_trade` give the figures the
app's order sheet shows (price, liquidation price, fees) and whether the app would block it.

## Always

- **Networks.** Every Denaria answer states its network. On the test network it starts with
  `TEST FUNDS`: say so to the user. Never move between networks on your own.
- Answer in the user's language, briefly. Do not print raw JSON unless asked.
- Never claim a trade happened before Denaria says it did.
