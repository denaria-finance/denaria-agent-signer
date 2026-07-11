# Troubleshooting

## The agent gives manual trading steps

The `/denaria-action-handoff` skill did not trigger or the Denaria MCP wrapper is not configured. Use `/denaria-action-handoff`; if the Denaria tool is unavailable, follow the setup snippet shown by that skill and confirm the `denaria` MCP server is available.

## The QR appears as a placeholder

Use the installed wrapper. It downloads the QR PNG and returns `qrLocalPath` and `qrMarkdown` with an absolute file path.

## MCP server unavailable

The wrapper calls the official endpoint:

```text
https://mcp.denaria.finance/mcp
```

Check network access and retry. Do not use fallback trading instructions as a substitute for an MCP handoff.

## Boundary

The wrapper prepares only. Denaria App/PWA verifies and the user signs.
