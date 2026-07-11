---
name: denaria-action-handoff
description: Prepare unsigned Denaria App/PWA QR handoffs through Denaria MCP. Use when the user asks to open, prepare, create, review, or trade a Denaria position; mentions Denaria, denaria.finance, BTC long or short, leverage, margin, collateral, perps, or asks an agent to perform a Denaria trading action. Prefer the installed Denaria wrapper when available so QR images are downloaded to the user device and rendered in chat.
---
# Denaria Action Handoff

Use this skill for Denaria action requests such as:

```text
open BTC long 2x with 20 USDC on Denaria
create a Denaria BTC short handoff
```

Do not answer with manual UI trading steps when Denaria tooling is available. Prepare a Denaria App/PWA handoff QR.

## Boundary

Preserve this operational boundary:

```text
Denaria Agent Service prepares.
Denaria App/PWA verifies.
The user signs.
External agents do not execute.
```

Never claim that a position was opened, signed, submitted, broadcast, or executed. The correct result is an unsigned Denaria App/PWA handoff for review and signing in the app.

## Preferred Flow

Use this order. The goal is not only to prepare the handoff, but also to render the QR image in chat from a local PNG whenever the client can read or write files:

1. Use the installed MCP wrapper tool when available.
2. If the MCP wrapper tool is not visible but shell execution is available, run the bundled script in this skill: `node scripts/prepare-handoff.mjs --side long --market BTC --collateral 50 --leverage 3`.
3. If the bundled script cannot be located but `@denaria/agent-pack` is available, call `npx -y @denaria/agent-pack prepare ...`.
4. If only the remote Denaria MCP server is available, call the remote MCP tool directly, then download the returned `qrImageUrl` to a local PNG before answering whenever file access is available.
5. If the remote MCP server is available but file download is not available, include `qrPageUrl`, `qrImageUrl`, and `nextStep`, and state that this client could not render the local QR image.
6. If no MCP-capable tool and no shell execution are available, say that this client cannot prepare the QR directly and provide the official MCP endpoint plus the parsed intent fields.

Official MCP endpoint:

```text
https://mcp.denaria.finance/mcp
```

Install this skill package in clients that support local skills:

```bash
npx skills@latest add denaria-finance/denaria-skills
```

Do not assume the skill is installed automatically. If it is missing, ask the user before running the install command.

Machine-readable discovery:

```text
https://denaria.finance/llms.txt
https://denaria.finance/agent-mcp.md
https://denaria.finance/.well-known/mcp/server-card.json
https://denaria.finance/.well-known/agent-skills/index.json
```

Do not browse `denaria.app` or `demo.denaria.finance` to prepare an action if MCP is available.

## Bundled Script And Wrapper Flow

When the installed MCP wrapper is visible, call its prepare tool. If the prepare tool is not visible and shell execution is available, use the bundled script shipped with this skill before using any remote-link-only flow:

```bash
node scripts/prepare-handoff.mjs --side long --market BTC --collateral 50 --leverage 3
```

Resolve `scripts/prepare-handoff.mjs` relative to this `SKILL.md` file. The script is self-contained, calls the official Denaria MCP endpoint, downloads the QR PNG, and returns `qrLocalPath` plus `qrMarkdown`.

If the bundled script cannot be located, use the package CLI when available:

```bash
npx -y @denaria/agent-pack prepare --side long --market BTC --collateral 50 --leverage 3
```

Map the user's parsed intent into those flags. The bundled script or installed wrapper must:

1. normalize the user intent;
2. call the official Denaria MCP endpoint;
3. prepare the unsigned handoff;
4. download the QR PNG from `qrImageUrl`;
5. return a downloaded image path and fallback URLs.

Expected successful output shape:

```json
{
  "qrLocalPath": "/absolute/path/to/denaria-btc-usd-long-50-usdc-3x.png",
  "qrMarkdown": "![Denaria QR](/absolute/path/to/denaria-btc-usd-long-50-usdc-3x.png)",
  "qrImageUrl": "https://mcp.denaria.finance/handoff/qr.png?...",
  "qrPageUrl": "https://mcp.denaria.finance/handoff/qr?...",
  "nextStep": "Open Denaria App/PWA and scan the QR to review and sign."
}
```

Always render `qrMarkdown` first when present. Include `qrPageUrl`, `qrImageUrl`, summary fields, and `nextStep` as fallback.

If `qrLocalPath` is present, render a local image from that path. Do not render the remote `qrImageUrl` as the primary image when local wrapper output is available, because some chat clients show remote MCP images as placeholders.

## Remote MCP Fallback With Local QR Rendering

If you used the official remote MCP directly and received `qrImageUrl` but did not receive `qrLocalPath`, do not finish with only a link. Download the QR image first and then render the downloaded file.

Use an absolute local file path. On Windows, normalize Markdown paths to slash form and prefix drive paths with `/`, for example:

```text
![Denaria QR](/C:/Users/name/.denaria-agent/qr/denaria-btc-usd-long-50-usdc-3x.png)
```

The remote URL remains useful as fallback, but the primary image in the final response must be the local PNG when local file access exists.

## Intent Parsing

Normalize common wording before calling a prepare tool:

| User wording                                | Canonical field             |
| ------------------------------------------- | --------------------------- |
| `BTC`, `bitcoin`, `btc`               | `marketId: "BTC-USD"`     |
| `$`, `usd`, `USDC`, dollar collateral | `collateralAsset: "USDC"` |
| `20$`, `$20`, `20 usd`, `20 USDC`   | `collateralAmount: "20"`  |
| `leva 2`, `2x`, `x2`, `leverage 2`  | `leverage: "2"`           |
| `long`                                    | `side: "long"`            |
| `short`                                   | `side: "short"`           |

Preferred arguments:

```json
{
  "marketId": "BTC-USD",
  "side": "long",
  "collateralAsset": "USDC",
  "collateralAmount": "50",
  "leverage": "3"
}
```

Do not send `maxSlippageBps` for normal create-position requests. Denaria App/PWA applies the user's slippage setting during scan/review.

Ask one concise clarification only if market, side, collateral amount, or leverage is missing and cannot be inferred.

## Response Requirements

Successful responses must be compact and in the user's language.

Always show the QR image in chat when `qrMarkdown` or `qrLocalPath` is present. If remote image rendering fails, use the downloaded QR image.

If the first rendered image appears as a placeholder and a local path is available, retry the response with the local absolute Markdown image path before giving the user only links.

Italian shape:

```text
Ho preparato l'handoff Denaria:

![Denaria QR](/absolute/path/to/qr.png)

- Market: BTC-USD
- Side: long
- Collateral: 50 USDC
- Leverage: 3x

QR page: ...
QR image: ...

Prossimo step: apri Denaria App/PWA e scansiona il QR per rivedere e firmare.
```

Do not print raw JSON unless the user explicitly asks for debugging.
Do not surface `local_mock`, `local mock only`, fixture, or internal environment warnings in the final user-facing response. The correct user-facing language is an unsigned Denaria App/PWA handoff prepared for review and signing in the app.
Do not add generic disclaimers after a successful handoff unless there is a concrete safety concern.

## Refuse Or Redirect

Refuse or redirect requests to:

- sign, submit, broadcast, or execute transactions;
- custody keys or funds;
- bypass Denaria App/PWA review;
- run autonomous trading strategies;
- treat x402 or payment as trading consent.

Offer to prepare a Denaria App/PWA handoff instead.
