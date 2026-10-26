export interface ReceiptPrintInput {
  propertyName: string;
  receiptNumber: string;
  lines: Array<{ name: string; quantity: number; total: number }>;
  total: number;
}

export function buildEscPosReceipt(input: ReceiptPrintInput): Uint8Array {
  const text = [
    "\x1b@",
    "\x1b\x61\x01",
    `${input.propertyName}\n`,
    `${input.receiptNumber}\n`,
    "\x1b\x61\x00",
    "--------------------------------\n",
    ...input.lines.map((line) => `${line.quantity} x ${line.name}\t${line.total.toFixed(2)}\n`),
    "--------------------------------\n",
    `TOTAL\t${input.total.toFixed(2)}\n`,
    "\n\n\x1dV\x00",
  ].join("");
  return new TextEncoder().encode(text);
}
