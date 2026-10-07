import { MessageV0, type PublicKey, type Signer, type VersionedTransaction } from "@solana/web3.js";

/** The wallet-adapter contract; no local signing material is accepted. */
export interface WalletSigner {
  readonly publicKey: PublicKey;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

/**
 * Public-only v0 envelope for Aegis owner transactions (one required signer).
 * Phantom accepts the web3 transaction shape and returns an externally signed
 * transaction. Keeping serialization separate avoids shipping local key signing
 * code to the browser. Wire compatibility is tested against web3.js itself.
 */
export class WalletTransaction implements VersionedTransaction {
  signatures = [new Uint8Array(64)];
  constructor(public message: MessageV0) {
    if (message.header.numRequiredSignatures !== 1) throw new Error("Expected one owner signer.");
  }
  get version(): 0 { return 0; }
  serialize(): Uint8Array {
    if (this.signatures.length !== 1 || this.signatures[0].length !== 64) throw new Error("Invalid signature.");
    const bytes = new Uint8Array([1, ...this.signatures[0], ...this.message.serialize()]);
    if (bytes.length > 1232) throw new Error("Transaction too large.");
    return bytes;
  }
  addSignature(key: PublicKey, signature: Uint8Array) {
    if (!key.equals(this.message.staticAccountKeys[0]) || signature.length !== 64) throw new Error("Invalid owner signature.");
    this.signatures = [new Uint8Array(signature)];
  }
  sign(_signers: Signer[]): never { throw new Error("Use the connected wallet to sign."); }
}
