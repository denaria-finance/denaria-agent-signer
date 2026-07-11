# Denaria Skills

Denaria Skills provides agent-facing instructions and local tooling for preparing Denaria Action Handoff QR codes through the official Denaria MCP endpoint.

The repository is designed for AI agent clients that need to understand how to prepare a Denaria App/PWA handoff from a user request such as:

```text
open BTC long with 50 USDC and 3x leverage on Denaria
```

The output is an unsigned handoff QR that the user reviews and signs inside the Denaria App/PWA.

## Core Boundary

Denaria's agentic handoff flow is intentionally prepare-only:

```text
Denaria Agent Service prepares.
Denaria App/PWA verifies.
The user signs.
External agents do not execute.
```

This repository does not provide signing, custody, transaction submission, autonomous execution, private key handling, passkey handling, wallet delegation, or x402 payment authorization.

## What This Repository Contains

```text
skills/denaria-action-handoff/
  Agent skill instructions for Denaria prepare-only QR handoffs.

skills/denaria-action-handoff/scripts/prepare-handoff.mjs
  Bundled fallback script that calls Denaria MCP, downloads the QR image locally,
  and returns qrLocalPath plus qrMarkdown for reliable chat rendering.

packages/agent-pack/
  Installable wrapper package source for clients that support stdio MCP wrappers.

configs/
  Example client configuration material for supported agent environments.

docs/
  Installation and operational notes.
```

## Official MCP Endpoint

```text
https://mcp.denaria.finance/mcp
```

The MCP service prepares the action handoff and returns QR URLs. The skill and wrapper handle client-side behavior, including downloading the QR PNG when a chat client cannot reliably render remote images.

## Installation

Install the Denaria skill package in clients that support `skills@latest`:

```bash
npx skills@latest add denaria-finance/denaria-skills
```

Then select the skill in the agent client:

```text
/denaria-action-handoff
```

## Expected Agent Flow

```text
User request
  -> Denaria Action Handoff skill
  -> Denaria MCP prepare tool or bundled fallback script
  -> official Denaria MCP endpoint
  -> unsigned handoff payload and QR URLs
  -> QR PNG downloaded locally when needed
  -> QR rendered in chat
  -> Denaria App/PWA scans and verifies
  -> user signs inside the app
```

The skill should not send users through the Denaria trading UI manually when MCP preparation is available. It should prepare an unsigned handoff QR for App/PWA review.

## QR Rendering Strategy

Some agent clients render remote images inconsistently. To make the QR experience more reliable, the skill includes a fallback script:

```bash
node skills/denaria-action-handoff/scripts/prepare-handoff.mjs --side long --market BTC --collateral 50 --leverage 3
```

The script:

1. normalizes the user intent;
2. calls `https://mcp.denaria.finance/mcp`;
3. receives the Denaria handoff QR URL;
4. downloads the QR PNG to the user's machine;
5. returns `qrLocalPath`, `qrMarkdown`, `qrImageUrl`, `qrPageUrl`, and `nextStep`.

Agent clients should render `qrMarkdown` or the local image path first, and treat remote QR URLs as fallbacks.

## Optional MCP Wrapper

The source for an installable wrapper package is available under `packages/agent-pack`.

Once distributed as an npm package, clients that support stdio MCP wrappers can use:

```bash
npx -y @denaria/agent-pack mcp
```

The wrapper provides the same prepare-only handoff behavior as the bundled script, with a persistent MCP tool interface for compatible clients.

## Safety Model

Allowed:

- parse a user's Denaria position intent;
- prepare an unsigned Denaria App/PWA handoff;
- render the QR code for review in the Denaria App/PWA;
- provide QR page and image fallback URLs.

Not allowed:

- signing transactions;
- submitting or broadcasting transactions;
- custodying funds or keys;
- bypassing Denaria App/PWA review;
- treating an agent response as trade execution;
- running autonomous trading strategies.

If a user asks an external agent to execute a trade, the correct behavior is to prepare an unsigned Denaria App/PWA handoff and direct the user to review and sign inside the app.

## Development

Run package checks from the repository root:

```bash
npm run check
```

Run the wrapper smoke test:

```bash
npm run smoke
```

Test the bundled fallback script directly:

```bash
node skills/denaria-action-handoff/scripts/prepare-handoff.mjs --side long --market BTC --collateral 50 --leverage 3
```

A successful result includes a local QR PNG path and a Markdown image reference suitable for chat rendering.
