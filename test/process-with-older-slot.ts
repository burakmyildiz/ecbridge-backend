// Try processing with an older slot that SP1-Helios definitely has
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';
import { getStorageProof } from '../src/utils/getStorageProof';
import { slotToELBlock } from '../src/utils/slotHelper';

async function processWithOlderSlot() {
  try {
    console.log('=== Trying older SP1-Helios slots ===');
    
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const bridgeEth = new Contract(process.env.ETH_BRIDGE_ADDRESS!, BridgeEthAbi, l1Provider);
    const bridgeCitrea = new Contract(process.env.CITREA_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Wallet);
    const helios = new Contract(process.env.SP1_HELIOS_ADDRESS!, SP1HeliosAbi, l2Provider);
    
    const depositBlockNumber = 8476918;
    console.log(`Need to process deposit from block ${depositBlockNumber}`);
    
    // Try slots going back further to find one that works
    const head = await helios.head();
    const minFinality = await bridgeCitrea.minSlotFinality();
    const latestFinalizedSlot = Number(head) - Number(minFinality);
    
    console.log(`Trying slots starting from ${latestFinalizedSlot} going back...`);
    
    for (let slot = latestFinalizedSlot; slot >= latestFinalizedSlot - 1000; slot -= 32) {
      try {
        console.log(`\nTrying slot ${slot}...`);
        
        // Check if this slot has a state root
        const slotStateRoot = await helios.headers(slot);
        if (!slotStateRoot || slotStateRoot === '0x0000000000000000000000000000000000000000000000000000000000000000') {
          console.log(`  Slot ${slot} has no state root`);
          continue;
        }
        
        // Map to execution block
        const { number: blockNumber } = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, slot);
        console.log(`  Slot ${slot} maps to block ${blockNumber}`);
        
        if (blockNumber < depositBlockNumber) {
          console.log(`  Block ${blockNumber} is before deposit block ${depositBlockNumber}, skipping`);
          continue;
        }
        
        console.log(`  ✓ Slot ${slot} (block ${blockNumber}) is suitable, testing proof generation...`);
        
        // Try to generate proof with this slot
        const DEPOSITS_STORAGE_SLOT = BigInt(3);
        const nonce = 53;
        const storageKey = require('ethers').keccak256(
          require('ethers').AbiCoder.defaultAbiCoder().encode(
            ["uint256", "uint256"],
            [nonce, DEPOSITS_STORAGE_SLOT]
          )
        );
        
        try {
          const proofs = await getStorageProof(
            l1Provider,
            process.env.ETH_BRIDGE_ADDRESS!,
            blockNumber,
            storageKey
          );
          
          console.log(`  ✅ Proof generation succeeded for slot ${slot}!`);
          
          // Get deposit details
          const txHash = '0xdd01f3263bb2cdaa67a48477f9942baf4c3fc4676c36a02afdf4f79b8b134c8a';
          const receipt = await l1Provider.getTransactionReceipt(txHash);
          
          let depositEvent;
          for (const log of receipt!.logs) {
            try {
              const parsed = bridgeEth.interface.parseLog({
                topics: [...log.topics],
                data: log.data
              });
              if (parsed && parsed.name === 'DepositETH') {
                depositEvent = parsed;
                break;
              }
            } catch (e) {}
          }
          
          if (!depositEvent) {
            console.log('  ❌ Deposit event not found');
            continue;
          }
          
          const { amount, from, to } = depositEvent.args;
          const depositStruct = {
            from,
            to,
            token: '0x0000000000000000000000000000000000000000',
            amount,
            nonce
          };
          
          console.log(`  Processing deposit: ${amount} ETH from ${from} to ${to}`);
          
          // Submit transaction
          const gasEstimate = await bridgeCitrea.finaliseDeposit.estimateGas(
            depositStruct,
            slot,
            proofs.accountProof,
            proofs.storageProof
          );
          
          console.log(`  Gas estimate: ${gasEstimate}`);
          
          const tx = await bridgeCitrea.finaliseDeposit(
            depositStruct,
            slot,
            proofs.accountProof,
            proofs.storageProof,
            { gasLimit: gasEstimate + BigInt(50000) }
          );
          
          console.log(`\n🚀 Transaction submitted: ${tx.hash}`);
          console.log('Waiting for confirmation...');
          
          const txReceipt = await tx.wait();
          console.log(`\n🎉 SUCCESS! Transaction confirmed in block ${txReceipt!.blockNumber}`);
          console.log(`Your deposit has been processed using slot ${slot}!`);
          
          return; // Success, exit
          
        } catch (proofError: any) {
          console.log(`  ❌ Proof generation failed for slot ${slot}: ${proofError.message}`);
          continue; // Try next slot
        }
        
      } catch (slotError: any) {
        console.log(`  ❌ Error with slot ${slot}: ${slotError.message}`);
        continue;
      }
    }
    
    console.log('\n❌ Could not find any working slot. SP1-Helios may need more time to sync.');
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

processWithOlderSlot().catch(console.error);