const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { makeCastAdd, NobleEd25519Signer, FarcasterNetwork, Message } = require('@farcaster/hub-nodejs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Verified contract addresses on Base (chain 8453)
const CONTRACTS = {
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    AERODROME_ROUTER: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    AERODROME_FACTORY: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    UNISWAP_V4_POOLMANAGER: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  },
  optimism: {
    FARCASTER_ID_GATEWAY: '0x00000000Fc25870C6eD6b6c7E41Fb078b7656f69',
    FARCASTER_ID_REGISTRY: '0x00000000Fc6c5F01Fc30151999387Bb99A9f489b',
    FARCASTER_KEY_GATEWAY: '0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B',
  }
};

// ============ ENDPOINT 1: Get verified contract addresses ============
app.get('/v1/contracts/:chain', (req, res) => {
  const chain = req.params.chain;
  const contracts = CONTRACTS[chain];
  if (!contracts) return res.status(404).json({ error: 'Chain not supported', supported: Object.keys(CONTRACTS) });
  res.json({ chain, contracts });
});

// ============ ENDPOINT 2: Smart contract code checker ============
app.post('/v1/check-contract', async (req, res) => {
  const { address, chain = 'base' } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  
  const rpcs = { base: 'https://mainnet.base.org', optimism: 'https://mainnet.optimism.io' };
  const rpc = rpcs[chain];
  if (!rpc) return res.status(400).json({ error: 'unsupported chain' });
  
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const checksummed = ethers.getAddress(address.toLowerCase());
    const code = await provider.getCode(checksummed);
    const hasCode = code !== '0x';
    
    const result = {
      address: checksummed,
      chain,
      hasCode,
      codeSize: hasCode ? code.length : 0,
      isProxy: false,
      hasEIP3009: false,
    };
    
    if (hasCode) {
      // Check EIP-1967 proxy implementation
      const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
      const impl = await provider.getStorage(checksummed, implSlot);
      if (impl !== '0x' && impl !== ethers.ZeroHash) {
        result.isProxy = true;
        result.implementation = ethers.getAddress('0x' + impl.substring(26));
        const implCode = await provider.getCode(result.implementation);
        result.implementationCodeSize = implCode.length;
        result.hasEIP3009 = implCode.includes('adc4a363');
      } else {
        result.hasEIP3009 = code.includes('adc4a363');
      }
      
      // Try to get token info
      try {
        const abi = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function name() view returns (string)'];
        const c = new ethers.Contract(checksummed, abi, provider);
        result.symbol = await c.symbol();
        result.decimals = await c.decimals();
        result.name = await c.name();
        result.isToken = true;
      } catch {}
    }
    
    res.json(result);
  } catch(e) {
    res.status(400).json({ error: e.message.substring(0, 200) });
  }
});

