// backend/scripts/check-finalized-slots.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { slotToELBlock } from "../src/utils/slotHelper";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function checkFinalizedSlots() {
  console.log("🔍 Checking finalized slots with state roots...");
  
  const citreaProvider = new ethers.JsonRpcProvider(process.env.CITREA_RPC_URL);
  const ethProvider = new ethers.JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
  const bridgeAddress = process.env.CITREA_BRIDGE_ADDRESS;
  const heliosAddress = process.env.SP1_HELIOS_ADDRESS;
  const consensusRpc = process.env.SOURCE_CONSENSUS_RPC_URL;
  
  if (!bridgeAddress || !heliosAddress || !consensusRpc) {
    console.error("❌ Missing required addresses in .env");
    return;
  }
  
  const heliosAbi = [
    "function head() view returns (uint256)",
    "function executionStateRoots(uint256) view returns (bytes32)"
  ];
  
  const bridgeAbi = [
    "function minSlotFinality() view returns (uint256)"
  ];
  
  const helios = new ethers.Contract(heliosAddress, heliosAbi, citreaProvider);
  const bridge = new ethers.Contract(bridgeAddress, bridgeAbi, citreaProvider);
  
  try {
    const head = await helios.head();
    const minSlotFinality = await bridge.minSlotFinality();
    
    console.log(`Current Head Slot: ${head}`);
    console.log(`Min Slot Finality: ${minSlotFinality}`);
    console.log(`Latest Finalized Slot: ${head - minSlotFinality}`);
    
    const depositBlocks = [8254948, 8255504, 8255567];
    console.log(`\nDeposit blocks to check: ${depositBlocks.join(', ')}`);
    
    // Check slots with state roots working backwards
    console.log("\nChecking slots with state roots (every 32 slots):");
    let foundSuitableSlot = false;
    
    for (let i = 0; i < 10; i++) {
      const slot = Number(head) - (i * 32);
      if (slot < 0) break;
      
      const stateRoot = await helios.executionStateRoots(slot);
      if (stateRoot !== ethers.ZeroHash) {
        const isFinalized = slot <= Number(head) - Number(minSlotFinality);
        console.log(`\nSlot ${slot}: ${isFinalized ? '✅ FINALIZED' : '❌ NOT FINALIZED'}`);
        console.log(`  State Root: ${stateRoot.substring(0, 10)}...`);
        
        try {
          const blockInfo = await slotToELBlock(consensusRpc!, ethProvider, slot);
          console.log(`  Maps to block: ${blockInfo.number}`);
          
          // Check if this slot covers any of the deposit blocks
          let coversDeposits: number[] = [];
          for (const depositBlock of depositBlocks) {
            if (blockInfo.number >= depositBlock) {
              coversDeposits.push(depositBlock);
            }
          }
          
          if (coversDeposits.length > 0) {
            console.log(`  Covers deposits in blocks: ${coversDeposits.join(', ')}`);
            if (isFinalized) {
              console.log(`  🎯 This finalized slot could be used for deposits!`);
              foundSuitableSlot = true;
            }
          } else {
            console.log(`  Does not cover any deposit blocks`);
          }
        } catch (error) {
          console.log(`  Could not fetch block mapping: ${(error as Error).message}`);
        }
      }
    }
    
    if (!foundSuitableSlot) {
      console.log("\n❌ No suitable finalized slot found that covers the deposit blocks");
      console.log("The system needs to wait for more slots to become finalized");
    }
    
    // Calculate when slots will become finalized
    console.log("\n📅 Finalization timeline:");
    const slotsNeeded = Number(minSlotFinality);
    const secondsPerSlot = 12; // Based on your system
    const minutesNeeded = (slotsNeeded * secondsPerSlot) / 60;
    console.log(`Slots need to wait ${slotsNeeded} slots (${minutesNeeded} minutes) to become finalized`);
    
  } catch (error) {
    console.error("Error checking finalized slots:", error);
  }
}

checkFinalizedSlots().catch(console.error);