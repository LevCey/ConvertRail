import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";

export interface PaymentRecord {
  campaignId: Hex;
  claimId: string;
  publisher: Address;
  amount: string;
  ref: string;
  elapsedMs: number;
  settleTx: Hex;
}

export interface DuplicateAttemptRecord {
  campaignId: Hex;
  publisher: Address;
  nullifier: Hex;
  evidenceHash: Hex;
  txHash: Hex;
  status: "reverted";
  conversionId: string;
}

export interface RunMetadata {
  campaignId: Hex;
  campaignName: string;
  startBlock: bigint;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

function records(text: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // An agent can be appending while the dashboard polls. Ignore only the
      // incomplete/malformed line; a later poll will see the completed record.
    }
  }
  return parsed;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parsePaymentRecords(text: string, campaignId: Hex): PaymentRecord[] {
  const byClaim = new Map<string, PaymentRecord>();
  for (const value of records(text)) {
    const v = object(value);
    if (
      !v ||
      typeof v.campaignId !== "string" ||
      v.campaignId.toLowerCase() !== campaignId.toLowerCase() ||
      !BYTES32.test(v.campaignId) ||
      typeof v.claimId !== "string" ||
      !UINT.test(v.claimId) ||
      typeof v.publisher !== "string" ||
      !ADDRESS.test(v.publisher) ||
      typeof v.amount !== "string" ||
      !UINT.test(v.amount) ||
      typeof v.ref !== "string" ||
      v.ref.length === 0 ||
      typeof v.elapsedMs !== "number" ||
      !Number.isFinite(v.elapsedMs) ||
      v.elapsedMs < 0 ||
      typeof v.settleTx !== "string" ||
      !BYTES32.test(v.settleTx)
    ) {
      continue;
    }
    byClaim.set(v.claimId, {
      campaignId: v.campaignId as Hex,
      claimId: v.claimId,
      publisher: v.publisher as Address,
      amount: v.amount,
      ref: v.ref,
      elapsedMs: v.elapsedMs,
      settleTx: v.settleTx as Hex,
    });
  }
  return [...byClaim.values()];
}

export function parseDuplicateAttempts(text: string, campaignId: Hex): DuplicateAttemptRecord[] {
  const byTx = new Map<string, DuplicateAttemptRecord>();
  for (const value of records(text)) {
    const v = object(value);
    if (
      !v ||
      v.type !== "duplicate" ||
      v.status !== "reverted" ||
      typeof v.campaignId !== "string" ||
      v.campaignId.toLowerCase() !== campaignId.toLowerCase() ||
      !BYTES32.test(v.campaignId) ||
      typeof v.publisher !== "string" ||
      !ADDRESS.test(v.publisher) ||
      typeof v.nullifier !== "string" ||
      !BYTES32.test(v.nullifier) ||
      typeof v.evidenceHash !== "string" ||
      !BYTES32.test(v.evidenceHash) ||
      typeof v.txHash !== "string" ||
      !BYTES32.test(v.txHash) ||
      typeof v.conversionId !== "string" ||
      v.conversionId.length === 0
    ) {
      continue;
    }
    byTx.set(v.txHash.toLowerCase(), {
      campaignId: v.campaignId as Hex,
      publisher: v.publisher as Address,
      nullifier: v.nullifier as Hex,
      evidenceHash: v.evidenceHash as Hex,
      txHash: v.txHash as Hex,
      status: "reverted",
      conversionId: v.conversionId,
    });
  }
  return [...byTx.values()];
}

export function parseRunMetadata(text: string, campaignId: Hex): RunMetadata | null {
  try {
    const v = object(JSON.parse(text));
    if (
      !v ||
      typeof v.campaignId !== "string" ||
      !BYTES32.test(v.campaignId) ||
      v.campaignId.toLowerCase() !== campaignId.toLowerCase() ||
      typeof v.campaignName !== "string" ||
      v.campaignName.length === 0 ||
      typeof v.startBlock !== "string" ||
      !UINT.test(v.startBlock)
    ) {
      return null;
    }
    return {
      campaignId: v.campaignId as Hex,
      campaignName: v.campaignName,
      startBlock: BigInt(v.startBlock),
    };
  } catch {
    return null;
  }
}

async function runtimeLog(name: string, override?: string): Promise<string> {
  const candidates = [
    override,
    process.env.CONVERTRAIL_RUNTIME_DIR ? resolve(process.env.CONVERTRAIL_RUNTIME_DIR, name) : undefined,
    resolve(process.cwd(), ".e2e", name),
    resolve(process.cwd(), "..", ".e2e", name),
  ].filter((p): p is string => !!p);

  for (const path of [...new Set(candidates)]) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return "";
}

export async function loadRuntimeEvidence(campaignId: Hex): Promise<{
  payments: PaymentRecord[];
  duplicateAttempts: DuplicateAttemptRecord[];
}> {
  const [payments, fraud] = await Promise.all([
    runtimeLog("payments.jsonl", process.env.PAYMENTS_LOG_PATH),
    runtimeLog("fraud.jsonl", process.env.FRAUD_LOG_PATH),
  ]);
  return {
    payments: parsePaymentRecords(payments, campaignId),
    duplicateAttempts: parseDuplicateAttempts(fraud, campaignId),
  };
}

export async function loadRunMetadata(campaignId: Hex): Promise<RunMetadata | null> {
  return parseRunMetadata(await runtimeLog("run.json", process.env.RUN_LOG_PATH), campaignId);
}