// ============ ENDPOINT 3: Build swap transaction for Aerodrome ============
app.post('/v1/build-swap', async (req, res) => {
  const { tokenIn, tokenOut, amountIn, slippagePercent = 5, recipient, chain = 'base' } = req.body;
  if (!tokenIn || !tokenOut || !amountIn) return res.status(400).json({ error: 'tokenIn, tokenOut, amountIn required' });
  
  const rpcs = { base: 'https://mainnet.base.org' };
  const rpc = rpcs[chain];
  if (!rpc) return res.status(400).json({ error: 'unsupported chain' });
  
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const AERO_ROUTER = ethers.getAddress(CONTRACTS.base.AERODROME_ROUTER);
    const AERO_FACTORY = CONTRACTS.base.AERODROME_FACTORY;
    
    // Aerodrome router ABI
    const routerAbi = [
      'function swapExactETHForTokens(uint amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint deadline) external payable returns (uint[] memory amounts)',
      'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint deadline) external returns (uint[] memory amounts)',
      'function getAmountsOut(uint amountIn, (address from, address to, bool stable, address factory)[] routes) public view returns (uint[] memory amounts)',
      'function defaultFactory() view returns (address)'
    ];
    
    const router = new ethers.Contract(AERO_ROUTER, routerAbi, provider);
    const inAddr = ethers.getAddress(tokenIn.toLowerCase());
    const outAddr = ethers.getAddress(tokenOut.toLowerCase());
    const amountInWei = ethers.parseEther(amountIn.toString());
    const to = recipient ? ethers.getAddress(recipient.toLowerCase()) : ethers.ZeroAddress;
    
    // Try both volatile and stable routes
    const routes = [
      { from: inAddr, to: outAddr, stable: false, factory: AERO_FACTORY },
      { from: inAddr, to: outAddr, stable: true, factory: AERO_FACTORY }
    ];
    
    let bestAmount = 0n;
    let bestRoute = null;
    
    for (const route of routes) {
      try {
        const amounts = await router.getAmountsOut.staticCall(amountInWei, [route]);
        if (amounts[1] > bestAmount) {
          bestAmount = amounts[1];
          bestRoute = route;
        }
      } catch {}
    }
    
    if (!bestRoute) return res.status(400).json({ error: 'No liquidity pool found for this pair' });
    
    const minOut = bestAmount * BigInt(100 - slippagePercent) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 1200;
    
    // Build the transaction data
    const isETHIn = tokenIn.toLowerCase() === CONTRACTS.base.WETH.toLowerCase();
    let txData;
    
    if (isETHIn) {
      txData = await router.swapExactETHForTokens.populateTransaction(minOut, [bestRoute], to, deadline);
      txData.value = amountInWei;
    } else {
      txData = await router.swapExactTokensForTokens.populateTransaction(amountInWei, minOut, [bestRoute], to, deadline);
    }
    
    res.json({
      router: AERO_ROUTER,
      to: txData.to,
      data: txData.data,
      value: txData.value ? txData.value.toString() : '0',
      expectedOut: bestAmount.toString(),
      minOut: minOut.toString(),
      route: bestRoute,
      deadline,
      tokenIn: inAddr,
      tokenOut: outAddr,
    });
  } catch(e) {
    res.status(400).json({ error: e.message.substring(0, 300) });
  }
});

// ============ ENDPOINT 4: Post a Farcaster cast ============
app.post('/v1/farcaster/cast', async (req, res) => {
  const { fid, signerPrivateKey, text, neynarApiKey } = req.body;
  if (!fid || !signerPrivateKey || !text || !neynarApiKey) {
    return res.status(400).json({ error: 'fid, signerPrivateKey, text, neynarApiKey required' });
  }
  
  try {
    const signer = new NobleEd25519Signer(Buffer.from(signerPrivateKey, 'hex'));
    const castResult = await makeCastAdd(
      {
        text,
        embeds: [],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: []
      },
      { fid: parseInt(fid), network: FarcasterNetwork.MAINNET },
      signer
    );
    
    if (castResult.isErr()) {
      return res.status(400).json({ error: 'Cast creation failed: ' + castResult.error });
    }
    
    const cast = castResult.value;
    const hash = '0x' + Buffer.from(cast.hash).toString('hex');
    const messageBytes = Buffer.from(Message.encode(cast).finish());
    
    // Submit to Neynar hub
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'hub-api.neynar.com',
        path: '/v1/submitMessage',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': messageBytes.length,
          'x-api-key': neynarApiKey
        }
      }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve({ status: resp.statusCode, data }));
      });
      req.on('error', reject);
      req.write(messageBytes);
      req.end();
    });
    
    if (result.status === 200) {
      res.json({ success: true, hash, fid: parseInt(fid) });
    } else {
      res.status(400).json({ error: 'Hub rejected: ' + result.data.substring(0, 200) });
    }
  } catch(e) {
    res.status(500).json({ error: e.message.substring(0, 200) });
  }
});

// ============ ENDPOINT 5: Get token info ============
app.post('/v1/token-info', async (req, res) => {
  const { address, chain = 'base' } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  
  const rpcs = { base: 'https://mainnet.base.org', optimism: 'https://mainnet.optimism.io' };
  const rpc = rpcs[chain];
  if (!rpc) return res.status(400).json({ error: 'unsupported chain' });
  
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const checksummed = ethers.getAddress(address.toLowerCase());
    const abi = [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)'
    ];
    
    const c = new ethers.Contract(checksummed, abi, provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      c.name().catch(() => null),
      c.symbol().catch(() => null),
      c.decimals().catch(() => null),
      c.totalSupply().catch(() => null)
    ]);
    
    res.json({
      address: checksummed,
      chain,
      name,
      symbol,
      decimals: decimals ? Number(decimals) : null,
      totalSupply: totalSupply ? ethers.formatUnits(totalSupply, decimals || 18) : null,
    });
  } catch(e) {
    res.status(400).json({ error: e.message.substring(0, 200) });
  }
});

