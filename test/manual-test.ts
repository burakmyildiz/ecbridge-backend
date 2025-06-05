// ECBridge/backend/test/manual-test.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import BridgeEthAbi from "../src/abi/BridgeEth.json";

async function manualTest() {
  console.log("🚀 Manual Bridge Test");
  
  const provider = new ethers.JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
  const wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY!, provider);
  
  const bridgeEth = new ethers.Contract(
    process.env.ETH_BRIDGE_ADDRESS!,
    BridgeEthAbi,
    wallet
  );

  // Test parameters
  const depositAmount = ethers.parseEther("0.00001");
  const recipientAddress = wallet.address; // Same address on Citrea for simplicity

  console.log(`\n💳 Wallet address: ${wallet.address}`);
  console.log(`💰 Deposit amount: ${ethers.formatEther(depositAmount)} ETH`);
  console.log(`📍 Recipient: ${recipientAddress}`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`💵 Current balance: ${ethers.formatEther(balance)} ETH`);

  if (balance < depositAmount) {
    console.error("❌ Insufficient balance for deposit");
    return;
  }

  // Execute deposit
  console.log("\n📤 Sending deposit transaction...");
  const tx = await bridgeEth.depositETH(recipientAddress, { 
    value: depositAmount,
    gasLimit: 200000 
  });
  
  console.log(`📝 Transaction hash: ${tx.hash}`);
  console.log("⏳ Waiting for confirmation...");
  
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block ${receipt.blockNumber}`);
  
  // Parse events
  const depositEvent = receipt.logs.find(
    (log: any) => log.topics[0] === ethers.id("DepositETH(address,address,uint256,uint256)")
  );
  
  if (depositEvent) {
    const iface = bridgeEth.interface;
    const decodedEvent = iface.parseLog({
      topics: depositEvent.topics as string[],
      data: depositEvent.data
    });
    
    if (decodedEvent) {
      console.log(`\n📦 Deposit Details:`);
      console.log(`   Nonce: ${decodedEvent.args.nonce}`);
      console.log(`   From: ${decodedEvent.args.from}`);
      console.log(`   To: ${decodedEvent.args.to}`);
      console.log(`   Amount: ${ethers.formatEther(decodedEvent.args.amount)} ETH`);
    }
  }
  
  console.log("\n🔍 Now check the backend logs to see if the relayer picked up this deposit");
  console.log("📡 The backend should process and submit proof to Citrea automatically");
}

manualTest().catch(console.error);