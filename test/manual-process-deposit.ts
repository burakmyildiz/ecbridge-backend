// Manually trigger deposit processing to debug the issue
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';
import { getStorageProof } from '../src/utils/getStorageProof';
import { slotToELBlock } from '../src/utils/slotHelper';

async function manualProcessDeposit() {
  try {
    console.log('=== Manual Deposit Processing ===');
    
    // Setup providers and contracts
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const bridgeEth = new Contract(process.env.ETH_BRIDGE_ADDRESS!, BridgeEthAbi, l1Provider);
    const bridgeCitrea = new Contract(process.env.CITREA_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Wallet);
    
    // Get light client address and create contract
    const lightClientAddress = await bridgeCitrea.getLightClient();
    const helios = new Contract(lightClientAddress, SP1HeliosAbi, l2Provider);
    
    console.log('Light client address:', lightClientAddress);
    
    // Check SP1-Helios head
    const currentHead = await helios.head();
    const minSlotFinality = await bridgeCitrea.minSlotFinality();
    console.log(`SP1-Helios head: ${currentHead}`);
    console.log(`Min slot finality: ${minSlotFinality}`);
    console.log(`Latest finalized slot: ${Number(currentHead) - Number(minSlotFinality)}`);
    
    // Transaction details for nonce 53
    const nonce = 53;
    const txHash = '0xdd01f3263bb2cdaa67a48477f9942baf4c3fc4676c36a02afdf4f79b8b134c8a';
    const depositBlockNumber = 8476918;
    
    console.log(`\nProcessing nonce ${nonce} from block ${depositBlockNumber}...`);
    
    // Check if already processed
    const isProcessed = await bridgeCitrea.isProcessed(nonce);
    if (isProcessed) {
      console.log('✅ Already processed on L2');
      return;
    }
    
    // Get deposit data from L1
    const receipt = await l1Provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log('❌ Transaction not found');
      return;
    }
    
    // Parse deposit event
    let depositEvent;
    for (const log of receipt.logs) {
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
      console.log('❌ Deposit event not found');
      return;
    }
    
    const { amount, from, to } = depositEvent.args;
    console.log(`Deposit: ${amount} ETH from ${from} to ${to}`);
    
    // Try to find a suitable finalized slot
    console.log('\nFinding suitable finalized slot...');
    
    const latestFinalizedSlot = Number(currentHead) - Number(minSlotFinality);
    console.log(`Latest finalized slot: ${latestFinalizedSlot}`);
    
    // Try different slots to find one with a state root
    let suitableSlot = null;
    let stateRoot = null;
    
    for (let slot = latestFinalizedSlot; slot >= latestFinalizedSlot - 100; slot -= 32) {
      try {
        const slotStateRoot = await helios.headers(slot);
        if (slotStateRoot && slotStateRoot !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          const { number: blockNumber } = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, slot);
          
          // Check if this slot's block is after our deposit block
          if (blockNumber >= depositBlockNumber) {
            suitableSlot = slot;
            stateRoot = slotStateRoot;
            console.log(`Found suitable slot ${slot} with block ${blockNumber} and state root ${stateRoot.substring(0, 10)}...`);
            break;
          }
        }
      } catch (e: any) {
        console.log(`Slot ${slot} failed: ${e.message}`);
      }
    }
    
    if (!suitableSlot) {
      console.log('❌ No suitable finalized slot found');
      return;
    }
    
    // Generate proof
    console.log('\nGenerating MPT proof...');
    const { number: stateBlockNumber } = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, suitableSlot);
    
    const DEPOSITS_STORAGE_SLOT = BigInt(3);
    const storageKey = require('ethers').keccak256(
      require('ethers').AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [nonce, DEPOSITS_STORAGE_SLOT]
      )
    );
    
    const proofs = await getStorageProof(
      l1Provider,
      process.env.ETH_BRIDGE_ADDRESS!,
      stateBlockNumber,
      storageKey
    );
    
    console.log('✅ Proof generated successfully');
    
    // Submit to L2
    console.log('\nSubmitting to L2...');
    const depositStruct = {
      from,
      to,
      token: '0x0000000000000000000000000000000000000000', // ETH
      amount,
      nonce
    };
    
    const gasEstimate = await bridgeCitrea.finaliseDeposit.estimateGas(
      depositStruct,
      suitableSlot,
      proofs.accountProof,
      proofs.storageProof
    );
    
    console.log(`Gas estimate: ${gasEstimate}`);
    
    const tx = await bridgeCitrea.finaliseDeposit(
      depositStruct,
      suitableSlot,
      proofs.accountProof,
      proofs.storageProof,
      { gasLimit: gasEstimate + BigInt(50000) }
    );
    
    console.log(`Transaction submitted: ${tx.hash}`);
    
    const txReceipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${txReceipt.blockNumber}`);
    console.log('✅ Deposit successfully processed!');
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.data) {
      console.error('Error data:', error.data);
    }
  }
}

manualProcessDeposit().catch(console.error);