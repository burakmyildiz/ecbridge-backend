// Check what block the current SP1-Helios head maps to
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { JsonRpcProvider, Contract } from 'ethers';
import { slotToELBlock } from '../src/utils/slotHelper';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';

async function checkSlotMapping() {
  try {
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const currentBlock = await l1Provider.getBlockNumber();
    
    console.log(`Current Ethereum block: ${currentBlock}`);
    console.log('Mapping current SP1-Helios head to Ethereum block...');
    
    // Get the actual current head from the new SP1-Helios contract
    const helios = new Contract(process.env.SP1_HELIOS_ADDRESS!, SP1HeliosAbi, l2Provider);
    const heliosHead = await helios.head();
    console.log(`Getting head from SP1-Helios at ${process.env.SP1_HELIOS_ADDRESS}: ${heliosHead}`);
    
    try {
      const blockInfo = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, heliosHead);
      console.log(`SP1-Helios head slot ${heliosHead} maps to Ethereum block ${blockInfo.number}`);
      console.log(`Gap: ${currentBlock - blockInfo.number} blocks behind`);
      
      // Check time difference
      const currentBlockData = await l1Provider.getBlock(currentBlock);
      const headBlockData = await l1Provider.getBlock(blockInfo.number);
      
      if (currentBlockData && headBlockData) {
        const timeDiff = currentBlockData.timestamp - headBlockData.timestamp;
        const hoursBehind = timeDiff / 3600;
        console.log(`Time gap: ${hoursBehind.toFixed(1)} hours behind`);
      }
      
    } catch (error: any) {
      console.error('Error mapping slot to block:', error.message);
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkSlotMapping().catch(console.error);
