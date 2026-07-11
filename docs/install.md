# Install

1. Install Denaria skills:

```bash
npx skills@latest add denaria-finance/denaria-skills
```

2. Select:

```text
/denaria-action-handoff
```

3. Optional: configure a stdio MCP server that runs:

```bash
npx -y @denaria/agent-pack mcp
```

4. Test with:

```text
Open BTC long with 50 USDC and 3x leverage on Denaria.
```

Expected result: a QR image rendered in chat, plus QR page URL, QR image URL, and next step. If no MCP tool is visible, the skill should use its bundled `scripts/prepare-handoff.mjs` fallback.
