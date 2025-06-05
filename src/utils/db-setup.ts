// ECBridge/backend/utils/db-setup.ts
import mongoose from 'mongoose';
import { TokenModel, Chain } from '../models';
import logger from './logger';
import config from '../config';

export const initializeDatabase = async (): Promise<void> => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(config.mongoUri);
      logger.info(`Connected to MongoDB at ${config.mongoUri}`);
    }
    
    await setupDefaultTokens();
    
    logger.info('Database initialization completed');
  } catch (error) {
    logger.error(`Database initialization error: ${error}`);
    throw error;
  }
};

const setupDefaultTokens = async (): Promise<void> => {
  try {
    const count = await TokenModel.countDocuments();
    
    if (count > 0) {
      logger.info('Tokens already exist in database, skipping default setup');
      return;
    }
    
    logger.info('Setting up default tokens');
    
    const ethereumTokens = [
      {
        symbol: 'ETH',
        name: 'Ethereum',
        address: '0x0000000000000000000000000000000000000000',
        chain: Chain.ETHEREUM,
        decimals: 18,
        isWhitelisted: true
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        chain: Chain.ETHEREUM,
        decimals: 6,
        isWhitelisted: true
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        chain: Chain.ETHEREUM,
        decimals: 6,
        isWhitelisted: true
      },
      {
        symbol: 'DAI',
        name: 'Dai Stablecoin',
        address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
        chain: Chain.ETHEREUM,
        decimals: 18,
        isWhitelisted: true
      }
    ];
    
    const citreaTokens = [
      {
        symbol: 'ETH',
        name: 'Ethereum',
        address: '0xCitreaWrappedEthAddress', 
        chain: Chain.CITREA,
        decimals: 18,
        isWhitelisted: true
      },
      {
        symbol: 'USDC',
        name: 'USD Coin',
        address: '0xCitreaWrappedUsdcAddress', 
        chain: Chain.CITREA,
        decimals: 6,
        isWhitelisted: true
      },
      {
        symbol: 'USDT',
        name: 'Tether USD',
        address: '0xCitreaWrappedUsdtAddress', 
        chain: Chain.CITREA,
        decimals: 6,
        isWhitelisted: true
      },
      {
        symbol: 'DAI',
        name: 'Dai Stablecoin',
        address: '0xCitreaWrappedDaiAddress', 
        chain: Chain.CITREA,
        decimals: 18,
        isWhitelisted: true
      }
    ];
    
    await TokenModel.insertMany([...ethereumTokens, ...citreaTokens]);
    
    logger.info(`Inserted ${ethereumTokens.length} Ethereum tokens and ${citreaTokens.length} Citrea tokens`);
  } catch (error) {
    logger.error(`Error setting up default tokens: ${error}`);
    throw error;
  }
};

if (require.main === module) {
  initializeDatabase()
    .then(() => {
      logger.info('Database initialized successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error(`Error initializing database: ${error}`);
      process.exit(1);
    });
}
