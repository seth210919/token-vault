import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { expect } from "chai";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TokenVault } from "../target/types/token_vault";

const TOKEN_DECIMALS = 6;
const TOKENS_TO_MINT = 100 * 10 ** TOKEN_DECIMALS;
const TOKENS_TO_DEPOSIT = 30 * 10 ** TOKEN_DECIMALS;
const TOKENS_TO_WITHDRAW = 10 * 10 ** TOKEN_DECIMALS;

describe("token-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.tokenVault as Program<TokenVault>;

  it("initializes a vault, transfers tokens, and rejects invalid withdrawals", async () => {
    const user = provider.wallet.publicKey;
    const payer = (provider.wallet as anchor.Wallet).payer;

    const bob = anchor.web3.Keypair.generate();

    const mint = await createMint(
      provider.connection,
      payer,
      user,
      null,
      TOKEN_DECIMALS
    );

    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      user
    );

    const mintToSignature = await mintTo(
      provider.connection,
      payer,
      mint,
      userTokenAccount.address,
      payer,
      TOKENS_TO_MINT
    );

    const [vaultState, vaultStateBump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), user.toBuffer(), mint.toBuffer()],
        program.programId
      );

    const [vaultTokenAccount, vaultTokenAccountBump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_token"), vaultState.toBuffer()],
        program.programId
      );

    const initializeVaultSignature = await program.methods
      .initializeVault()
      .accountsPartial({
        user,
        mint,
        vaultState,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const storedVaultState = await program.account.vaultState.fetch(vaultState);

    expect(storedVaultState.owner.equals(user)).to.equal(true);
    expect(storedVaultState.mint.equals(mint)).to.equal(true);
    expect(storedVaultState.bump).to.equal(vaultStateBump);

    const depositSignature = await program.methods
      .deposit(new anchor.BN(TOKENS_TO_DEPOSIT))
      .accountsPartial({
        user,
        mint,
        vaultState,
        userTokenAccount: userTokenAccount.address,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userAccountAfterDeposit = await getAccount(
      provider.connection,
      userTokenAccount.address
    );
    const vaultAccountAfterDeposit = await getAccount(
      provider.connection,
      vaultTokenAccount
    );

    expect(Number(userAccountAfterDeposit.amount)).to.equal(
      TOKENS_TO_MINT - TOKENS_TO_DEPOSIT
    );
    expect(Number(vaultAccountAfterDeposit.amount)).to.equal(
      TOKENS_TO_DEPOSIT
    );

    const withdrawSignature = await program.methods
      .withdraw(new anchor.BN(TOKENS_TO_WITHDRAW))
      .accountsPartial({
        user,
        mint,
        vaultState,
        vaultTokenAccount,
        userTokenAccount: userTokenAccount.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userAccountAfterWithdraw = await getAccount(
      provider.connection,
      userTokenAccount.address,
    );
    const vaultAccountAfterWithdraw = await getAccount(
      provider.connection,
      vaultTokenAccount,
    );

    expect(Number(userAccountAfterWithdraw.amount)).to.equal(
      TOKENS_TO_MINT - TOKENS_TO_DEPOSIT + TOKENS_TO_WITHDRAW,
    );
    expect(Number(vaultAccountAfterWithdraw.amount)).to.equal(
      TOKENS_TO_DEPOSIT - TOKENS_TO_WITHDRAW
    );

    let bobWithdrawError: unknown = null;

    try {
      await program.methods
        .withdraw(new anchor.BN(TOKENS_TO_WITHDRAW))
        .accountsPartial({
          user: bob.publicKey,
          mint,
          vaultState,
          vaultTokenAccount,
          userTokenAccount: userTokenAccount.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob])
        .rpc();
    } catch (error) {
      bobWithdrawError = error;
    }

    expect(bobWithdrawError).to.be.instanceOf(anchor.AnchorError);

    const anchorError = bobWithdrawError as anchor.AnchorError;
    expect(anchorError.error.errorCode.code).to.equal("ConstraintSeeds");

    const userAccountAfterBobAttempt = await getAccount(
      provider.connection,
      userTokenAccount.address
    );
    const vaultAccountAfterBobAttempt = await getAccount(
      provider.connection,
      vaultTokenAccount
    );

    expect(userAccountAfterBobAttempt.amount).to.equal(
      userAccountAfterWithdraw.amount
    );
    expect(vaultAccountAfterBobAttempt.amount).to.equal(
      vaultAccountAfterWithdraw.amount
    );

    const otherMint = await createMint(
      provider.connection,
      payer,
      user,
      null,
      TOKEN_DECIMALS
    );

    const userOtherTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      otherMint,
      user
    )

    const bobTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      bob.publicKey
    );

    let wrongMintWithdrawError: unknown = null;

    try {
      await program.methods
        .withdraw(new anchor.BN(TOKENS_TO_WITHDRAW))
        .accountsPartial({
          user,
          mint,
          vaultState,
          vaultTokenAccount,
          userTokenAccount: userOtherTokenAccount.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (error) {
      wrongMintWithdrawError = error;
    }

    expect(wrongMintWithdrawError).to.be.instanceOf(anchor.AnchorError);

    const wrongMintAnchorError = wrongMintWithdrawError as anchor.AnchorError;
    expect(wrongMintAnchorError.error.errorCode.code).to.equal(
      "ConstraintTokenMint"
    );

    const userAccountAfterWrongMintAttempt = await getAccount(
      provider.connection,
      userTokenAccount.address
    );
    const vaultAccountAfterWrongMintAttempt = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const otherTokenAccountAfterWrongMintAttempt = await getAccount(
      provider.connection,
      userOtherTokenAccount.address
    );

    expect(userAccountAfterWrongMintAttempt.amount).to.equal(
      userAccountAfterBobAttempt.amount
    );
    expect(vaultAccountAfterWrongMintAttempt.amount).to.equal(
      vaultAccountAfterBobAttempt.amount
    );
    expect(otherTokenAccountAfterWrongMintAttempt.amount).to.equal(
      userOtherTokenAccount.amount
    );

    let wrongAuthorityWithdrawError: unknown = null;

    try {
      await program.methods
        .withdraw(new anchor.BN(TOKENS_TO_WITHDRAW))
        .accountsPartial({
          user,
          mint,
          vaultState,
          vaultTokenAccount,
          userTokenAccount: bobTokenAccount.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (error) {
      wrongAuthorityWithdrawError = error;
    }

    expect(wrongAuthorityWithdrawError).to.be.instanceOf(anchor.AnchorError);

    const wrongAuthorityAnchorError = wrongAuthorityWithdrawError as anchor.AnchorError;
    expect(wrongAuthorityAnchorError.error.errorCode.code).to.equal(
      "ConstraintTokenOwner"
    );

    const userAccountAfterWrongAuthorityAttempt = await getAccount(
      provider.connection,
      userTokenAccount.address
    );
    const vaultAccountAfterWrongAuthorityAttempt = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const bobTokenAccountAfterWrongAuthorityAttempt = await getAccount(
      provider.connection,
      bobTokenAccount.address
    );

    expect(userAccountAfterWrongAuthorityAttempt.amount).to.equal(
      userAccountAfterWrongMintAttempt.amount
    );
    expect(vaultAccountAfterWrongAuthorityAttempt.amount).to.equal(
      vaultAccountAfterWrongMintAttempt.amount
    );
    expect(bobTokenAccountAfterWrongAuthorityAttempt.amount).to.equal(
      bobTokenAccount.amount
    );

    let wrongVaultTokenAccountError: unknown = null;

    try {
      await program.methods
        .withdraw(new anchor.BN(TOKENS_TO_WITHDRAW))
        .accountsPartial({
          user,
          mint,
          vaultState,
          vaultTokenAccount: bobTokenAccount.address,
          userTokenAccount: userTokenAccount.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (error) {
      wrongVaultTokenAccountError = error;
    }

    expect(wrongVaultTokenAccountError).to.be.instanceOf(anchor.AnchorError);

    const wrongVaultTokenAnchorError =
      wrongVaultTokenAccountError as anchor.AnchorError;
    expect(wrongVaultTokenAnchorError.error.errorCode.code).to.equal(
      "ConstraintSeeds"
    );

    const userAccountAfterWrongVaultAttempt = await getAccount(
      provider.connection,
      userTokenAccount.address
    );
    const vaultAccountAfterWrongVaultAttempt = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const bobTokenAccountAfterWrongVaultAttempt = await getAccount(
      provider.connection,
      bobTokenAccount.address
    );

    expect(userAccountAfterWrongVaultAttempt.amount).to.equal(
      userAccountAfterWrongAuthorityAttempt.amount
    );
    expect(vaultAccountAfterWrongVaultAttempt.amount).to.equal(
      vaultAccountAfterWrongAuthorityAttempt.amount
    );
    expect(bobTokenAccountAfterWrongVaultAttempt.amount).to.equal(
      bobTokenAccountAfterWrongAuthorityAttempt.amount
    );

    const excessiveWithdrawAmount = new anchor.BN(
      vaultAccountAfterWrongVaultAttempt.amount.toString(),
    ).addn(1);
    let excessiveWithdrawError: unknown = null;

    try {
      await program.methods
        .withdraw(excessiveWithdrawAmount)
        .accountsPartial({
          user,
          mint,
          vaultState,
          vaultTokenAccount,
          userTokenAccount: userTokenAccount.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (error) {
      excessiveWithdrawError = error;
    }

    expect(excessiveWithdrawError).to.not.equal(null);

    const excessiveWithdrawLogs =
      (excessiveWithdrawError as { logs?: string[] }).logs ?? [];
    const excessiveWithdrawEvidence = [
      String(excessiveWithdrawError),
      ...excessiveWithdrawLogs,
    ]
      .join("\n")
      .toLowerCase();

    expect(excessiveWithdrawEvidence).to.include("insufficient funds");

    const userAccountAfterExcessiveWithdraw = await getAccount(
      provider.connection,
      userTokenAccount.address
    );
    const vaultAccountAfterExcessiveWithdraw = await getAccount(
      provider.connection,
      vaultTokenAccount
    );

    expect(userAccountAfterExcessiveWithdraw.amount).to.equal(
      userAccountAfterWrongVaultAttempt.amount
    );
    expect(vaultAccountAfterExcessiveWithdraw.amount).to.equal(
      vaultAccountAfterWrongVaultAttempt.amount
    );

    console.log("Test wallet:", user.toBase58());
    console.log("Test mint:", mint.toBase58());
    console.log("User token account:", userTokenAccount.address.toBase58());
    console.log("Mint-to signature:", mintToSignature);
    console.log("Vault state PDA:", vaultState.toBase58());
    console.log("Vault state bump:", vaultStateBump);
    console.log("Vault token account PDA:", vaultTokenAccount.toBase58());
    console.log("Vault token account bump:", vaultTokenAccountBump);
    console.log("Initialize-vault signature:", initializeVaultSignature);
    console.log("Deposit signature:", depositSignature);
    console.log(
      "User balance after deposit:",
      Number(userAccountAfterDeposit.amount)
    );
    console.log(
      "Vault balance after deposit:",
      Number(vaultAccountAfterDeposit.amount)
    );
    console.log("Withdraw signature:", withdrawSignature);
  });
});
