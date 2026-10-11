import { AnchorError } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import idl from "../../../artifacts/idl/aegis.json";
import dexIdl from "../../../artifacts/idl/demo_dex.json";
import { AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID } from "../src/index";
import { failure, programErrorName, transactionErrorName } from "../src/errors";
import { errorLogs } from "./anchor-helpers";
import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

describe("standard program custom errors", () => {
  it.each([
    [TOKEN_PROGRAM_ID, 0, "NotRentExempt"], [TOKEN_PROGRAM_ID, 1, "InsufficientFunds"],
    [TOKEN_PROGRAM_ID, 3, "MintMismatch"], [TOKEN_PROGRAM_ID, 4, "OwnerMismatch"],
    [TOKEN_PROGRAM_ID, 17, "AccountFrozen"], [PublicKey.default, 0, "AccountAlreadyInUse"],
    [PublicKey.default, 1, "ResultWithNegativeLamports"], [ASSOCIATED_TOKEN_PROGRAM_ID, 0, "InvalidOwner"],
  ] as const)("attributes %s custom %s to %s even through CPI", (program, code, name) => {
    const logs = [`Program ${AEGIS_PROGRAM_ID} invoke [1]`, ...errorLogs(program, code),
      `Program ${AEGIS_PROGRAM_ID} failed: custom program error: 0x${code.toString(16)}`];
    expect(programErrorName(logs)).toBe(name);
    expect(transactionErrorName({ InstructionError: [0, { Custom: code }] }, logs)).toBe(name);
    expect(failure({ logs })).toEqual({ ok: false, origin: "program", error: name });
    expect(programErrorName(errorLogs(AEGIS_PROGRAM_ID, code))).toBe(`CustomProgramError(${code})`);
    expect(transactionErrorName({ InstructionError: [0, { Custom: code }] })).toBe(`CustomProgramError(${code})`);
  });

  it("attributes a System failure inside the associated token program to System", () => {
    expect(programErrorName([`Program ${ASSOCIATED_TOKEN_PROGRAM_ID} invoke [1]`, ...errorLogs(PublicKey.default, 1),
      `Program ${ASSOCIATED_TOKEN_PROGRAM_ID} failed: custom program error: 0x1`])).toBe("ResultWithNegativeLamports");
  });

  it.each([TOKEN_PROGRAM_ID, PublicKey.default, ASSOCIATED_TOKEN_PROGRAM_ID])("keeps unknown codes for %s", (program) => {
    expect(programErrorName(errorLogs(program, 999))).toBe("CustomProgramError(999)");
  });
});

describe("program-aware IDL error names", () => {
  it.each(idl.errors)("maps AnchorError $name from the generated numeric code", ({ name, code }) => {
    const logs = [`Program ${AEGIS_PROGRAM_ID} invoke [1]`, `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${code}. Error Message: Example.`];
    const error = AnchorError.parse(logs);
    expect(error).not.toBeNull();
    expect(failure(error)).toEqual({ ok: false, error: name, origin: "program" });
  });

  it.each(dexIdl.errors)("maps DEX $name independently of Aegis's overlapping codes", ({ name, code }) => {
    expect(programErrorName([`Program ${AEGIS_PROGRAM_ID} invoke [1]`, ...errorLogs(DEMO_DEX_PROGRAM_ID, code)])).toBe(name);
  });

  it("does not interpret a different program's numeric error as an Aegis error", () => {
    expect(programErrorName(["Program 11111111111111111111111111111111 failed: custom program error: 0x1774"])).toBe("CustomProgramError(6004)");
    expect(transactionErrorName({ InstructionError: [0, { Custom: 6004 }] })).toBe("CustomProgramError(6004)");
  });

  it("restores the parent after a successful CPI and does not trust logged names", () => {
    expect(programErrorName([
      `Program ${AEGIS_PROGRAM_ID} invoke [1]`, `Program ${DEMO_DEX_PROGRAM_ID} invoke [2]`, `Program ${DEMO_DEX_PROGRAM_ID} success`,
      "Program log: AnchorError occurred. Error Code: MisleadingName. Error Number: 6007. Error Message: Example.",
    ])).toBe("SwapResultMismatch");
  });

  it("keeps built-in transaction failures and sanitizes unknown transport errors", () => {
    expect(transactionErrorName("InsufficientFundsForFee")).toBe("InsufficientFundsForFee");
    expect(transactionErrorName({ InstructionError: [0, "InvalidArgument"] })).toBe("InvalidArgument");
    expect(failure(new Error("Authorization secret"))).toEqual({ ok: false, origin: "rpc", error: "RpcError" });
  });
});
