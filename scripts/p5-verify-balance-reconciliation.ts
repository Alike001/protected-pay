import {
  createBalanceOperationCheckpoint,
  nextBalanceOperationAction,
  validateBalanceOperationCheckpoint,
  type BalanceOperationCheckpoint,
} from "../src/lib/balanceOperation.ts";

const PROGRAM_ID = "w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk";
const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const WALLET = "6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn";
const TEST_SIGNATURE = "1".repeat(64);

function expectThrow(label: string, operation: () => unknown) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`${label} should fail`);
}

function expectAction(
  label: string,
  checkpoint: BalanceOperationCheckpoint,
  observation: Parameters<typeof nextBalanceOperationAction>[1],
  expected: ReturnType<typeof nextBalanceOperationAction>,
) {
  const actual = nextBalanceOperationAction(checkpoint, observation);
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

const deposit = createBalanceOperationCheckpoint(WALLET, "deposit", 1_000_000n, 2_000_000n);
const withdrawal = createBalanceOperationCheckpoint(WALLET, "withdraw", 1_000_000n, 2_000_000n);
if (deposit.expectedAvailable !== "3000000" || withdrawal.expectedAvailable !== "1000000") {
  throw new Error("Checkpoint arithmetic is incorrect");
}
validateBalanceOperationCheckpoint(deposit, WALLET);
expectThrow("wrong wallet", () => validateBalanceOperationCheckpoint(deposit, "Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ"));
expectThrow("tampered expected balance", () => validateBalanceOperationCheckpoint({ ...deposit, expectedAvailable: "4000000" }, WALLET));
expectThrow("over-withdrawal", () => createBalanceOperationCheckpoint(WALLET, "withdraw", 3_000_000n, 2_000_000n));
expectThrow("overflowing top-up", () => createBalanceOperationCheckpoint(WALLET, "deposit", 1n, 18_446_744_073_709_551_615n));

const privateStart = { owner: DELEGATION_PROGRAM, publicAvailable: 2_000_000n, publicLocked: 0n, privateAvailable: 2_000_000n, privateLocked: 0n };
expectAction("fresh delegated balance", deposit, privateStart, "return");
expectAction("already completed", deposit, { ...privateStart, privateAvailable: 3_000_000n }, "complete");
expectAction("unexpected private mutation", deposit, { ...privateStart, privateAvailable: 2_500_000n }, "abort");
expectAction("locked balance", deposit, { ...privateStart, privateLocked: 1n }, "abort");

const returnPending = { ...deposit, returnTransaction: { signature: TEST_SIGNATURE, lastValidBlockHeight: "10" } };
expectAction("return signature checkpoint", returnPending, privateStart, "wait-return");

const publicStart = { owner: PROGRAM_ID, publicAvailable: 2_000_000n, publicLocked: 0n, privateAvailable: null, privateLocked: null };
expectAction("returned public balance", returnPending, publicStart, "mutate");
expectAction("public balance already changed", returnPending, { ...publicStart, publicAvailable: 3_000_000n }, "wait-private");

const mutationPending = { ...returnPending, mutationTransaction: { signature: TEST_SIGNATURE, lastValidBlockHeight: "11" } };
expectAction("pending mutation on public state", mutationPending, publicStart, "wait-mutation");
expectAction("pending mutation on delegated state", mutationPending, privateStart, "wait-mutation");

console.log(JSON.stringify({
  assertions: "all passed",
  cases: 13,
  invariant: "A reviewed custody mutation is sent only from the exact public starting balance; expected or ambiguous state is never resent.",
  signed: false,
  broadcast: false,
}, null, 2));
