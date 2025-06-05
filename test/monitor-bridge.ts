// ECBridge/backend/test/monitor-bridge.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import BridgeEthAbi from "../src/abi/BridgeEth.json";
import BridgeCitreaAbi from "../src/abi/BridgeCitrea.json";

async function monitorBridge() {
  console.log("🔍 Starting bridge monitor...");

  const ethProvider = new ethers.JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
  const citreaProvider = new ethers.JsonRpcProvider(process.env.CITREA_RPC_URL);

  const bridgeEth = new ethers.Contract(
    process.env.ETH_BRIDGE_ADDRESS!,
    BridgeEthAbi,
    ethProvider
  );

  const bridgeCitrea = new ethers.Contract(
    process.env.CITREA_BRIDGE_ADDRESS!,
    BridgeCitreaAbi,
    citreaProvider
  );

  // Keep track of last processed blocks
  let lastEthBlock = await ethProvider.getBlockNumber();
  let lastCitreaBlock = await citreaProvider.getBlockNumber();

  console.log("👀 Monitoring started... Press Ctrl+C to stop");
  console.log(`Starting from ETH block: ${lastEthBlock}`);
  console.log(`Starting from Citrea block: ${lastCitreaBlock}`);

  // Poll for events
  setInterval(async () => {
    try {
      // Monitor Ethereum deposits
      const currentEthBlock = await ethProvider.getBlockNumber();
      
      if (currentEthBlock > lastEthBlock) {
        const ethDepositFilter = bridgeEth.filters.DepositETH();
        const erc20DepositFilter = bridgeEth.filters.DepositERC20();
        
        const ethEvents = await bridgeEth.queryFilter(
          ethDepositFilter,
          lastEthBlock + 1,
          currentEthBlock
        );
        
        const erc20Events = await bridgeEth.queryFilter(
          erc20DepositFilter,
          lastEthBlock + 1,
          currentEthBlock
        );
        
        // Process ETH deposits
        for (const event of ethEvents) {
          const parsedLog = bridgeEth.interface.parseLog({
            topics: event.topics as string[],
            data: event.data
          });
          
          if (parsedLog) {
            const { from, to, amount, nonce } = parsedLog.args;
            console.log("\n🏦 ETH Deposit detected!");
            console.log(`   From: ${from}`);
            console.log(`   To: ${to}`);
            console.log(`   Amount: ${ethers.formatEther(amount)} ETH`);
            console.log(`   Nonce: ${nonce}`);
            console.log(`   TX: ${event.transactionHash}`);
            console.log(`   Block: ${event.blockNumber}`);
          }
        }
        
        // Process ERC20 deposits
        for (const event of erc20Events) {
          const parsedLog = bridgeEth.interface.parseLog({
            topics: event.topics as string[],
            data: event.data
          });
          
          if (parsedLog) {
            const { token, from, to, amount, nonce } = parsedLog.args;
            console.log("\n💰 ERC20 Deposit detected!");
            console.log(`   Token: ${token}`);
            console.log(`   From: ${from}`);
            console.log(`   To: ${to}`);
            console.log(`   Amount: ${amount}`);
            console.log(`   Nonce: ${nonce}`);
            console.log(`   TX: ${event.transactionHash}`);
            console.log(`   Block: ${event.blockNumber}`);
          }
        }
        
        lastEthBlock = currentEthBlock;
      }

      // Monitor Citrea finalization
      const currentCitreaBlock = await citreaProvider.getBlockNumber();
      
      if (currentCitreaBlock > lastCitreaBlock) {
        const finalizedFilter = bridgeCitrea.filters.Finalised();
        
        const finalizedEvents = await bridgeCitrea.queryFilter(
          finalizedFilter,
          lastCitreaBlock + 1,
          currentCitreaBlock
        );
        
        for (const event of finalizedEvents) {
          const parsedLog = bridgeCitrea.interface.parseLog({
            topics: event.topics as string[],
            data: event.data
          });
          
          if (parsedLog) {
            const { token, to, amount, nonce } = parsedLog.args;
            console.log("\n✅ Deposit finalized on Citrea!");
            console.log(`   Token: ${token}`);
            console.log(`   To: ${to}`);
            console.log(`   Amount: ${amount}`);
            console.log(`   Nonce: ${nonce}`);
            console.log(`   TX: ${event.transactionHash}`);
            console.log(`   Block: ${event.blockNumber}`);
          }
        }
        
        lastCitreaBlock = currentCitreaBlock;
      }
    } catch (error) {
      console.error("Error in monitoring loop:", error);
    }
  }, 5000); // Poll every 5 seconds
}

monitorBridge().catch(console.error);