// ECBridge/backend/src/utils/connectors.ts
import { ethers } from 'ethers';
import { Chain } from '../models';
import config from '../config';
import logger from './logger';

// ABI for the SP1Helios contract
const SP1_HELIOS_ABI = [
  "function head() view returns (uint256)",
  "function headers(uint256 slot) view returns (bytes32)",
  "function executionStateRoots(uint256 slot) view returns (bytes32)",
  "function syncCommittees(uint256 period) view returns (bytes32)",
  "function getSyncCommitteePeriod(uint256 slot) view returns (uint256)",
  "function GENESIS_VALIDATORS_ROOT() view returns (bytes32)",
  "function GENESIS_TIME() view returns (uint256)",
  "function SECONDS_PER_SLOT() view returns (uint256)",
  "function SLOTS_PER_PERIOD() view returns (uint256)",
  "function SLOTS_PER_EPOCH() view returns (uint256)",
  "function SOURCE_CHAIN_ID() view returns (uint256)",
  "function update(bytes calldata proof, bytes calldata publicValues) external",
  "event HeadUpdate(uint256 indexed slot, bytes32 indexed root)",
  "event SyncCommitteeUpdate(uint256 indexed period, bytes32 indexed root)"
];

// ABI for the BridgeEth contract - Updated to match actual contract
const ETHEREUM_BRIDGE_ABI = [
  "event DepositETH(address indexed from, address indexed to, uint256 amount, uint256 nonce)",
  "event DepositERC20(address indexed token, address indexed from, address indexed to, uint256 amount, uint256 nonce)",
  "function depositETH(address to) external payable returns (uint256 nonce)",
  "function depositERC20(address token, uint256 amount, address to) external returns (uint256 nonce)",
  "function currentNonce() external view returns (uint256)",
  "function deposits(uint256 nonce) external view returns (bytes32)"
];

// ABI for the BridgeCitrea contract - Updated to match actual contract
const CITREA_BRIDGE_ABI = [
  "event Finalised(address indexed token, address indexed to, uint256 amount, uint256 nonce)",
  "function finaliseDeposit(tuple(address from, address to, address token, uint256 amount, uint256 nonce) d, uint256 ethHeaderSlot, bytes calldata accountProof, bytes calldata storageProof) external",
  "function isProcessed(uint256 nonce) external view returns (bool)",
  "function canonicalToWrapped(address canonical) external view returns (address)",
  "function registerToken(address ethToken, address wrappedToken) external",
  "function getLightClient() external view returns (address)",
  "function lightClient() external view returns (address)",
  "function minSlotFinality() external view returns (uint256)",
  "function mptVerifier() external view returns (address)"
];

export abstract class BlockchainConnector {
  public readonly chain: Chain;
  public readonly rpcUrl: string;
  public readonly bridgeAddress: string | null;
  public readonly bridgeAbi: string[];
  
  protected provider: ethers.Provider | null = null;
  protected signer: ethers.Signer | null = null;
  protected contract: ethers.Contract | null = null;
  
  constructor(chain: Chain, rpcUrl: string, bridgeAddress: string | null, bridgeAbi: string[]) {
    this.chain = chain;
    this.rpcUrl = rpcUrl;
    this.bridgeAddress = bridgeAddress;
    this.bridgeAbi = bridgeAbi;
  }
  
  public async connect(): Promise<void> {
    try {
      logger.info(`Connecting to ${this.chain} at ${this.rpcUrl}`);
      
      this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
      
      if (this.bridgeAddress) {
        this.contract = new ethers.Contract(
          this.bridgeAddress,
          this.bridgeAbi,
          this.provider
        );
        logger.info(`Connected to ${this.chain} bridge at ${this.bridgeAddress}`);
      } else {
        logger.warn(`No bridge address provided for ${this.chain}`);
      }
    } catch (error) {
      logger.error(`Error connecting to ${this.chain}: ${error}`);
      throw error;
    }
  }
  
  public setupSigner(privateKey: string): void {
    if (!this.provider) {
      throw new Error(`Provider not initialized for ${this.chain}`);
    }
    
    this.signer = new ethers.Wallet(privateKey, this.provider);
    
    if (this.contract && this.signer) {
      this.contract = this.contract.connect(this.signer) as unknown as ethers.Contract;
      logger.info(`Signer connected to ${this.chain} bridge`);
    }
  }
  
  public async getLatestBlockNumber(): Promise<number> {
    if (!this.provider) {
      throw new Error(`Provider not initialized for ${this.chain}`);
    }
    
    return await this.provider.getBlockNumber();
  }
  
  public async getBlock(blockNumber: number): Promise<ethers.Block | null> {
    if (!this.provider) {
      throw new Error(`Provider not initialized for ${this.chain}`);
    }
    
    return await this.provider.getBlock(blockNumber);
  }

  public async getTransaction(txHash: string): Promise<ethers.TransactionResponse | null> {
    if (!this.provider) {
      throw new Error(`Provider not initialized for ${this.chain}`);
    }
    
    return await this.provider.getTransaction(txHash);
  }

