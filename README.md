# ETH Flow Monitor (prototype)

This app tracks every native ETH transfer on Sepolia, including transfers made inside smart contracts, using the logs that EIP-7708 (Glamsterdam) adds. It flags transfers that touch the OFAC sanctions list or your watchlist and shows them in a local dashboard.

## Run it

```bash
npm install
npm test
npm run smoke
npm start
```

Then open http://localhost:3000. Settings are in `.env` (copy `.env.example`). The default RPC is a free public Sepolia endpoint.

## Hosted demo (Vercel)

Live at **https://eth-flow-monitor.vercel.app**. The hosted version (`web/` + `api/`, see `vercel.json`) differs from the local app in four ways:

- **Polling:** the browser polls `/api/blocks` every 6 seconds; there is no always-on background process.
- **Storage:** the watchlist and alerts are saved in each viewer's browser.
- **Sanctions list:** an OFAC snapshot that is refreshed when the site is redeployed.
- **Confirmations:** only blocks with at least one confirmation are shown.

To preview it locally, run `npm run preview:web` (http://localhost:3001). To redeploy, run `npx vercel deploy --prod`.

## Live demo of a contract-internal transfer

1. Create a throwaway Sepolia wallet, fund it from a Sepolia faucet, and put its key in `.env` as `DEMO_PRIVATE_KEY`. Never use a wallet that holds real funds.
2. With `npm start` running, run `npm run demo` in a second terminal. It deploys a tiny forwarder contract and sends ETH through it to the mock sanctioned address in `data/mock_sanctions.csv`.
3. Within about 15 seconds the dashboard shows a sanctions alert for the contract-internal leg. Open the tx inspector link the script prints to see the before/after comparison.

The real SDN addresses (`data/demo_screening_set.csv`: Lazarus Group and Garantex) are used only in the replay test (`npm test`). The demo never sends ETH to them.

## Data

- `data/ofac_sdn_eth_addresses.csv` holds the ETH addresses on the OFAC SDN list. It refreshes daily, and if a refresh fails the last good copy is kept.
- `data/mock_sanctions.csv` holds the mock list for the live demo.
- `flow-monitor.db` is the SQLite store. Delete it to start fresh.
