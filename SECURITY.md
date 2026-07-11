# Security

Denaria Skills and `@denaria/agent-pack` preserve this boundary:

```text
Denaria Agent Service prepares.
Denaria App/PWA verifies.
The user signs.
External agents do not execute.
```

Do not add wallet custody, private key handling, passkey handling, transaction signing, transaction broadcasting, autonomous trading, or x402 payment authorization to this repository.

The installed wrapper may call the official Denaria MCP endpoint and download QR images for display. It must not execute transactions.
