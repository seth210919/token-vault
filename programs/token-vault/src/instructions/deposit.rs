use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{VaultState, VAULT_STATE_SEED, VAULT_TOKEN_ACCOUNT_SEED};

#[derive(Accounts)]
pub struct Deposit<'info> {
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
        token::mint = mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_TOKEN_ACCOUNT_SEED, vault_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_state,
        token::token_program = token_program
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.user_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };

    let cpi_context = CpiContext::new(
        ctx.accounts.token_program.key(),
        cpi_accounts,
    );

    token::transfer_checked(cpi_context, amount, ctx.accounts.mint.decimals)
}
