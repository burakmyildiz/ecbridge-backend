import { JsonRpcProvider, encodeRlp } from "ethers";

export interface StorageProof {
  accountProof: string;   // single RLP‑encoded byte string
  storageProof: string;   // single RLP‑encoded byte string
}

/**
 * Wraps `eth_getProof` and returns the proofs in the byte‑blob
 * format expected by BridgeCitrea.finaliseDeposit() – i.e. each
 * proof is ONE RLP‑encoded list, **not** an array of node RLPs.
 */
export async function getStorageProof(
  provider: JsonRpcProvider,
  contract: string,
  blockNumber: number,     // ← execution block number, not beacon slot
  storageKey: string
): Promise<StorageProof> {
  const blockTag = `0x${blockNumber.toString(16)}`;

  const proof = await provider.send("eth_getProof", [
    contract,
    [storageKey],
    blockTag
  ]);

  // Some clients already return a single RLP blob (`accountProofRLP`).
  // If not, we compress the array ourselves via encodeRlp().
  const accountProofBytes =
    proof.accountProofRLP ?? encodeRlp(proof.accountProof);

  // `storageProof[0].proof` is always an array – turn it into one blob.
  const storageProofBytes = encodeRlp(proof.storageProof[0].proof);

  return {
    accountProof: accountProofBytes,
    storageProof: storageProofBytes
  };
}
