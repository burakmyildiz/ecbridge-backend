// Manually process nonce 53 with the new contracts
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';
import { getStorageProof } from '../src/utils/getStorageProof';
import { slotToELBlock } from '../src/utils/slotHelper';

async function manualProcess() {
  try {
    console.log('=== Manual Processing Nonce 53 with New Contracts ===');
    
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const bridgeEth = new Contract(process.env.ETH_BRIDGE_ADDRESS!, BridgeEthAbi, l1Provider);
    const bridgeCitrea = new Contract(process.env.CITREA_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Wallet);
    const helios = new Contract(process.env.SP1_HELIOS_ADDRESS!, SP1HeliosAbi, l2Provider);
    
    console.log('Using new BridgeCitrea:', process.env.CITREA_BRIDGE_ADDRESS);
    console.log('Using new SP1-Helios:', process.env.SP1_HELIOS_ADDRESS);
    
    // Check if nonce 53 is already processed
    const isProcessed = await bridgeCitrea.isProcessed(53);
    console.log(`Nonce 53 processed in new contract: ${isProcessed}`);
    
    if (isProcessed) {
      console.log('✅ Already processed in new contract!');
      return;
    }
    
    // Get SP1-Helios state
    const head = await helios.head();
    const minFinality = await bridgeCitrea.minSlotFinality();
    console.log(`SP1-Helios head: ${head}`);
    console.log(`Min finality: ${minFinality}`);
    console.log(`Latest finalized slot: ${Number(head) - Number(minFinality)}`);
    
    // Check if we can find a suitable slot
    const latestFinalizedSlot = Number(head) - Number(minFinality);
    const depositBlockNumber = 8476918;
    
    // Try to find a suitable slot
    let suitableSlot = null;
    let stateRoot = null;
    
    for (let slot = latestFinalizedSlot; slot >= latestFinalizedSlot - 200; slot -= 32) {
      try {
        const slotStateRoot = await helios.headers(slot);
        if (slotStateRoot && slotStateRoot !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          const { number: blockNumber } = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, slot);
          
          if (blockNumber >= depositBlockNumber) {
            suitableSlot = slot;
            stateRoot = slotStateRoot;
            console.log(`✅ Found suitable slot ${slot} with block ${blockNumber}`);
            break;
          } else {
            console.log(`Slot ${slot} maps to block ${blockNumber} (too old)`);
          }
        }
      } catch (e: any) {
        console.log(`Slot ${slot} failed: ${e.message}`);
      }
    }
    
    if (!suitableSlot) {
      console.log('❌ No suitable slot found. SP1-Helios needs to sync further.');
      
      // Show what we need
      const currentBlock = await l1Provider.getBlockNumber();
      console.log(`Current block: ${currentBlock}`);
      console.log(`Deposit block: ${depositBlockNumber}`);
      console.log(`Need SP1-Helios to reach at least block ${depositBlockNumber}`);
      return;
    }
    
    // Process the deposit
    console.log('\n🚀 Processing deposit...');
    
    // Get deposit data from L1
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
      console.log('❌ Deposit event not found');
      return;
    }
    
    const { nonce, amount, from, to } = depositEvent.args;
    console.log(`Processing deposit: ${amount} ETH from ${from} to ${to}, nonce ${nonce}`);
    
    // Generate proof
    console.log('Generating MPT proof...');
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
    
    console.log('✅ Proof generated');
    
    // Submit to new bridge
    const depositStruct = {
      from,
      to,
      token: '0x0000000000000000000000000000000000000000',
      amount,
      nonce
    };
    
    console.log('Submitting to new BridgeCitrea...');
    
    try {
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
      
      console.log(`✅ Transaction submitted: ${tx.hash}`);
      
      const txReceipt = await tx.wait();
      console.log(`✅ Transaction confirmed in block ${txReceipt!.blockNumber}`);
      console.log('🎉 Deposit successfully processed!');
      
    } catch (error: any) {
      console.error('❌ Transaction failed:', error.message);
      if (error.data) {
        console.error('Error data:', error.data);
      }
    }
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

manualProcess().catch(console.error);