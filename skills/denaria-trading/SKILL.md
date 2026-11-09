---
name: denaria-trading
description: Trade GMX perpetuals on Denaria for the user. Use when the user asks to open, close or manage a Denaria position (BTC or ETH long or short, leverage, collateral, margin, take profit, stop loss, limit orders, funding fees), mentions Denaria or denaria.finance, or wants their agent to trade on Denaria. With the Denaria Agent Signer the agent executes within the limits the user approved with their Passkey; without it, it prepares a QR the user signs in the Denaria app.
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
claude mcp add denaria-agent-signer -- npx -y @denaria/agent-signer@<version> --env mainnet
codex mcp add denaria-agent-signer -- npx -y @denaria/agent-signer@<version> --env mainnet
```

Run it only after the user agrees. `--env testnet` is the test network (test funds), and
`--env mainnet` is real funds; never switch one for the other. On a server, a container or a
cloud sandbox (no system keyring), add `--store file` and an environment variable
`DENARIA_SIGNER_PASSPHRASE` (12+ characters) to the server entry, and tell the user to keep
that passphrase. The agent may need a restart to see the new tools.

Then call `connect`. It answers with a link, a QR code and a short fingerprint: show all
three. The user opens the link on their phone, checks that the fingerprint is the same,
chooses the limits and confirms with their Passkey. Call `connect` again: once the Grant is
live it restates it ("Connected. I can trade BTC and ETH, up to $50 per order, max 3x, until
11 Nov"). Tell the user those limits in your own words.

If the user's app has no **Connect an agent**, or Denaria answers that agent trading is not
open for this account or network, the Signer cannot trade there yet: prepare QR handoffs
instead.

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
  take profit or stop loss of a position you did not open without asking the user first. If
  the user wants agent trading kept apart, suggest a dedicated Denaria account for it.
- **Report every operation.** Each execution tool answers with a summary and a `dop_…`
  reference. Tell the user the summary, then follow the reference with
  `denaria_get_operation_status` until it is `executed`, `cancelled` or `failed`, and say what
  happened. A market order is not a position until it is executed; a limit, take profit or
  stop loss waits for its price.
- **Refusals are information.** Read the message and the next step it gives, and tell the
  user. Never split or reshape an order to get past a limit. Outside the Grant: the user
  renews it with new limits in the app. Not enough USDC: the user moves funds. An operation
  in flight: wait for it. Agent trading paused or close-only: the user chose it in the app;
  only closing is allowed, or nothing.
- **Expiry.** Every answer carries the Grant's expiry. Warn the user a day before. After it,
  open positions keep their GMX take profit and stop loss, and you cannot touch them until the
  user renews (one tap on the phone, same key).
- **What you can never do.** Withdraw, send funds, or touch the account's security: the
  Grant does not allow it. The user can revoke you at any time in **Settings → Access &
  security → Agents**.

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
