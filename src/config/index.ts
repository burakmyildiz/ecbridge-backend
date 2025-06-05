// ECBridge/backend/src/config/index.ts
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(__dirname, '../../../.env'),
  override: true
});

interface Config {
  port: number;
  environment: string;
  apiBasePath: string;
  
  mongoUri: string;
  
  ethereumRpc: string;
  ethereumBridgeAddress: string | null;
  ethereumPrivateKey: string | null;
  
  citreaRpc: string;
  citreaBridgeAddress: string | null;
  citreaPrivateKey: string | null;
  
  sp1HeliosPath: string;
  sp1HeliosAddress: string | null;
  sourceChainId: number;
  sourceConsensusRpcUrl: string;
  destChainId: number;
  
  relayerPollingDelayMs: number;
  proofTimeoutMs: number;
  maxRetries: number;
  
  jwtSecret: string;
}

const config: Config = {
  port: parseInt(process.env.PORT || '3001'),
  environment: process.env.NODE_ENV || 'development',
  apiBasePath: process.env.API_BASE_PATH || '/api',
  
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/ethcitrea',
  
  ethereumRpc: process.env.ETH_EXE_RPC_URL || 'http://localhost:8545',
  ethereumBridgeAddress: process.env.ETH_BRIDGE_ADDRESS || null,
  ethereumPrivateKey: process.env.ETH_PRIVATE_KEY || null,
  
  citreaRpc: process.env.CITREA_RPC_URL || 'http://localhost:9545',
  citreaBridgeAddress: process.env.CITREA_BRIDGE_ADDRESS || null,
  citreaPrivateKey: process.env.CITREA_PRIVATE_KEY || null,
  
  sp1HeliosPath: process.env.SP1_HELIOS_PATH || path.resolve(__dirname, '../../../sp1-helios'),
  sp1HeliosAddress: process.env.SP1_HELIOS_ADDRESS || null,
  sourceChainId: parseInt(process.env.SOURCE_CHAIN_ID || '1'),
  sourceConsensusRpcUrl: process.env.SOURCE_CONSENSUS_RPC_URL || '',
  destChainId: parseInt(process.env.DEST_CHAIN_ID || '2442'),
  
  relayerPollingDelayMs: parseInt(process.env.RELAYER_POLLING_DELAY_MS || '5000'),
  proofTimeoutMs: parseInt(process.env.PROOF_TIMEOUT_MS || '300000'), 
  maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
  
  jwtSecret: process.env.JWT_SECRET || 'supersecretkey',
};

const requiredConfigsInProduction = [
  'ethereumBridgeAddress',
  'citreaBridgeAddress',
  'sp1HeliosAddress',
  'sourceConsensusRpcUrl'
];

if (config.environment === 'production') {
  for (const requiredConfig of requiredConfigsInProduction) {
    if (!config[requiredConfig as keyof Config]) {
      throw new Error(`Missing required configuration: ${requiredConfig}`);
    }
  }
}

export default config;
