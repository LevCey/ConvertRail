// Cold verification of suppression receipts. Takes a journal or a receipt file
// and checks each signature against the address the receipt names.
//
// Deliberately needs nothing else: no key, no config, no network, no access to
// the system that produced the file. A receipt only counts as evidence if
// somebody who does not trust us can check it, and that is exactly what this
// does — the same code path an advertiser or an auditor would run.
import { readFileSync } from "node:fs";
import { verifyReceipt } from "../suppression/src/receipt.ts";
import type { SuppressionReceipt } from "../suppression/src/types.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run suppression:verify -- <journal.jsonl | receipt.json>");
  process.exit(2);
}

/** Accepts either a journal — one JSON record per line, receipts among them —
 * or a single receipt, so an advertiser can be handed one document rather than
 * the whole log. */
function loadReceipts(file: string): SuppressionReceipt[] {
  const raw = readFileSync(file, "utf8").trim();
  if (raw.length === 0) return [];

  if (raw.startsWith("{") && !raw.includes("\n{")) {
    const single = JSON.parse(raw) as SuppressionReceipt | { receipt: SuppressionReceipt };
    return "receipt" in single ? [single.receipt] : [single];
  }

  const receipts: SuppressionReceipt[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      // A line we cannot read is a line we cannot vouch for. Refusing beats
      // reporting "all valid" over a file we only partly understood.
      throw new Error(`${file}:${index + 1} is not readable: ${(error as Error).message}`);
    }
    const typed = record as { type?: string; receipt?: SuppressionReceipt };
    if (typed.type === "receipt" && typed.receipt) receipts.push(typed.receipt);
    else if ((record as SuppressionReceipt).signature) receipts.push(record as SuppressionReceipt);
  }
  return receipts;
}

const receipts = loadReceipts(path);
if (receipts.length === 0) {
  console.error(`no receipts found in ${path}`);
  process.exit(1);
}

let valid = 0;
const failures: string[] = [];

for (const receipt of receipts) {
  const result = await verifyReceipt(receipt);
  const mode = `${receipt.platform}/${receipt.executionMode}`;
  if (result.valid) {
    valid++;
    console.log(
      `  ok   ${receipt.receiptId}  ${receipt.status.padEnd(9)} ${mode.padEnd(14)} ` +
        `claim ${receipt.claimId} @ block ${receipt.verifiedAtBlock}  signer ${receipt.signer}`,
    );
  } else {
    failures.push(`${receipt.receiptId}: ${result.reason}`);
    console.log(`  FAIL ${receipt.receiptId}  ${result.reason}`);
  }
}

console.log(`\n${valid}/${receipts.length} receipts verify against the signer each one names.`);

// What this establishes, stated plainly so nobody reads more into a green run:
// each receipt is unaltered since signing, and each names the key that signed
// it. Whether that key was authorised is a question about key management, and
// whether the platform did anything with the submission is a question this
// document never claimed to answer.
if (failures.length > 0) {
  console.error(`\n${failures.length} receipt(s) failed verification:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
