export type SpendablePrivateBalance = {
  available: bigint;
  exists: boolean;
  paused: boolean;
};

export function assertCanProtectPayment(balance: SpendablePrivateBalance, amount: bigint) {
  if (!balance.exists) {
    throw new Error("Set up your protected balance before sending a payment.");
  }
  if (balance.paused) {
    throw new Error("Payment automation is paused. Resume it before sending a payment.");
  }
  if (amount > balance.available) {
    throw new Error("The payment amount exceeds your available protected balance.");
  }
}
