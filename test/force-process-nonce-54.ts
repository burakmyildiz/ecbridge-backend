// Force process nonce 54 using the exact relayer logic
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';
import { getStorageProof } from '../src/utils/getStorageProof';
import { slotToELBlock } from '../src/utils/slotHelper';
import { getBestFinalityStatus } from '../src/utils/consensus-utils';
import { TransactionModel, TransactionStatus, Chain } from '../src/models';
import mongoose from 'mongoose';

async function forceProcessNonce54() {
  try {
    console.log('=== Force Processing Nonce 54 ===');
    
    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ethcitrea');
    
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const bridgeEth = new Contract(process.env.ETH_BRIDGE_ADDRESS!, BridgeEthAbi, l1Provider);
    const bridgeCitrea = new Contract(process.env.CITREA_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Wallet);
    const helios = new Contract(process.env.SP1_HELIOS_ADDRESS!, SP1HeliosAbi, l2Provider);
    
    const nonce = 54;
    const txHash = '0x60cd8e69c69a064ce211cdfd209ef8488088da52f5579ab68baed6e44b3dc72a';
    const depositBlockNumber = 8477237;
    
    // Check if already processed
    const isProcessed = await bridgeCitrea.isProcessed(nonce);
    if (isProcessed) {
      console.log('✅ Already processed!');
      return;
    }
    
    console.log(`Processing nonce ${nonce} from block ${depositBlockNumber}...`);
    
    // Get transaction and update database
    let transaction = await TransactionModel.findOne({ txHash });
    if (!transaction) {
      console.log('❌ Transaction not found in database');
      return;
    }
    
    // Check finality
    const finalityStatus = await getBestFinalityStatus(depositBlockNumber, transaction, l1Provider);
    console.log(`Finality status: ${finalityStatus.phase} (${finalityStatus.pct}%)`);
    
    if (finalityStatus.phase !== "FINALIZED" && finalityStatus.phase !== "MINTED") {
      console.log('❌ Transaction not yet finalized');
      return;
    }
    
    // Get SP1-Helios state
    const currentHead = await helios.head();
    const minSlotFinality = await bridgeCitrea.minSlotFinality();
    const latestFinalizedSlot = Number(currentHead) - Number(minSlotFinality);
    
    console.log(`SP1-Helios head: ${currentHead}`);
    console.log(`Latest finalized slot: ${latestFinalizedSlot}`);
    
    // Find suitable slot
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
          }
        }
      } catch (e: any) {
        console.log(`Slot ${slot} failed: ${e.message}`);
      }
    }
    
    if (!suitableSlot) {
      console.log('❌ No suitable slot found');
      return;
    }
    
    // Update transaction status
    transaction.status = TransactionStatus.PROOF_GENERATING;
    transaction.timestamps.proofStarted = new Date();
    await transaction.save();
    console.log('Updated status to PROOF_GENERATING');
    
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
    
    // Update status
    transaction.status = TransactionStatus.PROOF_GENERATED;
    transaction.timestamps.proofGenerated = new Date();
    await transaction.save();
    console.log('Updated status to PROOF_GENERATED');
    
    // Get deposit details
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
    
    const { amount, from, to } = depositEvent.args;
    const depositStruct = {
      from,
      to,
      token: '0x0000000000000000000000000000000000000000',
      amount,
      nonce
    };
    
    // Update status
    transaction.status = TransactionStatus.SUBMITTED;
    transaction.timestamps.submitted = new Date();
    await transaction.save();
    console.log('Updated status to SUBMITTED');
    
    // Submit transaction
    console.log('Submitting to L2...');
    
    const gasEstimate = await bridgeCitrea.finaliseDeposit.estimateGas(
      depositStruct,
      suitableSlot,
      proofs.accountProof,
      proofs.storageProof
    );
    
    const tx = await bridgeCitrea.finaliseDeposit(
      depositStruct,
      suitableSlot,
      proofs.accountProof,
      proofs.storageProof,
      { gasLimit: gasEstimate + BigInt(50000) }
    );
    
    console.log(`🚀 Transaction submitted: ${tx.hash}`);
    transaction.destinationTxHash = tx.hash;
    await transaction.save();
    
    const txReceipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${txReceipt!.blockNumber}`);
    
    // Final status update
    transaction.status = TransactionStatus.CONFIRMED;
    transaction.timestamps.confirmed = new Date();
    await transaction.save();
    console.log('🎉 SUCCESS! Transaction processed and confirmed!');
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.data) {
      console.error('Error data:', error.data);
    }
  } finally {
    await mongoose.disconnect();
  }
}

forceProcessNonce54().catch(console.error);