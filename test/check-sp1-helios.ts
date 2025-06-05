// Check SP1-Helios status
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider } from 'ethers';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';

async function checkSP1Helios() {
  try {
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const bridgeCitreaAddress = process.env.CITREA_BRIDGE_ADDRESS!;
    
    // Get BridgeCitrea contract
    const bridgeCitrea = new Contract(bridgeCitreaAddress, BridgeCitreaAbi, l2Provider);
    
    // Get light client address from BridgeCitrea
    const lightClientAddress = await bridgeCitrea.getLightClient();
    console.log(`SP1-Helios address from BridgeCitrea: ${lightClientAddress}`);
    
    // Connect to SP1-Helios
    const helios = new Contract(lightClientAddress, SP1HeliosAbi, l2Provider);
    
    // Get current head
    const head = await helios.head();
    console.log(`Current head slot: ${head}`);
    
    // Get timestamps for multiple slots to check if it's updating
    console.log('\nChecking recent slots:');
    const currentHead = Number(head);
    for (let i = 0; i < 5; i++) {
      const slot = currentHead - i * 32;
      try {
        const timestamp = await helios.timestamps(slot);
        const stateRoot = await helios.headers(slot);
        if (timestamp > 0) {
          const date = new Date(Number(timestamp) * 1000);
          console.log(`Slot ${slot}: ${date.toISOString()} - Root: ${stateRoot ? stateRoot.substring(0, 10) + '...' : 'empty'}`);
        }
      } catch (e) {
        // Slot might not exist
      }
    }
    
    // Check minSlotFinality
    const minFinality = await bridgeCitrea.minSlotFinality();
    console.log(`\nMinimum slot finality: ${minFinality}`);
    console.log(`Latest finalized slot: ${currentHead - Number(minFinality)}`);
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkSP1Helios().catch(console.error);