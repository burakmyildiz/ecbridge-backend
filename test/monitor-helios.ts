// Monitor SP1-Helios head to see if it's updating
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider } from 'ethers';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';

async function monitorHelios() {
  try {
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const helios = new Contract(process.env.SP1_HELIOS_ADDRESS!, SP1HeliosAbi, l2Provider);
    
    console.log('Monitoring SP1-Helios head updates...');
    console.log('Press Ctrl+C to stop\n');
    
    let lastHead = 0;
    let consecutiveNoUpdates = 0;
    
    const check = async () => {
      try {
        const head = await helios.head();
        const headNum = Number(head);
        
        const timestamp = new Date().toLocaleTimeString();
        
        if (headNum !== lastHead) {
          console.log(`${timestamp} - Head updated: ${lastHead} → ${headNum} (+${headNum - lastHead})`);
          lastHead = headNum;
          consecutiveNoUpdates = 0;
        } else {
          consecutiveNoUpdates++;
          console.log(`${timestamp} - Head unchanged: ${headNum} (${consecutiveNoUpdates} checks)`);
          
          if (consecutiveNoUpdates >= 5) {
            console.log('⚠️  SP1-Helios head hasn\'t updated in 5 checks. Operator may not be working.');
          }
        }
      } catch (error: any) {
        console.error(`Error checking head: ${error.message}`);
      }
    };
    
    // Initial check
    const initialHead = await helios.head();
    lastHead = Number(initialHead);
    console.log(`Initial head: ${lastHead}\n`);
    
    // Check every 30 seconds
    setInterval(check, 30000);
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

monitorHelios().catch(console.error);