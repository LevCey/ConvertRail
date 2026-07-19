// Idempotent wallet provisioning for the demo actors. Persistent keys live in
// .wallets.json (gitignored); funding comes from FUNDER_PRIVATE_KEY. Fails
// loud, with the wallet named, on any shortfall. A second run is a no-op.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { erc20Abi, formatUnits, parseEther, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  agentRegistryAbi,
  chainEnvFromProcess,
  publicClient,
  walletClient,
  ROLE,
} from "@convertrail/shared";

const WALLET_NAMES = ["advertiser", "operational", "verifier", "merchant", "pub-a", "pub-b", "pub-x"] as const;
type WalletName = (typeof WALLET_NAMES)[number];

const MIN_NATIVE = parseEther("0.02"); // gas floor for the final assertion (native USDC, 18d)
// Per-actor native-gas targets. Heavy tx senders (verifier, publishers,
// operational/settlement) get more, sized well above a full target-20 run.
const NATIVE_TARGET: Record<WalletName, bigint> = {
  advertiser: parseEther("0.05"),
  operational: parseEther("0.30"),
  verifier: parseEther("0.50"),
  merchant: 0n,
  "pub-a": parseEther("0.25"),
  "pub-b": parseEther("0.25"),
  "pub-x": parseEther("0.20"),
};
const ADVERTISER_MIN_USDC = 10_000_000n; // covers the $10 campaign budget
const ADVERTISER_TOPUP_USDC = 11_000_000n;
const OPERATIONAL_MIN_USDC = 4_000_000n; // float to fund Gateway deposits (>= GATEWAY_DEPOSIT)
const GATEWAY_MIN_AVAILABLE = 2_500_000n; // available floor in Gateway
const GATEWAY_DEPOSIT = "3"; // deposit size when below the floor

interface WalletEntry {
  address: Address;
  privateKey: Hex;
}
type WalletFile = Record<WalletName, WalletEntry>;

const env = chainEnvFromProcess();
const pub = publicClient(env);
const funderKey = process.env.FUNDER_PRIVATE_KEY as Hex | undefined;
if (!funderKey) throw new Error("missing env var FUNDER_PRIVATE_KEY");
const funder = walletClient(env, funderKey);

const WALLETS_PATH = new URL("../.wallets.json", import.meta.url).pathname;

