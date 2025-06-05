// Check the new SP1-Helios mapping
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { JsonRpcProvider } from 'ethers';
import { slotToELBlock } from '../src/utils/slotHelper';

async function checkNewHelios() {
  try {
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const currentBlock = await l1Provider.getBlockNumber();
    
    console.log(`Current Ethereum block: ${currentBlock}`);
    
    // New SP1-Helios head
    const newHeliosHead = 7777536;
    
    try {
      const blockInfo = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, newHeliosHead);
      console.log(`New SP1-Helios head slot ${newHeliosHead} maps to Ethereum block ${blockInfo.number}`);
      console.log(`Gap: ${currentBlock - blockInfo.number} blocks behind`);
      
      // Check time difference
      const currentBlockData = await l1Provider.getBlock(currentBlock);
      const headBlockData = await l1Provider.getBlock(blockInfo.number);
      
      if (currentBlockData && headBlockData) {
        const timeDiff = currentBlockData.timestamp - headBlockData.timestamp;
        const hoursBehind = timeDiff / 3600;
        console.log(`Time gap: ${hoursBehind.toFixed(1)} hours behind`);
        
        if (hoursBehind < 1) {
          console.log('✅ SP1-Helios is current! Ready to process recent transactions.');
        } else if (hoursBehind < 24) {
          console.log('✅ SP1-Helios is recent enough to process transactions from today.');
        } else {
          console.log('⚠️ SP1-Helios is still behind, but much better than before.');
        }
      }
      
      // Check if it can process your transaction
      const yourTxBlock = 8476918;
      if (blockInfo.number >= yourTxBlock) {
        console.log(`✅ Can process your transaction from block ${yourTxBlock}!`);
      } else {
        console.log(`❌ Still cannot process your transaction from block ${yourTxBlock} (gap: ${yourTxBlock - blockInfo.number} blocks)`);
      }
      
    } catch (error: any) {
      console.error('Error mapping slot to block:', error.message);
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkNewHelios().catch(console.error);