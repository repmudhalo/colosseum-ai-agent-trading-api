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
      const decoded = bs58.decode(privateKeyB58);
      // Support both 64-byte keypair (secret+public) and 32-byte seed (secret only).
      this.signer = decoded.length === 32
        ? Keypair.fromSeed(decoded)
        : Keypair.fromSecretKey(decoded);
    }
  }

  isReadyForLive(): boolean {
    return Boolean(this.connection && this.signer);
  }

  publicKey(): string | undefined {
    return this.signer?.publicKey.toBase58();
  }

  /** Native SOL balance in SOL (not lamports). Returns null if wallet is not configured. */
  async getSolBalance(): Promise<number | null> {
    if (!this.connection || !this.signer) return null;
    const lamports = await this.connection.getBalance(this.signer.publicKey);
    return lamports / 1e9;
  }

  /**
   * Get the wallet's SPL token balance for a given mint.
   * Checks both Token and Token-2022 programs so meme coins are found.
   */
  async getTokenBalance(mintAddress: string): Promise<{ amount: string; decimals: number } | null> {
    const all = await this.getAllTokenBalances();
    const found = all.find((b) => b.mintAddress === mintAddress);
    return found ? { amount: found.amount, decimals: found.decimals } : null;
  }

  /**
   * List all SPL token accounts in the wallet with non-zero balance.
   * Queries both the legacy Token program and Token-2022 so meme coins
   * created with Token-2022 are included (otherwise reconcile would mark them closed).
   */
  async getAllTokenBalances(): Promise<Array<{ mintAddress: string; amount: string; decimals: number }>> {
    if (!this.connection || !this.signer) return [];

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    const [legacyAccounts, token2022Accounts] = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(this.signer.publicKey, { programId: TOKEN_PROGRAM_ID }),
      this.connection.getParsedTokenAccountsByOwner(this.signer.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    const byMint = new Map<string, { amount: string; decimals: number }>();

    for (const { account } of legacyAccounts.value) {
      const info = account?.data?.parsed?.info;
      const mint = info?.mint;
      const tokenAmount = info?.tokenAmount;
      if (!mint || !tokenAmount) continue;
      const amount = tokenAmount.amount as string;
      if (amount === '0') continue;
      byMint.set(mint, { amount, decimals: Number(tokenAmount.decimals ?? 0) });
    }
    for (const { account } of token2022Accounts.value) {
      const info = account?.data?.parsed?.info;
      const mint = info?.mint;
      const tokenAmount = info?.tokenAmount;
      if (!mint || !tokenAmount) continue;
      const amount = tokenAmount.amount as string;
      if (amount === '0') continue;
      byMint.set(mint, { amount, decimals: Number(tokenAmount.decimals ?? 0) });
    }

    return Array.from(byMint.entries()).map(([mintAddress, { amount, decimals }]) => ({
      mintAddress,
      amount,
      decimals,
    }));
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
