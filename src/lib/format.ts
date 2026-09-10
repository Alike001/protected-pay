export function shortAddress(value: string, edge = 4) {
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

export function formatUsdc(value: bigint) {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseUsdc(value: string) {
  if (!/^\d+(\.\d{0,6})?$/.test(value.trim())) throw new Error("Enter a valid USDC amount with up to six decimals.");
  const [whole, fraction = ""] = value.trim().split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