// The public Arc testnet RPC rate-limits bursts; every tx goes through
// paced retry with backoff instead of failing the whole run on a throttle.
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const MAX = 6;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await fn();
      await new Promise((r) => setTimeout(r, 1_500)); // pacing between txs
      return result;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const throttled = msg.includes("request limit") || msg.includes("-32011") || msg.includes("429");
      if (!throttled || attempt >= MAX) throw err;
      const delay = 3_000 * attempt;
      console.log(`  ${label}: rate-limited, retrying in ${delay / 1000}s (${attempt}/${MAX})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function loadOrCreateWallets(): WalletFile {
  let file: Partial<WalletFile> = {};
  if (existsSync(WALLETS_PATH)) {
    file = JSON.parse(readFileSync(WALLETS_PATH, "utf8"));
  }
  let changed = false;
  for (const name of WALLET_NAMES) {
    if (!file[name]) {
      const privateKey = generatePrivateKey();
      file[name] = { address: privateKeyToAccount(privateKey).address, privateKey };
      changed = true;
      console.log(`created wallet ${name}: ${file[name]!.address}`);
    }
  }
  if (changed) writeFileSync(WALLETS_PATH, JSON.stringify(file, null, 2) + "\n");
  return file as WalletFile;
}

async function ensureNative(name: WalletName, address: Address): Promise<void> {
  const target = NATIVE_TARGET[name];
  const balance = await pub.getBalance({ address });
  if (balance >= target) return;
  const topup = target - balance;
  console.log(`funding ${name} with ${formatUnits(topup, 18)} native gas (target ${formatUnits(target, 18)})...`);
  await withRetry(`gas ${name}`, async () => {
    const hash = await funder.sendTransaction({ to: address, value: topup });
    await pub.waitForTransactionReceipt({ hash });
  });
}

async function ensureUsdc(name: WalletName, address: Address, min: bigint, topup: bigint): Promise<void> {
  const balance = await pub.readContract({
    address: env.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  if (balance >= min) return;
  console.log(`funding ${name} with ${formatUnits(topup, 6)} USDC...`);
  await withRetry(`usdc ${name}`, async () => {
    const hash = await funder.writeContract({
      address: env.usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [address, topup],
    });
    await pub.waitForTransactionReceipt({ hash });
  });
}

async function ensureRole(name: WalletName, address: Address, role: number): Promise<void> {
  const current = await pub.readContract({
    address: env.agentRegistry,
    abi: agentRegistryAbi,
    functionName: "roleOf",
    args: [address],
  });
  if (Number(current) === role) return;
  if (Number(current) !== ROLE.NONE) {
    throw new Error(`FAIL ${name}: registered with role ${current}, expected ${role}`);
  }
  console.log(`registering ${name} with role ${role}...`);
  await withRetry(`role ${name}`, async () => {
    const hash = await funder.writeContract({
      address: env.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "register",
      args: [address, role],
    });
    await pub.waitForTransactionReceipt({ hash });
  });
}

async function ensureGatewayDeposit(operational: WalletEntry): Promise<void> {
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: operational.privateKey,
    rpcUrl: env.rpcUrl,
  });
  // A throttled getBalances must not be misread as "0 available" (which would
  // force a needless deposit) — read it through the same backoff as every tx.
  const readAvailable = () =>
    withRetry("gateway getBalances", async () => (await gateway.getBalances()).gateway.available as bigint);

  let available = await readAvailable();
  if (available >= GATEWAY_MIN_AVAILABLE) {
    console.log(`gateway available: ${formatUnits(available, 6)} (ok)`);
    return;
  }
  console.log(`gateway available ${formatUnits(available, 6)} below floor, depositing ${GATEWAY_DEPOSIT} USDC...`);

  // The SDK's deposit() chains several RPC calls and is not throttle-resilient;
  // a throttle can surface even after the deposit tx already landed. So attempt,
  // then confirm by a balance increase (authoritative) rather than the SDK return.
  const target = available + parseUnits(GATEWAY_DEPOSIT, 6);
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await gateway.deposit(GATEWAY_DEPOSIT);
    } catch (err) {
      console.log(`  gateway deposit attempt ${attempt} raised: ${(err as Error).message.split("\n")[0]}`);
    }
    const waitStart = Date.now();
    while (Date.now() - waitStart < 90_000) {
      await new Promise((r) => setTimeout(r, 6_000));
      const now = await readAvailable().catch(() => available);
      if (now >= target) {
        console.log(`gateway credited: ${formatUnits(now, 6)}`);
        return;
      }
      if (now > available) available = now;
    }
    await new Promise((r) => setTimeout(r, 8_000 * attempt));
  }
  throw new Error(`FAIL operational: gateway deposit did not credit after retries (available ${formatUnits(available, 6)})`);
}

const wallets = loadOrCreateWallets();

for (const name of WALLET_NAMES) {
  if (name === "merchant") continue; // signs events off-chain only, needs no funds
  await ensureNative(name, wallets[name].address);
}
await ensureUsdc("advertiser", wallets.advertiser.address, ADVERTISER_MIN_USDC, ADVERTISER_TOPUP_USDC);
await ensureUsdc("operational", wallets.operational.address, OPERATIONAL_MIN_USDC, OPERATIONAL_MIN_USDC);

await ensureRole("advertiser", wallets.advertiser.address, ROLE.ADVERTISER);
await ensureRole("verifier", wallets.verifier.address, ROLE.VERIFIER);
await ensureRole("pub-a", wallets["pub-a"].address, ROLE.PUBLISHER);
await ensureRole("pub-b", wallets["pub-b"].address, ROLE.PUBLISHER);
await ensureRole("pub-x", wallets["pub-x"].address, ROLE.PUBLISHER);

await ensureGatewayDeposit(wallets.operational);

// Final loud assertion pass.
const failures: string[] = [];
for (const name of WALLET_NAMES) {
  if (name === "merchant") continue;
  const balance = await pub.getBalance({ address: wallets[name].address });
  if (balance < MIN_NATIVE) failures.push(`${name}: native ${formatUnits(balance, 18)} < floor`);
}
if (failures.length > 0) {
  console.error("PROVISIONING FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("provisioning complete:");
for (const name of WALLET_NAMES) {
  console.log(`  ${name}: ${wallets[name].address}`);
}
