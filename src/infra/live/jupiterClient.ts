import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  platformFeeBps?: number;
}

export interface JupiterQuoteResponse {
  inAmount?: string;
  outAmount?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
}

export interface JupiterSwapResult {
  txSignature?: string;
  quote: JupiterQuoteResponse;
  simulated: boolean;
}

export class JupiterClient {
  private readonly connection?: Connection;
  private readonly signer?: Keypair;

  constructor(
    private readonly quoteUrl: string,
    private readonly swapUrl: string,
    rpcUrl?: string,
    privateKeyB58?: string,
    private readonly broadcastEnabled = false,
  ) {
    if (rpcUrl) {
      this.connection = new Connection(rpcUrl, 'confirmed');
    }

    if (privateKeyB58) {
      this.signer = Keypair.fromSecretKey(bs58.decode(privateKeyB58));
    }
  }

  isReadyForLive(): boolean {
    return Boolean(this.connection && this.signer);
  }

  publicKey(): string | undefined {
    return this.signer?.publicKey.toBase58();
  }

  /**
   * Get the wallet's SPL token balance for a given mint.
   * Used when adopting a manually opened position so Sesame can manage it.
   */
  async getTokenBalance(mintAddress: string): Promise<{ amount: string; decimals: number } | null> {
    if (!this.connection || !this.signer) return null;

    const mint = new PublicKey(mintAddress);
    const accounts = await this.connection.getParsedTokenAccountsByOwner(this.signer.publicKey, {
      mint,
    });

    if (!accounts.value?.length) return null;
    const info = accounts.value[0]?.account?.data?.parsed?.info;
    if (!info?.tokenAmount) return null;

    const amount = info.tokenAmount.amount as string;
    const decimals = Number(info.tokenAmount.decimals ?? 0);
    if (amount === '0') return null;

    return { amount, decimals };
  }

  /**
   * List all SPL token accounts in the wallet with non-zero balance.
   * Used to auto-discover manually opened positions so Sesame can adopt them.
   */
  async getAllTokenBalances(): Promise<Array<{ mintAddress: string; amount: string; decimals: number }>> {
    if (!this.connection || !this.signer) return [];

    // SPL Token program ID — required filter for getParsedTokenAccountsByOwner.
    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const accounts = await this.connection.getParsedTokenAccountsByOwner(this.signer.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    });

    const result: Array<{ mintAddress: string; amount: string; decimals: number }> = [];
    for (const { account } of accounts.value) {
      const info = account?.data?.parsed?.info;
      const mint = info?.mint;
      const tokenAmount = info?.tokenAmount;
      if (!mint || !tokenAmount) continue;
      const amount = tokenAmount.amount as string;
      if (amount === '0') continue;
      result.push({
        mintAddress: mint,
        amount,
        decimals: Number(tokenAmount.decimals ?? 0),
      });
    }
    return result;
  }

  async quote(params: JupiterQuoteRequest): Promise<JupiterQuoteResponse> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(params.amount),
      slippageBps: String(params.slippageBps ?? 50),
      platformFeeBps: String(params.platformFeeBps ?? 0),
    });

    const response = await fetch(`${this.quoteUrl}?${query.toString()}`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter quote failed: ${response.status} ${body}`);
    }

    return (await response.json()) as JupiterQuoteResponse;
  }

  async swapFromQuote(quote: JupiterQuoteResponse, feeAccount?: string): Promise<JupiterSwapResult> {
    if (!this.signer) {
      return { quote, simulated: true };
    }

    const payload = {
      quoteResponse: quote,
      userPublicKey: this.signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      feeAccount,
    };

    const response = await fetch(this.swapUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter swap build failed: ${response.status} ${body}`);
    }

    const body = (await response.json()) as { swapTransaction?: string };
    if (!body.swapTransaction) {
      return { quote, simulated: true };
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
    tx.sign([this.signer]);

    if (!this.broadcastEnabled || !this.connection) {
      return { quote, simulated: true };
    }

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    await this.connection.confirmTransaction(signature, 'confirmed');

    return {
      quote,
      txSignature: signature,
      simulated: false,
    };
  }
}
