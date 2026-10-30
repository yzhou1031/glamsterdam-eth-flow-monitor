# ETH Flow Monitor: Demo Guide

**Live demo:** https://eth-flow-monitor.vercel.app
**Author:** Yuchen Zhou, FinTech-564 (Glamsterdam project)

## What it is

ETH Flow Monitor tracks every native ETH transfer on Ethereum's Sepolia testnet in real time, **including ETH moved inside smart contracts**. It flags transfers that touch a watched address or an address on the OFAC sanctions list.

It relies on one Glamsterdam change, **EIP-7708**, which makes every ETH transfer emit a standard Transfer log, as ERC-20 tokens already do. Before 7708, ETH moved inside a contract (by a multisig, a smart wallet or a DeFi protocol) left no log, and finding it needed expensive transaction tracing. Glamsterdam has been live on Sepolia since October 6, 2026, so the demo runs on real network data.

## What you can try (about 2 minutes)

On your first visit, the page adds the most active Sepolia address (the one that received the most ETH transfers in the latest blocks) to your watchlist, so real alerts appear within a few seconds. Every minute it switches to the busiest receiver of that minute.

1. **Alerts:** select an alert, then click **Escalate**, **Mark reviewed** or **False positive**. You can also add a note.
2. **Live feed:** new ETH transfers arrive about every 12 seconds. The **Type** column shows whether each one was **Top-level** (a normal transaction) or **Internal** (made inside a contract). Internal transfers are the ones EIP-7708 makes visible.
3. **Watchlist:** add any address, for example a "To" address from the Live feed. Alerts fire when that address sends or receives ETH, optionally only above a minimum amount.
4. **Tx inspector:** open any alert and click **inspect**. It compares the logs a tool could see before EIP-7708 with the new ETH Transfer logs.
5. **Sanctions list:** the 87 ETH addresses on the OFAC SDN list, including Lazarus Group and Garantex, plus one mock address used for the live demo.

**Reset demo** (next to the alert filter) clears everything and starts the demo again.

## What's real and what isn't

| Part | Status |
|---|---|
| ETH transfers, internal labels, Tx inspector | **Real**, read live from the Sepolia network |
| OFAC sanctions list | **Real** (OFAC SDN list snapshot, October 14, 2026) |
| Watchlist alerts | **Real**, triggered by live transfers |
| Sanctioned address in the live demo | **Mock**: one address created for the demo |

Real sanctioned addresses almost never transact on a testnet, so the **sanctions alert is shown live in our meeting**, using a small demo contract that forwards ETH to the mock address. Automated tests confirm that all **15** Lazarus Group and Garantex ETH addresses are flagged.

## Good to know

- Sepolia is a test network, so the ETH has no monetary value. The same code works on mainnet once Glamsterdam launches there; switching is a configuration change.
- Your watchlist and alerts are saved **only in your own browser**. Nothing is shared or stored on a server.
- This hosted version is the lightweight build. The full version, which runs on a laptop, also keeps a database, refreshes the OFAC list daily, handles chain reorganizations, and sends alerts to a webhook.