// ============ ENDPOINT 6: Pre-flight Transaction Simulation ============
// The #1 pain point for agents on Base: failed transactions waste gas.
// This endpoint simulates a tx before submission and returns go/no-go.
app.post('/v1/simulate', async (req, res) => {
  const { from, to, data, value = '0', chainId = 8453 } = req.body;
  if (!from || !to || !data) return res.status(400).json({ error: 'from, to, data required' });
  
  const rpcs = { 8453: 'https://mainnet.base.org', 10: 'https://mainnet.optimism.io' };
  const rpc = rpcs[chainId];
  if (!rpc) return res.status(400).json({ error: 'unsupported chainId' });
  
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const fromAddr = ethers.getAddress(from.toLowerCase());
    const toAddr = ethers.getAddress(to.toLowerCase());
    const valueWei = BigInt(value);
    
    const tx = { from: fromAddr, to: toAddr, data, value: valueWei };
    const reasons = [];
    let verdict = 'GO';
    
    // Step 1: Simulate the call (will it revert?)
    let revertReason = null;
    try {
      await provider.call(tx);
    } catch(e) {
      verdict = 'BLOCK';
      revertReason = e.shortMessage || e.message.substring(0, 200);
      reasons.push(`Transaction would revert: ${revertReason}`);
    }
    
    // Step 2: Estimate gas
    let estimatedGas = null;
    try {
      const gasEstimate = await provider.estimateGas(tx);
      estimatedGas = Number(gasEstimate);
      const buffered = Math.floor(estimatedGas * 1.2);
      if (buffered > 16777215) {
        verdict = 'BLOCK';
        reasons.push(`Estimated gas (${buffered}) exceeds block gas limit (16,777,215)`);
      } else if (verdict !== 'BLOCK') {
        // Check if account has enough balance for gas
        const balance = await provider.getBalance(fromAddr);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || 0n;
        const totalGasCost = BigInt(buffered) * gasPrice;
        if (balance < totalGasCost + valueWei) {
          verdict = 'BLOCK';
          reasons.push(`Insufficient balance. Need ${ethers.formatEther(totalGasCost + valueWei)} ETH, have ${ethers.formatEther(balance)} ETH`);
        }
      }
    } catch(e) {
      if (verdict !== 'BLOCK') {
        verdict = 'CAUTION';
        reasons.push(`Gas estimation failed: ${e.shortMessage || e.message.substring(0, 100)}`);
      }
    }
    
    // Step 3: Check nonce
    let currentNonce = null;
    try {
      currentNonce = await provider.getTransactionCount(fromAddr, 'pending');
    } catch {}
    
    // Step 4: Check fee data
    const feeData = await provider.getFeeData();
    const baseFee = feeData.gasPrice;
    
    res.json({
      verdict,
      revertReason,
      estimatedGas: estimatedGas ? Math.floor(estimatedGas * 1.2) : null,
      currentNonce,
      baseFeeGwei: baseFee ? ethers.formatUnits(baseFee, 'gwei') : null,
      reasons: reasons.length ? reasons : ['All checks passed'],
      chainId,
      timestamp: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message.substring(0, 300) });
  }
});

// ============ HEALTH ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'frank-base-toolkit', version: '1.0.0', endpoints: ['/v1/contracts/:chain', '/v1/check-contract', '/v1/build-swap', '/v1/farcaster/cast', '/v1/token-info'] });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Frank Base Toolkit',
    description: 'Tools for AI agents building on Base chain',
    endpoints: [
      { method: 'GET', path: '/v1/contracts/:chain', desc: 'Get verified contract addresses' },
      { method: 'POST', path: '/v1/check-contract', desc: 'Check if a contract exists and what it is', body: '{ address, chain }' },
      { method: 'POST', path: '/v1/build-swap', desc: 'Build an Aerodrome swap transaction', body: '{ tokenIn, tokenOut, amountIn, recipient }' },
      { method: 'POST', path: '/v1/farcaster/cast', desc: 'Post a Farcaster cast via Neynar', body: '{ fid, signerPrivateKey, text, neynarApiKey }' },
      { method: 'POST', path: '/v1/token-info', desc: 'Get ERC20 token info', body: '{ address, chain }' },
    ],
    payment: 'Coming soon via x402',
    by: 'Frank - autonomous AI agent on Base',
  });
});

app.listen(PORT, () => {
  console.log(`Frank Base Toolkit running on port ${PORT}`);
});