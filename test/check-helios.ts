// backend/scripts/check-helios.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { slotToELBlock } from "../src/utils/slotHelper";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function checkHelios() {
  console.log("🔍 Checking SP1 Helios status...");
  
  const citreaProvider = new ethers.JsonRpcProvider(process.env.CITREA_RPC_URL);
  const ethProvider = new ethers.JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
  const heliosAddress = process.env.SP1_HELIOS_ADDRESS;
  const consensusRpc = process.env.SOURCE_CONSENSUS_RPC_URL;
  
  if (!heliosAddress) {
    console.error("❌ SP1_HELIOS_ADDRESS not set in .env");
    return;
  }
  
  if (!consensusRpc) {
    console.error("❌ SOURCE_CONSENSUS_RPC_URL not set in .env");
    return;
  }
  
  const heliosAbi = [
    "function head() view returns (uint256)",
    "function executionStateRoots(uint256) view returns (bytes32)",
    "function getCurrentEpoch() view returns (uint256)",
    "function SLOTS_PER_EPOCH() view returns (uint256)",
    "function SECONDS_PER_SLOT() view returns (uint256)"
  ];
  
  const helios = new ethers.Contract(heliosAddress, heliosAbi, citreaProvider);
  
  try {
    const head = await helios.head();
    const currentEpoch = await helios.getCurrentEpoch();
    const slotsPerEpoch = await helios.SLOTS_PER_EPOCH();
    const secondsPerSlot = await helios.SECONDS_PER_SLOT();
    
    console.log("SP1 Helios Status:");
    console.log("------------------");
    console.log(`Current Head Slot: ${head}`);
    console.log(`Current Epoch: ${currentEpoch}`);
    console.log(`Slots per Epoch: ${slotsPerEpoch}`);
    console.log(`Seconds per Slot: ${secondsPerSlot}`);
    
    // Check execution state root for head slot
    const stateRoot = await helios.executionStateRoots(head);
    console.log(`Head State Root: ${stateRoot === ethers.ZeroHash ? "Not stored" : stateRoot}`);
    
    // Use the proper slot-to-block conversion
    let actualBlock = "Unknown";
    try {
      const blockInfo = await slotToELBlock(consensusRpc!, ethProvider, Number(head));
      actualBlock = blockInfo.number.toString();
      console.log(`Head maps to Ethereum Block: ${actualBlock}`);
    } catch (error) {
      console.log(`Could not fetch block for slot ${head}: ${(error as Error).message}`);
    }
    
    // Check actual Ethereum block
    const currentBlock = await ethProvider.getBlockNumber();
    console.log(`Current Ethereum Block: ${currentBlock}`);
    
    if (actualBlock !== "Unknown") {
      const blockDiff = currentBlock - parseInt(actualBlock);
      console.log(`Block Difference: ${blockDiff}`);
      
      if (blockDiff < 100) {
        console.log("✅ SP1 Helios is synced!");
      } else {
        console.log(`⚠️ SP1 Helios maps to block ${actualBlock}, which is ${blockDiff} blocks behind`);
      }
    }
    
    // Check recent slots for state roots
    console.log("\nChecking recent slots for state roots:");
    for (let i = 0; i < 5; i++) {
      const slot = Number(head) - i;
      const stateRoot = await helios.executionStateRoots(slot);
      if (stateRoot !== ethers.ZeroHash) {
        console.log(`Slot ${slot}: Has state root`);
        try {
          const blockInfo = await slotToELBlock(consensusRpc!, ethProvider, slot);
          console.log(`  └─ Maps to block ${blockInfo.number}`);
        } catch (error) {
          console.log(`  └─ Could not fetch block mapping: ${(error as Error).message}`);
        }
      } else {
        console.log(`Slot ${slot}: No state root`);
      }
    }
  } catch (error) {
    console.error("Error checking SP1 Helios:", error);
  }
}

checkHelios().catch(console.error);