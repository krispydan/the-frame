import { describe, it, expect } from "vitest";
import { splitCogsLines, COGS_PAIR_CODES } from "@/modules/finance/lib/cogs-remediation";

describe("cogs-remediation splitCogsLines", () => {
  // A real old Stage-2 journal: revenue (2050/4040) + COGS pair (5000/1400).
  const lines = [
    { LineAmount: 120.0, AccountCode: "2050", Description: "Recognize revenue" },
    { LineAmount: -120.0, AccountCode: "4040", Description: "Sales - Faire" },
    { LineAmount: 11.84, AccountCode: "5000", Description: "COGS" },
    { LineAmount: -11.84, AccountCode: "1400", Description: "Inventory release" },
  ];

  it("separates the COGS pair from the revenue lines", () => {
    const { cogsLines, keepLines } = splitCogsLines(lines);
    expect(cogsLines.map((l) => l.AccountCode).sort()).toEqual(["1400", "5000"]);
    expect(keepLines.map((l) => l.AccountCode).sort()).toEqual(["2050", "4040"]);
  });

  it("the kept (revenue) lines still balance to zero", () => {
    const { keepLines } = splitCogsLines(lines);
    const sum = keepLines.reduce((s, l) => s + l.LineAmount, 0);
    expect(Math.abs(sum)).toBeLessThan(0.001);
  });

  it("the removed COGS pair is itself balanced (so the remainder stays balanced)", () => {
    const { cogsLines } = splitCogsLines(lines);
    const sum = cogsLines.reduce((s, l) => s + l.LineAmount, 0);
    expect(Math.abs(sum)).toBeLessThan(0.001);
  });

  it("a journal already revenue-only yields no COGS lines (idempotent)", () => {
    const clean = lines.filter((l) => !COGS_PAIR_CODES.includes(l.AccountCode));
    const { cogsLines, keepLines } = splitCogsLines(clean);
    expect(cogsLines).toHaveLength(0);
    expect(keepLines).toHaveLength(2);
  });

  it("does not touch FIFO component codes (5010/5020) — only 5000/1400", () => {
    const withComponents = [
      ...lines,
      { LineAmount: 2.0, AccountCode: "5010", Description: "freight" },
      { LineAmount: 1.0, AccountCode: "5020", Description: "duty" },
    ];
    const { cogsLines } = splitCogsLines(withComponents);
    expect(cogsLines.map((l) => l.AccountCode).sort()).toEqual(["1400", "5000"]);
  });
});
