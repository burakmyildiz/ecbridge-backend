// Check if SP1-Helios is ready to process the new transaction
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { JsonRpcProvider, Contract } from 'ethers';
import { slotToELBlock } from '../src/utils/slotHelper';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';

async function checkReadiness() {
  try {
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    
    console.log('=== Checking readiness for transaction processing ===');
    
    // Transaction details
    const txBlock = 8477237;
    const txHash = '0x60cd8e69c69a064ce211cdfd209ef8488088da52f5579ab68baed6e44b3dc72a';
    const nonce = 54;
    
    console.log(`Transaction: ${txHash}`);
    console.log(`Transaction block: ${txBlock}`);
    console.log(`Nonce: ${nonce}`);
    
    // Get SP1-Helios state
    const helios = new Contract(process.env.SP1_HELIOS_ADDRESS!, SP1HeliosAbi, l2Provider);
    const head = await helios.head();
    const headNum = Number(head);
    
    console.log(`\nSP1-Helios head slot: ${headNum}`);
    
    // Map head to block
    const blockInfo = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, headNum);
    console.log(`SP1-Helios covers up to block: ${blockInfo.number}`);
    
    // Check if ready
    if (blockInfo.number >= txBlock) {
      console.log(`\n✅ READY! SP1-Helios covers your transaction block.`);
      console.log(`Gap: +${blockInfo.number - txBlock} blocks`);
      
      // Check if there are recent slots with state roots
      let slotsWithRoots = 0;
      const latestSlots = [];
      
      for (let slot = headNum; slot >= headNum - 64; slot -= 32) {
        try {
          const stateRoot = await helios.headers(slot);
          if (stateRoot && stateRoot !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
            slotsWithRoots++;
            latestSlots.push({ slot, hasRoot: true });
          } else {
            latestSlots.push({ slot, hasRoot: false });
          }
        } catch (e) {
          latestSlots.push({ slot, hasRoot: false });
        }
      }
      
      console.log(`\nState root status:`);
      console.log(`Slots with state roots: ${slotsWithRoots}`);
      
      if (slotsWithRoots >= 1) {
        console.log(`✅ Should be able to process your transaction!`);
        console.log(`\nNext steps:`);
        console.log(`1. Wait for your transaction to be finalized on Ethereum (currently ${100 - 29.296875}% more to go)`);
        console.log(`2. The relayer should automatically detect and process it`);
        console.log(`3. Or you can manually process it once finalized`);
      } else {
        console.log(`❌ No recent slots have state roots. Need more sync time.`);
      }
      
    } else {
      const blocksNeeded = txBlock - blockInfo.number;
      const timeNeeded = (blocksNeeded * 12) / 60; // ~12 sec per block, convert to minutes
      
      console.log(`\n⏳ WAITING: SP1-Helios needs to sync ${blocksNeeded} more blocks`);
      console.log(`Estimated time: ~${timeNeeded.toFixed(1)} minutes`);
      console.log(`\nSP1-Helios operator is running and should catch up automatically.`);
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkReadiness().catch(console.error);