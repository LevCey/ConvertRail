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
  loadDemoConfig,
  publicClient,
  walletClient,
  ROLE,
} from "@convertrail/shared";

const WALLET_NAMES = ["advertiser", "operational", "verifier", "merchant", "pub-a", "pub-b", "pub-x"] as const;
type WalletName = (typeof WALLET_NAMES)[number];

const config = loadDemoConfig();
const TARGET_SETTLED = Number(process.env.E2E_TARGET_SETTLED ?? 50);
if (!Number.isSafeInteger(TARGET_SETTLED) || TARGET_SETTLED <= 0) {
  throw new Error(`invalid E2E_TARGET_SETTLED ${process.env.E2E_TARGET_SETTLED}`);
}

const MIN_NATIVE = parseEther("0.02"); // gas floor for the final assertion (native USDC, 18d)
// Per-actor native-gas targets. Heavy tx senders (verifier, publishers,
// operational/settlement) get more, sized above the 50+ settlement demo.
const NATIVE_TARGET: Record<WalletName, bigint> = {
  advertiser: parseEther("0.05"),
  operational: parseEther("0.50"),
  verifier: parseEther("1.00"),
  merchant: 0n,
  "pub-a": parseEther("0.50"),
  "pub-b": parseEther("0.40"),
  "pub-x": parseEther("0.30"),
};
const ADVERTISER_TARGET_USDC = BigInt(config.campaign.budget) + parseUnits("1", 6);
const GATEWAY_HEADROOM_USDC = parseUnits("1", 6); // absorbs claims landing during the harness stop interval
const GATEWAY_MIN_AVAILABLE =
  BigInt(config.campaign.pricePerConversion) * BigInt(TARGET_SETTLED) + GATEWAY_HEADROOM_USDC;
const WALLET_GAS_RESERVE_USDC = parseUnits("1", 6);
const FUNDER_RESERVE_USDC = parseUnits("0.5", 6);
const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

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