  public async getTransactionReceipt(txHash: string): Promise<ethers.TransactionReceipt | null> {
    if (!this.provider) {
      throw new Error(`Provider not initialized for ${this.chain}`);
    }
    
    return await this.provider.getTransactionReceipt(txHash);
  }

  public isConnected(): boolean {
    return this.provider !== null;
  }

  public hasSigner(): boolean {
    return this.signer !== null;
  }

  public getContract(): ethers.Contract | null {
    return this.contract;
  }

  public getProvider(): ethers.Provider | null {
    return this.provider;
  }
}

export class EthereumConnector extends BlockchainConnector {
  constructor() {
    super(
      Chain.ETHEREUM,
      config.ethereumRpc,
      config.ethereumBridgeAddress,
      ETHEREUM_BRIDGE_ABI
    );
  }

  public setupSignerFromConfig(): void {
    if (!config.ethereumPrivateKey) {
      throw new Error('Ethereum private key not provided in config');
    }
    
    this.setupSigner(config.ethereumPrivateKey);
  }

  public async getTokenDetails(tokenAddress: string): Promise<{ symbol: string, name: string, decimals: number }> {
    if (!this.provider) {
      throw new Error('Provider not initialized for Ethereum');
    }
    
    if (tokenAddress === '0x0000000000000000000000000000000000000000') {
      return {
        symbol: 'ETH',
        name: 'Ethereum',
        decimals: 18
      };
    }
    
    const tokenAbi = [
      "function symbol() view returns (string)",
      "function name() view returns (string)",
      "function decimals() view returns (uint8)"
    ];
    
    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, this.provider);
    
    try {
      const [symbol, name, decimals] = await Promise.all([
        tokenContract.symbol(),
        tokenContract.name(),
        tokenContract.decimals()
      ]);
      
      return { symbol, name, decimals };
    } catch (error) {
      logger.error(`Error fetching token details: ${error}`);
      throw error;
    }
  }
}

export class CitreaConnector extends BlockchainConnector {
  private sp1HeliosContract: ethers.Contract | null = null;

  constructor() {
    super(
      Chain.CITREA,
      config.citreaRpc,
      config.citreaBridgeAddress,
      CITREA_BRIDGE_ABI
    );
  }

  public async connect(): Promise<void> {
    await super.connect();
    
    if (config.sp1HeliosAddress && this.provider) {
      this.sp1HeliosContract = new ethers.Contract(
        config.sp1HeliosAddress,
        SP1_HELIOS_ABI,
        this.provider
      );
      logger.info(`Connected to SP1Helios at ${config.sp1HeliosAddress}`);
    } else {
      logger.warn('SP1Helios address not provided in config');
    }
  }

  public setupSignerFromConfig(): void {
    if (!config.citreaPrivateKey) {
      throw new Error('Citrea private key not provided in config');
    }
    
    this.setupSigner(config.citreaPrivateKey);
    
    if (this.sp1HeliosContract && this.signer) {
      this.sp1HeliosContract = this.sp1HeliosContract.connect(this.signer) as unknown as ethers.Contract;
    }
  }

  public getSP1HeliosContract(): ethers.Contract | null {
    return this.sp1HeliosContract;
  }

  public async updateSP1Helios(proof: string, publicValues: string): Promise<ethers.TransactionResponse> {
    if (!this.sp1HeliosContract || !this.signer) {
      throw new Error('SP1Helios contract or signer not initialized for Citrea');
    }
    
    logger.info('Submitting update to SP1Helios');
    
    const tx = await this.sp1HeliosContract.update(proof, publicValues);
    
    logger.info(`SP1Helios update submitted, tx: ${tx.hash}`);
    
    return tx;
  }

  public async submitProof(
    proof: string,
    ethToken: string,
    amount: string,
    recipient: string,
    txHash: string
  ): Promise<ethers.TransactionResponse> {
    if (!this.contract || !this.signer) {
      throw new Error('Bridge contract or signer not initialized for Citrea');
    }
    
    const ethTokenBytes32 = ethers.zeroPadValue(ethToken, 32);
    const txHashBytes32 = ethers.zeroPadValue(txHash, 32);
    
    logger.info(`Submitting proof to Citrea bridge for tx: ${txHash}`);
    
    const tx = await this.contract.processBridgeRequest(
      proof,
      ethTokenBytes32,
      amount,
      recipient,
      txHashBytes32
    );
    
    logger.info(`Proof submitted to Citrea bridge, tx: ${tx.hash}`);
    
    return tx;
  }

  public async getSP1HeliosHead(): Promise<{ slot: number, headerRoot: string, executionStateRoot: string }> {
    if (!this.sp1HeliosContract) {
      throw new Error('SP1Helios contract not initialized for Citrea');
    }
    
    const slot = await this.sp1HeliosContract.head();
    const headerRoot = await this.sp1HeliosContract.headers(slot);
    const executionStateRoot = await this.sp1HeliosContract.executionStateRoots(slot);
    
    return {
      slot: Number(slot),
      headerRoot,
      executionStateRoot
    };
  }
}