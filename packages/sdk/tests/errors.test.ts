import { AnchorError } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import idl from "../../../artifacts/idl/aegis.json";
import dexIdl from "../../../artifacts/idl/demo_dex.json";
import { AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID } from "../src/index";
import { failure, programErrorName, transactionErrorName } from "../src/errors";
import { errorLogs } from "./anchor-helpers";

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
