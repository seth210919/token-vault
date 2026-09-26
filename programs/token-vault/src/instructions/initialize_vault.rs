use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{VaultState, VAULT_STATE_SEED, VAULT_TOKEN_ACCOUNT_SEED};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = user,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [VAULT_STATE_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init,
        payer = user,
        seeds = [VAULT_TOKEN_ACCOUNT_SEED, vault_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_state,
        token::token_program = token_program
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
    ctx.accounts.vault_state.owner = ctx.accounts.user.key();
    ctx.accounts.vault_state.mint = ctx.accounts.mint.key();
    ctx.accounts.vault_state.bump = ctx.bumps.vault_state;

    Ok(())
}
