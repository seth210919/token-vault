use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{VaultState, VAULT_STATE_SEED, VAULT_TOKEN_ACCOUNT_SEED};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_STATE_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump = vault_state.bump,
        constraint = vault_state.owner == user.key(),
        has_one = mint
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [VAULT_TOKEN_ACCOUNT_SEED, vault_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_state,
        token::token_program = token_program
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.vault_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: ctx.accounts.vault_state.to_account_info(),
    };

    let user_key = ctx.accounts.user.key();
    let mint_key = ctx.accounts.mint.key();
    let bump_seed = [ctx.accounts.vault_state.bump];
    let vault_state_seeds: &[&[u8]] = &[
        VAULT_STATE_SEED,
        user_key.as_ref(),
        mint_key.as_ref(),
        &bump_seed,
    ];
    let signer_seeds: &[&[&[u8]]] = &[vault_state_seeds];

    let cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );

    token::transfer_checked(cpi_context, amount, ctx.accounts.mint.decimals)
}
