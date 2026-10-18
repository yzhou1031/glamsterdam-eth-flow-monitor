import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, formatEther, http, isAddress, pad, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { config } from '../src/config.js';
import { parseCsv } from '../src/csv.js';
import { MOCK_FILE } from '../src/sanctions.js';

/** init code (601780600b6000396000f3) + runtime (forward msg.value to the address in calldata[0:32]). */
const FORWARDER_DEPLOY_CODE: Hex = '0x601780600b6000396000f36000600060006000346000355af1601557600080fd5b00';

const key = process.env.DEMO_PRIVATE_KEY as Hex | undefined;
if (!key) {
  console.error('Set DEMO_PRIVATE_KEY in .env to the key of a throwaway Sepolia test wallet (never a wallet with real funds).');
  process.exit(1);
}

function firstMockAddress(): string | undefined {
  const file = path.join(config.dataDir, MOCK_FILE);
  if (!fs.existsSync(file)) return undefined;
  const [head, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  return rows[0]?.[head!.indexOf('address')];
}

const recipient = process.env.DEMO_RECIPIENT || firstMockAddress();
if (!recipient || !isAddress(recipient, { strict: false })) {
  console.error('Set DEMO_RECIPIENT in .env, or put an address in data/mock_sanctions.csv.');
  process.exit(1);
}

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(config.rpcUrl) });
console.log(`Wallet ${account.address}: ${formatEther(await publicClient.getBalance({ address: account.address }))} Sepolia ETH`);

let forwarder = process.env.DEMO_FORWARDER as Hex | undefined;
if (!forwarder) {
  console.log('Deploying the forwarder contract…');
  const deployHash = await wallet.deployContract({ abi: [], bytecode: FORWARDER_DEPLOY_CODE });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  forwarder = receipt.contractAddress!;
  console.log(`Forwarder deployed at ${forwarder}. Add DEMO_FORWARDER=${forwarder} to .env to reuse it next time.`);
}

const amount = parseEther(process.env.DEMO_AMOUNT_ETH || '0.0001');
console.log(`Sending ${formatEther(amount)} ETH: wallet -> forwarder -> ${recipient}`);
const hash = await wallet.sendTransaction({ to: forwarder, value: amount, data: pad(recipient as Hex, { size: 32 }) });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') {
  console.error(`Transaction reverted: ${hash}`);
  process.exit(1);
}
console.log(`Done in block ${receipt.blockNumber}. Transaction: ${hash}`);
console.log(`The wallet -> forwarder leg is top-level; the forwarder -> recipient leg is contract-internal.`);
console.log(`Inspect it: http://localhost:${config.port}/#inspect/${hash}`);