async function readUsdc(address: Address): Promise<bigint> {
  return pub.readContract({
    address: env.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

async function transferUsdc(
  label: string,
  sender: ReturnType<typeof walletClient>,
  recipient: Address,
  amount: bigint,
): Promise<void> {
  console.log(`funding ${label} with ${formatUnits(amount, 6)} USDC...`);
  await withRetry(`usdc ${label}`, async () => {
    const hash = await sender.writeContract({
      address: env.usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, amount],
    });
    await pub.waitForTransactionReceipt({ hash });
  });
}

async function ensureOperationalUsdc(address: Address, target: bigint): Promise<void> {
  const balance = await readUsdc(address);
  if (balance >= target) return;
  const shortfall = target - balance;
  const funderBalance = await readUsdc(funder.account!.address);
  const transferable = funderBalance > FUNDER_RESERVE_USDC ? funderBalance - FUNDER_RESERVE_USDC : 0n;
  if (transferable < shortfall) {
    throw new Error(
      `FAIL funder: ${formatUnits(transferable, 6)} transferable USDC after its gas reserve, ` +
        `${formatUnits(shortfall, 6)} needed to fund operational to ${formatUnits(target, 6)}. ` +
        `Top up ${funder.account!.address} from https://faucet.circle.com (Arc Testnet).`,
    );
  }
  console.log(
    `operational wallet ${formatUnits(balance, 6)} → ${formatUnits(target, 6)} ` +
      `(Gateway shortfall + gas reserve)`,
  );
  await transferUsdc("operational", funder, address, shortfall);
}

async function ensureAdvertiserUsdc(operational: WalletEntry, operationalReserve: bigint): Promise<void> {
  const advertiser = wallets.advertiser.address;
  let remaining = ADVERTISER_TARGET_USDC - (await readUsdc(advertiser));
  if (remaining <= 0n) return;

  const operationalClient = walletClient(env, operational.privateKey);
  const donors = [
    {
      name: "funder",
      address: funder.account!.address,
      client: funder,
      reserve: FUNDER_RESERVE_USDC,
    },
    {
      name: "operational",
      address: operational.address,
      client: operationalClient,
      reserve: operationalReserve,
    },
  ] as const;

  for (const donor of donors) {
    const balance = await readUsdc(donor.address);
    const transferable = balance > donor.reserve ? balance - donor.reserve : 0n;
    const amount = transferable < remaining ? transferable : remaining;
    if (amount === 0n) continue;
    await transferUsdc(`advertiser from ${donor.name}`, donor.client, advertiser, amount);
    remaining -= amount;
    if (remaining === 0n) return;
  }

  throw new Error(
    `FAIL pooled funding: ${formatUnits(remaining, 6)} additional USDC needed for advertiser after preserving ` +
      `funder and operational gas/deposit reserves. Top up ${funder.account!.address} from ` +
      `https://faucet.circle.com (Arc Testnet).`,
  );
}

async function ensureFunderReserve(operational: WalletEntry): Promise<void> {
  const funderBalance = await readUsdc(funder.account!.address);
  if (funderBalance >= FUNDER_RESERVE_USDC) return;

  const shortfall = FUNDER_RESERVE_USDC - funderBalance;
  const operationalBalance = await readUsdc(operational.address);
  const transferable =
    operationalBalance > WALLET_GAS_RESERVE_USDC ? operationalBalance - WALLET_GAS_RESERVE_USDC : 0n;
  if (transferable < shortfall) {
    throw new Error(
      `FAIL pooled funding: funder is ${formatUnits(shortfall, 6)} USDC below its gas reserve and operational ` +
        `cannot replenish it without crossing its own reserve. Top up ${funder.account!.address} from ` +
        `https://faucet.circle.com (Arc Testnet).`,
    );
  }
  await transferUsdc(
    "funder reserve from operational",
    walletClient(env, operational.privateKey),
    funder.account!.address,
    shortfall,
  );
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

async function readGatewayAvailable(operational: WalletEntry): Promise<bigint> {
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: operational.privateKey,
    rpcUrl: env.rpcUrl,
  });
  // getBalance() is the Gateway API-only read. getBalances() also performs an
  // Arc RPC wallet read, which makes a balance assertion needlessly throttle-prone.
  return withRetry("gateway getBalance", async () => (await gateway.getBalance()).available as bigint);
}

async function ensureGatewayDeposit(operational: WalletEntry, initialAvailable: bigint): Promise<bigint> {
  const operationalClient = walletClient(env, operational.privateKey);
  const readAvailable = () => readGatewayAvailable(operational);
  let available = initialAvailable;
  if (available >= GATEWAY_MIN_AVAILABLE) {
    console.log(`gateway available: ${formatUnits(available, 6)} (ok)`);
    return available;
  }
  const requiredDeposit = GATEWAY_MIN_AVAILABLE - available;
  const depositAmount = formatUnits(requiredDeposit, 6);
  console.log(
    `gateway available ${formatUnits(available, 6)} below ${formatUnits(GATEWAY_MIN_AVAILABLE, 6)} target, ` +
      `depositing ${depositAmount} USDC...`,
  );

  const allowance = await withRetry("gateway allowance", () =>
    pub.readContract({
      address: env.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [operational.address, env.gatewayWallet],
    }),
  );
  if (allowance < requiredDeposit) {
    const approvalHash = await withRetry("gateway approval send", () =>
      operationalClient.writeContract({
        address: env.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [env.gatewayWallet, requiredDeposit],
      }),
    );
    const approvalReceipt = await withRetry("gateway approval receipt", () =>
      pub.waitForTransactionReceipt({ hash: approvalHash }),
    );
    if (approvalReceipt.status !== "success") {
      throw new Error(`FAIL operational: Gateway approval reverted (${approvalHash})`);
    }
  }

  // Send deposit directly with the repository's throttle-resilient clients.
  // The SDK performs unwrapped RPC reads around this same contract call and can
  // report a false failure after a successful approval on the public Arc RPC.
  const target = GATEWAY_MIN_AVAILABLE;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const depositTxHash = await withRetry("gateway deposit send", () =>
        operationalClient.writeContract({
          address: env.gatewayWallet,
          abi: gatewayWalletAbi,
          functionName: "deposit",
          args: [env.usdc, requiredDeposit],
          gas: 120_000n,
        }),
      );
      const receipt = await withRetry("gateway deposit receipt", () =>
        pub.waitForTransactionReceipt({ hash: depositTxHash }),
      );
      if (receipt.status !== "success") {
        throw new Error(`Gateway deposit reverted (${depositTxHash})`);
      }
    } catch (err) {
      console.log(`  gateway deposit attempt ${attempt} raised: ${(err as Error).message.split("\n")[0]}`);
    }
    const waitStart = Date.now();
    while (Date.now() - waitStart < 90_000) {
      await new Promise((r) => setTimeout(r, 6_000));
      const now = await readAvailable().catch(() => available);
      if (now >= target) {
        console.log(`gateway credited: ${formatUnits(now, 6)}`);
        return now;
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

await ensureRole("advertiser", wallets.advertiser.address, ROLE.ADVERTISER);
await ensureRole("verifier", wallets.verifier.address, ROLE.VERIFIER);
await ensureRole("pub-a", wallets["pub-a"].address, ROLE.PUBLISHER);
await ensureRole("pub-b", wallets["pub-b"].address, ROLE.PUBLISHER);
await ensureRole("pub-x", wallets["pub-x"].address, ROLE.PUBLISHER);

const initialGatewayAvailable = await readGatewayAvailable(wallets.operational);
const requiredGatewayDeposit =
  initialGatewayAvailable < GATEWAY_MIN_AVAILABLE ? GATEWAY_MIN_AVAILABLE - initialGatewayAvailable : 0n;
const operationalReserve = requiredGatewayDeposit + WALLET_GAS_RESERVE_USDC;
await ensureOperationalUsdc(wallets.operational.address, operationalReserve);
await ensureAdvertiserUsdc(wallets.operational, operationalReserve);

const gatewayAvailable = await ensureGatewayDeposit(wallets.operational, initialGatewayAvailable);
await ensureFunderReserve(wallets.operational);

// Final loud assertion pass.
const failures: string[] = [];
for (const name of WALLET_NAMES) {
  if (name === "merchant") continue;
  const balance = await withRetry(`assert gas ${name}`, () => pub.getBalance({ address: wallets[name].address }));
  if (balance < MIN_NATIVE) failures.push(`${name}: native ${formatUnits(balance, 18)} < floor`);
}
const advertiserUsdc = await withRetry("assert advertiser USDC", () =>
  readUsdc(wallets.advertiser.address),
);
if (advertiserUsdc < ADVERTISER_TARGET_USDC) {
  failures.push(
    `advertiser: USDC ${formatUnits(advertiserUsdc, 6)} < funded target ${formatUnits(ADVERTISER_TARGET_USDC, 6)}`,
  );
}
const funderUsdc = await withRetry("assert funder USDC", () => readUsdc(funder.account!.address));
if (funderUsdc < FUNDER_RESERVE_USDC) {
  failures.push(`funder: USDC ${formatUnits(funderUsdc, 6)} < gas reserve ${formatUnits(FUNDER_RESERVE_USDC, 6)}`);
}
if (gatewayAvailable < GATEWAY_MIN_AVAILABLE) {
  failures.push(
    `operational: Gateway available ${formatUnits(gatewayAvailable, 6)} < demo target ${formatUnits(GATEWAY_MIN_AVAILABLE, 6)}`,
  );
}
if (failures.length > 0) {
  console.error("PROVISIONING FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(
  `  gateway: ${formatUnits(gatewayAvailable, 6)} available ` +
    `(covers ${TARGET_SETTLED} × ${formatUnits(BigInt(config.campaign.pricePerConversion), 6)} USDC + headroom)`,
);
console.log("provisioning complete:");
for (const name of WALLET_NAMES) {
  console.log(`  ${name}: ${wallets[name].address}`);
}
