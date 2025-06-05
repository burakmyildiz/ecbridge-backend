// test/check-deposit.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { getStorageProof } from "../src/utils/getStorageProof";
import { slotToELBlock } from "../src/utils/slotHelper";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function checkDeposit() {
  const txHash = "0x5acb8857ac8fbaa917cf13b647e7ec15ee84226973f13460f71b9fe83e6afe3a";
  const nonce = 46; // From your deposit details
  
  const l1Provider = new ethers.JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
  const receipt = await l1Provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error(`Transaction receipt not found for hash: ${txHash}`);
  }
  console.log(`Transaction confirmed in block: ${receipt.blockNumber}`);
  
  // Check light client
  const l2Provider = new ethers.JsonRpcProvider(process.env.CITREA_RPC_URL);
  const heliosABI = ["function head() view returns (uint256)", "function executionStateRoots(uint256) view returns (bytes32)"];
  const helios = new ethers.Contract(process.env.SP1_HELIOS_ADDRESS!, heliosABI, l2Provider);
  
  const head = await helios.head();
  console.log(`Current head slot: ${head}`);
  
  // Find latest finalized slot with state root
  for (let slot = Number(head); slot > Number(head) - 100; slot -= 32) {
    const stateRoot = await helios.executionStateRoots(slot);
    if (stateRoot !== ethers.ZeroHash) {
      console.log(`Found state root at slot ${slot}: ${stateRoot}`);
      
      // Calculate storage proof inputs
      const L1_BRIDGE_ADDRESS = process.env.ETH_BRIDGE_ADDRESS!;
      const DEPOSITS_STORAGE_SLOT = BigInt(3);
      const storageKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [nonce, DEPOSITS_STORAGE_SLOT]
        )
      );
      
      try {
        const blockInfo = await slotToELBlock(
          process.env.SOURCE_CONSENSUS_RPC_URL!,
          l1Provider,
          slot
        );
        console.log(`Slot ${slot} maps to block ${blockInfo.number}`);
        
        // Try to generate the proof
        console.log(`Generating proof for deposit nonce ${nonce}...`);
        const proofs = await getStorageProof(
          l1Provider,
          L1_BRIDGE_ADDRESS,
          blockInfo.number,
          storageKey
        );
        console.log("✅ Proof generated successfully");
        console.log(`Account proof length: ${proofs.accountProof.length}`);
        console.log(`Storage proof length: ${proofs.storageProof.length}`);
        break;
      } catch (error) {
        console.error(`Error generating proof for slot ${slot}:`, error);
      }
    }
  }
}

checkDeposit()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });