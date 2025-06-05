// ECBridge/backend/test/bridge-e2e-test.ts
import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Contract ABIs
import BridgeEthAbi from "../src/abi/BridgeEth.json";
import BridgeCitreaAbi from "../src/abi/BridgeCitrea.json";
import ERC20Abi from "../src/abi/ERC20.json";
import WrappedERC20Abi from "../src/abi/WrappedERC20.json";

interface TestConfig {
  ethRpcUrl: string;
  citreaRpcUrl: string;
  ethBridgeAddress: string;
  citreaBridgeAddress: string;
  ethPrivateKey: string;
  citreaPrivateKey: string;
  apiUrl: string;
}

class BridgeE2ETest {
  private config: TestConfig;
  private ethProvider: ethers.JsonRpcProvider;
  private citreaProvider: ethers.JsonRpcProvider;
  private ethSigner: ethers.Wallet;
  private citreaSigner: ethers.Wallet;
  private bridgeEth: ethers.Contract;
  private bridgeCitrea: ethers.Contract;

  constructor() {
    this.config = {
      ethRpcUrl: process.env.ETH_EXE_RPC_URL!,
      citreaRpcUrl: process.env.CITREA_RPC_URL!,
      ethBridgeAddress: process.env.ETH_BRIDGE_ADDRESS!,
      citreaBridgeAddress: process.env.CITREA_BRIDGE_ADDRESS!,
      ethPrivateKey: process.env.ETH_PRIVATE_KEY!,
      citreaPrivateKey: process.env.CITREA_PRIVATE_KEY!,
      apiUrl: `http://localhost:${process.env.PORT}${process.env.API_BASE_PATH}`
    };

    this.ethProvider = new ethers.JsonRpcProvider(this.config.ethRpcUrl);
    this.citreaProvider = new ethers.JsonRpcProvider(this.config.citreaRpcUrl);
    this.ethSigner = new ethers.Wallet(this.config.ethPrivateKey, this.ethProvider);
    this.citreaSigner = new ethers.Wallet(this.config.citreaPrivateKey, this.citreaProvider);

    this.bridgeEth = new ethers.Contract(
      this.config.ethBridgeAddress,
      BridgeEthAbi,
      this.ethSigner
    );

    this.bridgeCitrea = new ethers.Contract(
      this.config.citreaBridgeAddress,
      BridgeCitreaAbi,
      this.citreaSigner
    );
  }

  async checkSystemStatus(): Promise<void> {
    console.log("🔍 Checking system status...");
    try {
      const response = await axios.get(`${this.config.apiUrl}/status`);
      console.log("✅ System status:", response.data);
      
      if (!response.data.ethereum.connected || !response.data.citrea.connected) {
        throw new Error("System not fully connected");
      }
    } catch (error) {
      console.error("❌ System status check failed:", error);
      throw error;
    }
  }

  async testETHDeposit(): Promise<void> {
    console.log("\n🏦 Testing ETH deposit...");
    
    const depositAmount = ethers.parseEther("0.00001");
    const recipientAddress = this.citreaSigner.address;
    
    console.log(`📤 Depositing ${ethers.formatEther(depositAmount)} ETH`);
    console.log(`👤 Recipient on Citrea: ${recipientAddress}`);

    // Get initial balances
    const initialEthBalance = await this.ethProvider.getBalance(this.ethSigner.address);
    console.log(`💰 Initial ETH balance: ${ethers.formatEther(initialEthBalance)}`);

    // Execute deposit
    const tx = await this.bridgeEth.depositETH(recipientAddress, { value: depositAmount });
    console.log(`📝 Deposit TX hash: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`✅ Deposit confirmed in block ${receipt.blockNumber}`);

    // Find the deposit event
    const depositEvent = receipt.logs.find(
      (log: any) => log.topics[0] === ethers.id("DepositETH(address,address,uint256,uint256)")
    );
    
    if (!depositEvent) {
      throw new Error("DepositETH event not found");
    }

    const decodedEvent = this.bridgeEth.interface.parseLog({
      topics: depositEvent.topics,
      data: depositEvent.data
    });

    const nonce = decodedEvent?.args?.nonce;
    console.log(`🔢 Deposit nonce: ${nonce}`);

    // Notify backend about the deposit
    await axios.post(`${this.config.apiUrl}/bridge/initiate`, {
      fromChain: "ethereum",
      toChain: "citrea",
      token: ethers.ZeroAddress,
      amount: depositAmount.toString(),
      sender: this.ethSigner.address,
      recipient: recipientAddress,
      txHash: tx.hash
    });

    // Monitor transaction status
    await this.monitorTransaction(tx.hash, nonce, depositAmount, recipientAddress);
  }

  async monitorTransaction(
    txHash: string, 
    nonce: bigint, 
    amount: bigint, 
    recipient: string
  ): Promise<void> {
    console.log("\n⏳ Monitoring transaction progress...");
    
    const maxAttempts = 30;
    const delayMs = 10000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await axios.get(`${this.config.apiUrl}/bridge/status/${txHash}`);
        const status = response.data.status;
        
        console.log(`🔄 Attempt ${attempt}/${maxAttempts} - Status: ${status}`);

        if (status === "confirmed") {
          console.log("✅ Bridge transaction confirmed!");
          
          // Verify the tokens were minted on Citrea
          await this.verifyMint(recipient, amount);
          return;
        } else if (status === "failed") {
          throw new Error(`Transaction failed: ${response.data.error}`);
        }

        // Check proof status
        const proofResponse = await axios.get(`${this.config.apiUrl}/proof/${txHash}`);
        console.log(`🔐 Proof status: ${proofResponse.data.status}`);

        await new Promise(resolve => setTimeout(resolve, delayMs));
      } catch (error) {
        console.error(`❌ Error checking status:`, error);
      }
    }

    throw new Error("Transaction monitoring timeout");
  }

  async verifyMint(recipient: string, expectedAmount: bigint): Promise<void> {
    console.log("\n🔍 Verifying tokens minted on Citrea...");
    
    // Get wrapped ETH address
    const canonicalETH = ethers.ZeroAddress;
    const wrappedETH = await this.bridgeCitrea.canonicalToWrapped(canonicalETH);
    console.log(`📦 Wrapped ETH address: ${wrappedETH}`);

    // Check balance
    const wrappedContract = new ethers.Contract(
      wrappedETH,
      WrappedERC20Abi,
      this.citreaProvider
    );

    const balance = await wrappedContract.balanceOf(recipient);
    console.log(`💰 Wrapped ETH balance: ${ethers.formatEther(balance)}`);

    if (balance >= expectedAmount) {
      console.log("✅ Tokens successfully minted on Citrea!");
    } else {
      throw new Error(`Expected ${ethers.formatEther(expectedAmount)}, got ${ethers.formatEther(balance)}`);
    }
  }

  async checkSP1HeliosStatus(): Promise<void> {
    console.log("\n🔍 Checking SP1 Helios status...");
    
    const lightClientAddr = await this.bridgeCitrea.getLightClient();
    console.log(`📡 Light client address: ${lightClientAddr}`);

    const SP1HeliosAbi = [
      "function head() view returns (uint256)",
      "function getCurrentEpoch() view returns (uint256)",
      "function SLOTS_PER_EPOCH() view returns (uint256)"
    ];

    const lightClient = new ethers.Contract(
      lightClientAddr,
      SP1HeliosAbi,
      this.citreaProvider
    );

    const head = await lightClient.head();
    const currentEpoch = await lightClient.getCurrentEpoch();
    const slotsPerEpoch = await lightClient.SLOTS_PER_EPOCH();

    console.log(`🎯 Current head slot: ${head}`);
    console.log(`⏰ Current epoch: ${currentEpoch}`);
    console.log(`📊 Slots per epoch: ${slotsPerEpoch}`);
  }

  async runAllTests(): Promise<void> {
    console.log("🚀 Starting ECBridge E2E Tests");
    console.log("================================");

    try {
      // Check system status
      await this.checkSystemStatus();
      
      // Check SP1 Helios
      await this.checkSP1HeliosStatus();
      
      // Test ETH deposit
      await this.testETHDeposit();
      
      console.log("\n✅ All tests passed successfully!");
    } catch (error) {
      console.error("\n❌ Test failed:", error);
      process.exit(1);
    }
  }
}

// Run tests
async function main() {
  const test = new BridgeE2ETest();
  await test.runAllTests();
}

main().catch(console.error);